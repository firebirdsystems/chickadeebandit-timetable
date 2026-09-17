// Build from a synced calendar (plan §5.3): rows from the hub's family.calendar.member:<id> context key →
// household-local observations, the same shape parseIcs returns, so inference and review are shared.
import { addDays, dayNumber } from './logic.js';
import { eventText, resolveZone, zoneParts } from './ics.js';

// The hub stores synced events up to 56 days ahead and returns at most 500 per member, soonest first.
export const SYNC_LIMITS = { horizonDays: 56, rows: 500 };

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// iCal and Apple all-day dates are stored as UTC midnight (the hub runs in UTC); Google keeps a bare date.
const UTC_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z$/;

/** Rows are grouped by connection and calendar name: one Google connection holds several calendars. */
export const sourceKey = row => `${row.connectionId ?? ''}|${row.calendarName ?? ''}`;

/** The provider a row came from, read from its hub id prefix (`google:`, `apple:`, `ical:`). */
export const providerOf = row => String(row.id ?? '').match(/^(google|apple|ical):/)?.[1] ?? null;

function localDate(value, zone, allDay = false) {
  if (BARE_DATE.test(value)) return value;
  const midnight = allDay && String(value).match(UTC_MIDNIGHT);
  if (midnight) return midnight[1];
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : zoneParts(ms, zone).date;
}

/**
 * The last household day the hub's 500-row cut cannot have reached, or null when there are no rows.
 *
 * The hub orders rows by `start_at` as TEXT and stops at 500, so a row it left out sorts at or after the last value
 * it returned. That text mixes three forms: UTC instants, Google's local times with their own offset, and Google's
 * bare all-day dates. Converting the last row to a household date and stepping back a day is not enough: a bare
 * "2026-10-06" sorts after "2026-10-06T01:00:00Z", which is still October 5 in Los Angeles, and a "+14:00" local
 * time sorts later than the instant it names.
 *
 * So bound the omitted rows conservatively. A left-out timed row's text is at or after the last text's wall time,
 * and the earliest instant such text can name is that wall time read at the most advanced offset in use, UTC+14.
 * The day holding that instant may be partial, so the window ends the day before. That also covers a left-out
 * all-day row, which names a date on or after the last text's date: read in any household zone (UTC-12 to +14),
 * the instant is at most 14 hours after its UTC reading, so its day is never later than that date.
 */
function lastCompleteDay(rows, zone) {
  // The largest text, not the last row: nothing here relies on the order rows arrive in. SQLite's default text
  // order is by code unit, as JavaScript's string comparison is.
  const last = rows.map(row => String(row.startAt ?? '')).filter(Boolean).reduce((a, b) => (b > a ? b : a), '');
  if (!last) return null;
  const wall = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(last) ? last.slice(0, 16) : `${last.slice(0, 10)}T00:00`;
  const earliestOmitted = Date.parse(`${wall}:00Z`) - 14 * 3_600_000;
  if (Number.isNaN(earliestOmitted)) return null;
  return addDays(zoneParts(earliestOmitted, zone).date, -1);
}

/**
 * The calendars in a member's synced rows, most events first: { key, name, provider, count, first, last, samples }.
 * Dates are household-local; samples are up to three distinct timed-event titles, to tell unnamed feeds apart.
 */
export function calendarSources(rows, { timezone } = {}) {
  const zone = (timezone && resolveZone(timezone)) || 'UTC';
  const sources = new Map();
  for (const row of rows ?? []) {
    const key = sourceKey(row);
    let s = sources.get(key);
    if (!s) sources.set(key, s = { key, name: row.calendarName || '', provider: providerOf(row), count: 0, first: null, last: null, samples: [] });
    s.count++;
    const date = localDate(row.startAt, zone, row.allDay);
    if (date && (!s.first || date < s.first)) s.first = date;
    if (date && (!s.last || date > s.last)) s.last = date;
    const title = String(row.title ?? '').trim();
    if (!row.allDay && title && s.samples.length < 3 && !s.samples.includes(title)) s.samples.push(title);
  }
  return [...sources.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/**
 * One calendar's synced rows → { observations, warnings, errors }.
 *
 * The hub stores and returns events starting between now and now + 56 days, comparing start values as strings, so
 * both end days are partial: today (lessons already started) and the last day (cut at the current time of day).
 * Google values carry their own offset and are compared by their local text against a UTC time, so the UTC date
 * counts too: west of UTC in the evening, tomorrow's early lessons are still "before now". The window is the whole
 * days neither cut can reach. At the 500-row cap the last date read is partial too and the window ends before it.
 */
export function parseSyncedCalendar(rows, { timezone, source, today, now = `${today}T12:00:00.000Z` }) {
  const fail = message => ({ observations: [], warnings: [], errors: [message] });
  const zone = timezone ? resolveZone(timezone) : null;
  if (!zone) {
    return fail(timezone
      ? `The household time zone "${timezone}" is not recognised, so the calendar's times cannot be placed. Fix it in household settings and try again.`
      : 'The household has no time zone set, so the calendar\'s times cannot be placed. Set it in household settings and try again.');
  }
  const all = rows ?? [];
  const chosen = all.filter(row => sourceKey(row) === source);
  if (!chosen.length) return fail('No events from this calendar yet. Sync it in Calendar, then try again.');

  const utcToday = new Date(now).toISOString().slice(0, 10);
  const from = addDays(today > utcToday ? today : utcToday, 1);
  let to = addDays(today < utcToday ? today : utcToday, SYNC_LIMITS.horizonDays - 1);
  const truncated = all.length >= SYNC_LIMITS.rows;
  if (truncated) {
    const cut = lastCompleteDay(all, zone);
    if (cut && cut < to) to = cut;
  }
  if (to < from) return fail('This student\'s synced calendars have too many events tomorrow to read. Import the school\'s calendar file (.ics) instead.');

  const fromDay = dayNumber(from), toDay = dayNumber(to);
  const counts = { invalid: 0, noLength: 0, crossesMidnight: 0 };
  const observations = [];
  for (const row of chosen) {
    // The hub id is `ical:<uid>:<start>`; a UID may itself contain colons, and only its text is matched.
    const uid = providerOf(row) === 'ical' ? String(row.id).slice('ical:'.length) : '';
    // The hub titles an untitled iCal or Apple event "(No title)"; like a calendar file, it has no subject.
    const title = row.title === '(No title)' && providerOf(row) !== 'google' ? '' : row.title ?? '';
    const { subject, notes, room, teacher } = eventText({ summary: title, description: row.description ?? '', location: row.location ?? '', uid });
    if (row.allDay) {
      const start = localDate(row.startAt, zone, true), end = localDate(row.endAt ?? row.startAt, zone, true);
      if (!start || !end) { counts.invalid++; continue; }
      // The end date is exclusive; an event ending on the day it starts covers that day.
      const days = Math.max(1, dayNumber(end) - dayNumber(start));
      const first = dayNumber(start), last = first + days - 1;
      if (last < fromDay || first > toDay) continue;
      const clipped = Math.max(first, fromDay);
      observations.push({ all_day: true, date: addDays(start, clipped - first), end_date: addDays(start, Math.min(last, toDay) - first), start_time: '', end_time: '', subject, room, teacher, notes });
      continue;
    }
    const startMs = Date.parse(row.startAt), endMs = Date.parse(row.endAt);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) { counts.invalid++; continue; }
    if (endMs === startMs) { counts.noLength++; continue; }
    if (endMs < startMs) { counts.invalid++; continue; }
    const a = zoneParts(startMs, zone), b = zoneParts(endMs, zone);
    const day = dayNumber(a.date);
    if (day < fromDay || day > toDay) continue;
    if (a.date !== b.date && !(b.time === '00:00:00' && dayNumber(b.date) === day + 1)) { counts.crossesMidnight++; continue; }
    const end_time = b.date !== a.date ? '23:59' : b.time.slice(0, 5);
    if (end_time <= a.time.slice(0, 5)) { counts.invalid++; continue; }
    observations.push({ all_day: false, date: a.date, end_date: a.date, start_time: a.time.slice(0, 5), end_time, subject, room, teacher, notes });
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const warnings = [`A synced calendar shows only the next ${SYNC_LIMITS.horizonDays / 7} weeks (${from} to ${to}), so holidays and changes after that are not seen. To cover the whole term, import the school's calendar file (.ics) instead.`];
  // A calendar that has not synced for a while stops short of the horizon (its last day is then partial too, which the
  // app cannot see: the hub holds events up to the last sync + 56 days, not now + 56).
  const lastLesson = observations.filter(o => !o.all_day).map(o => o.date).sort().at(-1);
  if (lastLesson && dayNumber(to) - dayNumber(lastLesson) > 14) warnings.push(`The calendar has no lessons after ${lastLesson}. That may be a holiday or as far ahead as the school publishes; if the calendar has not synced lately, sync it in Calendar and check again.`);
  if (truncated) warnings.push(`This student's synced calendars have more than ${SYNC_LIMITS.rows} events in that time, so only events up to ${to} were read.`);
  if (counts.noLength) warnings.push(`${plural(counts.noLength, 'event starts and ends', 'events start and end')} at the same time (such as a deadline) and ${counts.noLength === 1 ? 'was' : 'were'} skipped.`);
  if (counts.crossesMidnight) warnings.push(`${plural(counts.crossesMidnight, 'event runs', 'events run')} past midnight and ${counts.crossesMidnight === 1 ? 'was' : 'were'} skipped.`);
  if (counts.invalid) warnings.push(`${plural(counts.invalid, 'event has', 'events have')} unreadable dates and ${counts.invalid === 1 ? 'was' : 'were'} skipped.`);
  observations.sort((x, y) => x.date.localeCompare(y.date) || x.start_time.localeCompare(y.start_time));
  return { observations, warnings, errors: [] };
}
