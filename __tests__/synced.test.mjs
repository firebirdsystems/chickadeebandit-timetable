// Build from a synced calendar (plan §5.3). Rows are shaped as the hub's family.calendar.member:<id> key returns
// them: iCal and Apple times as UTC ISO strings (all-day dates at UTC midnight), Google times with their own
// offset and all-day events as bare dates, end dates exclusive.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseIcs, zoneParts } from '../src/ics.js';
import { candidateForFit, inferTimetable } from '../src/infer.js';
import { addDays } from '../src/logic.js';
import { SYNC_LIMITS, calendarSources, parseSyncedCalendar, providerOf, sourceKey } from '../src/synced.js';

const row = (over = {}) => ({ id: 'ical:u1:20261005T083000Z', connectionId: 'conn-1', familyMemberId: 'kid', title: 'Maths', startAt: '2026-10-05T07:30:00.000Z',
  endAt: '2026-10-05T08:30:00.000Z', allDay: false, location: 'S12', description: null, calendarName: null, updatedAt: '2026-09-01T00:00:00.000Z', ...over });
const SOURCE = 'conn-1|';
const parse = (rows, over = {}) => parseSyncedCalendar(rows, { timezone: 'Europe/London', source: SOURCE, today: '2026-10-01', ...over });

// Rows in fixtures/synced/ were produced by the hub's own iCal sync (icalProvider.fetchEvents on ical.js, with the
// household zone) from the calendar files beside them, then filtered and ordered as the family.calendar.member read does.
// Regenerate them with a throwaway hub test that mocks fetchSafe to return the file.
function compare(fixture, zone) {
  const { now, rows } = JSON.parse(readFileSync(new URL(`./fixtures/synced/${fixture}.json`, import.meta.url), 'utf8'));
  const today = zoneParts(Date.parse(now), zone).date;
  const synced = parseSyncedCalendar(rows, { timezone: zone, source: 'feed|', today, now });
  const from = addDays(today, 1), to = addDays(today, SYNC_LIMITS.horizonDays - 1);
  const file = parseIcs(readFileSync(new URL(`./fixtures/${fixture}.ics`, import.meta.url), 'utf8'), { timezone: zone, from, to });
  return { file, synced, rows };
}
const shape = inference => inference.fits.map(f => [f.cycle_kind, f.cycle_length, f.agree, f.repeated]);
const grid = c => ({ periods: c.periods.map(p => p.key), lessons: c.lessons.map(l => [l.slot, l.period_key, l.subject, l.room, l.teacher, l.notes]), holidays: c.ics.holidays });

describe('rows synced by the hub give the same lessons and timetable as the calendar file over the same weeks', () => {
  it('Arbor-style UK Week A/B (Europe/London, across the October clock change)', () => {
    const { file, synced } = compare('uk-arbor-week-ab', 'Europe/London');
    expect(synced.errors).toEqual([]);
    expect(synced.observations).toEqual(file.observations);
    const a = inferTimetable(file), b = inferTimetable(synced);
    expect(shape(b)).toEqual(shape(a));
    expect(shape(b)[0].slice(0, 2)).toEqual(['weekly', 2]);
    expect(grid(candidateForFit(b, synced.observations))).toEqual(grid(candidateForFit(a, file.observations)));
    expect(candidateForFit(b, synced.observations).ics.holidays.map(h => `${h.start_date} ${h.end_date}`)).toContain('2026-10-26 2026-10-30');
  });

  it('US "Day N" rotation with UTC times and all-day labels stored at UTC midnight', () => {
    const { file, synced, rows } = compare('us-google-rotation-markers', 'America/New_York');
    expect(rows.some(r => r.allDay && r.startAt.endsWith('T00:00:00.000Z'))).toBe(true);
    expect(synced.errors).toEqual([]);
    expect(synced.observations).toEqual(file.observations);
    const a = inferTimetable(file), b = inferTimetable(synced);
    expect(shape(b)[0].slice(0, 2)).toEqual(['day_rotation', 6]);
    expect(grid(candidateForFit(b, synced.observations))).toEqual(grid(candidateForFit(a, file.observations)));
  });

  it('Outlook repeat rules with a Windows zone, a moved lesson and a cancelled one', () => {
    const { file, synced } = compare('outlook-sydney-weekly', 'Australia/Sydney');
    expect(synced.errors).toEqual([]);
    expect(synced.observations).toEqual(file.observations);
    expect(grid(candidateForFit(inferTimetable(synced), synced.observations))).toEqual(grid(candidateForFit(inferTimetable(file), file.observations)));
  });
});

describe('parseSyncedCalendar', () => {
  it('reads timed rows in household time and leaves out today and the partial last day of the horizon', () => {
    const rows = [
      row({ startAt: '2026-10-01T13:00:00.000Z', endAt: '2026-10-01T14:00:00.000Z', title: 'Today' }),
      row({ title: 'Maths' }),
      row({ startAt: '2026-11-25T09:00:00.000Z', endAt: '2026-11-25T10:00:00.000Z', title: 'Last' }),
      row({ startAt: '2026-11-26T09:00:00.000Z', endAt: '2026-11-26T10:00:00.000Z', title: 'Cut at the time of day' }),
    ];
    const { observations, errors, warnings } = parse(rows);
    expect(errors).toEqual([]);
    expect(observations.map(o => [o.date, o.start_time, o.end_time, o.subject, o.room])).toEqual([
      ['2026-10-05', '08:30', '09:30', 'Maths', 'S12'], ['2026-11-25', '09:00', '10:00', 'Last', 'S12']]);
    expect(warnings).toEqual(["A synced calendar shows only the next 8 weeks (2026-10-02 to 2026-11-25), so holidays and changes after that are not seen. To cover the whole term, import the school's calendar file (.ics) instead."]);
  });

  it('starts after the UTC date too, since the hub compares Google local times with a UTC time as text', () => {
    // 22:00 in Honolulu is 08:00 UTC the next day: tomorrow's 07:45 lesson sorts before "now" and may be missing.
    const rows = [row({ id: 'google:c:1', startAt: '2026-10-02T07:45:00-10:00', endAt: '2026-10-02T08:30:00-10:00' }), row({ id: 'google:c:2', startAt: '2026-10-05T07:45:00-10:00', endAt: '2026-10-05T08:30:00-10:00' })];
    const { observations, warnings } = parse(rows, { timezone: 'Pacific/Honolulu', today: '2026-10-01', now: '2026-10-02T08:00:00.000Z' });
    expect(observations.map(o => o.date)).toEqual(['2026-10-05']);
    expect(warnings[0]).toMatch(/\(2026-10-03 to 2026-11-25\)/);
    // East of UTC in the morning the UTC date is still yesterday, so the horizon ends a day earlier instead.
    expect(parse([row()], { timezone: 'Australia/Sydney', today: '2026-10-02', now: '2026-10-01T22:00:00.000Z' }).warnings[0]).toMatch(/\(2026-10-03 to 2026-11-25\)/);
  });

  it('reads a timed row at UTC midnight in household time, not as a date', () => {
    const [o] = parse([row({ startAt: '2026-10-06T00:00:00.000Z', endAt: '2026-10-06T01:00:00.000Z' })], { timezone: 'America/New_York' }).observations;
    expect([o.date, o.start_time]).toEqual(['2026-10-05', '20:00']);
    expect(calendarSources([row({ startAt: '2026-10-06T00:00:00.000Z' })], { timezone: 'America/New_York' })[0].first).toBe('2026-10-05');
  });

  it('treats the hub\'s "(No title)" as untitled for iCal and Apple, and says when the calendar stops early', () => {
    const { observations, warnings } = parse([row({ title: '(No title)' }), row({ id: 'google:c:1', title: '(No title)' })]);
    expect(observations.map(o => o.subject)).toEqual(['', '(No title)']);
    expect(warnings[1]).toBe('The calendar has no lessons after 2026-10-05. That may be a holiday or as far ahead as the school publishes; if the calendar has not synced lately, sync it in Calendar and check again.');
    expect(parse([row({ startAt: '2026-11-12T08:00:00.000Z', endAt: '2026-11-12T09:00:00.000Z' })]).warnings).toHaveLength(1);
  });

  it('reads Google offsets and every all-day form, with exclusive end dates', () => {
    const rows = [
      row({ id: 'google:c:1', startAt: '2026-10-05T08:30:00+01:00', endAt: '2026-10-05T09:30:00+01:00' }),
      row({ id: 'google:c:2', allDay: true, title: 'Day 3', startAt: '2026-10-06', endAt: '2026-10-07' }),
      row({ id: 'ical:u:3', allDay: true, title: 'Half term', startAt: '2026-10-26T00:00:00.000Z', endAt: '2026-10-31T00:00:00.000Z' }),
      // Some feeds end a one-day event on the day it starts.
      row({ id: 'ical:u:4', allDay: true, title: 'INSET', startAt: '2026-11-16T00:00:00.000Z', endAt: '2026-11-16T00:00:00.000Z' }),
      // A holiday that started before the window covers the dates inside it; one running past the horizon is clipped.
      row({ id: 'google:c:5', allDay: true, title: 'Break', startAt: '2026-09-28', endAt: '2026-10-05' }),
      row({ id: 'google:c:6', allDay: true, title: 'Winter', startAt: '2026-11-23', endAt: '2026-12-10' }),
    ];
    expect(parse(rows).observations.map(o => [o.date, o.end_date, o.all_day, o.start_time, o.subject])).toEqual([
      ['2026-10-02', '2026-10-04', true, '', 'Break'],
      ['2026-10-05', '2026-10-05', false, '08:30', 'Maths'],
      ['2026-10-06', '2026-10-06', true, '', 'Day 3'],
      ['2026-10-26', '2026-10-30', true, '', 'Half term'],
      ['2026-11-16', '2026-11-16', true, '', 'INSET'],
      ['2026-11-23', '2026-11-25', true, '', 'Winter'],
    ]);
  });

  it('reads only the chosen calendar, by connection and calendar name', () => {
    const rows = [row({ title: 'Mine' }), row({ connectionId: 'conn-2', title: 'Other feed' }), row({ calendarName: 'Work', title: 'Other calendar' })];
    expect(parse(rows).observations.map(o => o.subject)).toEqual(['Mine']);
    expect(parse(rows, { source: 'conn-1|Work' }).observations.map(o => o.subject)).toEqual(['Other calendar']);
  });

  it('splits the title, reads the teacher line and decodes entities, as a calendar file does', () => {
    const [o] = parse([row({ title: 'English &amp; Drama: 9X/En2', location: 'Room: B4', description: 'Teacher: Ms A Li\nBring book' })]).observations;
    expect([o.subject, o.notes, o.room, o.teacher]).toEqual(['English & Drama', '9X/En2', 'B4', 'Ms A Li']);
  });

  it('reads an iCal all-day date as the date it names, west of UTC too', () => {
    const rows = [row({ allDay: true, title: 'Day 2', startAt: '2026-10-06T00:00:00.000Z', endAt: '2026-10-07T00:00:00.000Z' })];
    expect(parse(rows, { timezone: 'America/Los_Angeles' }).observations.map(o => [o.date, o.end_date])).toEqual([['2026-10-06', '2026-10-06']]);
  });

  it('reads a Somtoday summary by its UID, including UIDs with colons', () => {
    const [o] = parse([row({ id: 'ical:urn:uuid:42@somtoday.nl:20261005T073000Z', title: 'B12 - 9a/wi - JAN', location: null })]).observations;
    expect([o.subject, o.room, o.teacher]).toEqual(['9a/wi', 'B12', 'JAN']);
  });

  it('ends the window before any day the row cap may have cut', () => {
    const rows = Array.from({ length: SYNC_LIMITS.rows }, (_, i) => row({ connectionId: i < 400 ? 'conn-2' : 'conn-1', title: `E${i}`,
      startAt: `2026-10-${String(5 + Math.floor(i / 40)).padStart(2, '0')}T08:00:00.000Z`, endAt: `2026-10-${String(5 + Math.floor(i / 40)).padStart(2, '0')}T09:00:00.000Z` }));
    const { observations, warnings } = parse(rows);
    // The last row read is 2026-10-17 08:00 UTC; a left-out row could be a "+14:00" time from 18:00 UTC on the 16th.
    expect([...new Set(observations.map(o => o.date))]).toEqual(['2026-10-15']);
    expect(warnings[1]).toBe('This student\'s synced calendars have more than 500 events in that time, so only events up to 2026-10-15 were read.');
  });

  it('places the cap cut by instant, since an all-day row at UTC midnight sorts before the evening west of UTC', () => {
    const lessonsOn = day => [row({ title: `A${day}`, startAt: `2026-10-${day}T18:00:00.000Z`, endAt: `2026-10-${day}T19:00:00.000Z` }), row({ title: `B${day}`, startAt: `2026-10-${day}T23:00:00.000Z`, endAt: `2026-10-${day}T23:30:00.000Z` })];
    const early = ['02', '05'].flatMap(lessonsOn);
    const filler = Array.from({ length: SYNC_LIMITS.rows - early.length - 1 }, () => row({ connectionId: 'conn-2', startAt: '2026-10-05T19:00:00.000Z', endAt: '2026-10-05T20:00:00.000Z' }));
    // The hub's last row: Day 3 on 10-06, stored as 2026-10-06T00:00Z; in Honolulu that is 10-05 14:00, so 10-05 is partial.
    const rows = [...early, ...filler, row({ allDay: true, title: 'Day 3', startAt: '2026-10-06T00:00:00.000Z', endAt: '2026-10-07T00:00:00.000Z' })];
    const { observations, warnings } = parse(rows, { timezone: 'Pacific/Honolulu', today: '2026-10-01', now: '2026-10-01T20:00:00.000Z' });
    expect(warnings[1]).toMatch(/only events up to 2026-10-04 were read/);
    expect([...new Set(observations.map(o => o.date))]).toEqual(['2026-10-02']);
    expect(calendarSources([rows.at(-1)], { timezone: 'Pacific/Honolulu' })[0].first).toBe('2026-10-06');
  });

  it('never lets the cap push the window past its usual end', () => {
    const rows = Array.from({ length: SYNC_LIMITS.rows }, (_, i) => row({ title: `E${i}`, startAt: i < 499 ? '2026-10-05T08:00:00.000Z' : '2026-11-27T08:00:00.000Z', endAt: i < 499 ? '2026-10-05T09:00:00.000Z' : '2026-11-27T09:00:00.000Z' }));
    expect(parse(rows).warnings.find(w => w.includes('more than 500'))).toMatch(/only events up to 2026-11-25 were read/);
  });

  it('keeps a Google bare date from placing the cut after a day it has not finished', () => {
    // "2026-10-06" sorts after "2026-10-06T01:00:00.000Z", which is 18:00 on October 5 in Los Angeles.
    const early = [row({ title: 'Oct 2', startAt: '2026-10-02T16:00:00.000Z', endAt: '2026-10-02T17:00:00.000Z' }), row({ title: 'Oct 5 morning', startAt: '2026-10-05T16:00:00.000Z', endAt: '2026-10-05T17:00:00.000Z' })];
    const filler = Array.from({ length: SYNC_LIMITS.rows - early.length - 1 }, () => row({ connectionId: 'conn-2', startAt: '2026-10-05T17:00:00.000Z', endAt: '2026-10-05T18:00:00.000Z' }));
    const rows = [...early, ...filler, row({ id: 'google:c:day', connectionId: 'conn-2', allDay: true, title: 'Day 4', startAt: '2026-10-06', endAt: '2026-10-07' })];
    const { observations } = parse(rows, { timezone: 'America/Los_Angeles', today: '2026-10-01', now: '2026-10-01T20:00:00.000Z' });
    expect(observations.map(o => o.subject)).toEqual(['Oct 2']);
    // The cut comes from the largest start text, not from the order rows arrive in.
    expect(parse([...rows].reverse(), { timezone: 'America/Los_Angeles', today: '2026-10-01', now: '2026-10-01T20:00:00.000Z' }).observations.map(o => o.subject)).toEqual(['Oct 2']);
  });

  it('allows for a "+14:00" local time sorting after the instant it names', () => {
    const rows = [row({ title: 'Oct 4', startAt: '2026-10-04T12:00:00.000Z', endAt: '2026-10-04T13:00:00.000Z' }), ...Array.from({ length: SYNC_LIMITS.rows - 1 }, () => row({ connectionId: 'conn-2', id: 'google:k:1', startAt: '2026-10-06T00:30:00+14:00', endAt: '2026-10-06T01:30:00+14:00' }))];
    // A left-out "2026-10-06T00:40:00+14:00" is 10:40 UTC on October 5.
    expect(parse(rows, { timezone: 'UTC', today: '2026-10-01', now: '2026-10-01T12:00:00.000Z' }).warnings[1]).toMatch(/only events up to 2026-10-04 were read/);
  });

  it('never keeps a day that a row the hub left out belongs to, for mixed forms and zones', () => {
    // Simulates the hub read: rows ordered by start text, cut at 500, over random UTC, offset and bare-date values.
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const pad = n => String(n).padStart(2, '0');
    const zones = ['America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Kiritimati', 'Australia/Sydney', 'Europe/London', 'UTC'];
    for (let trial = 0; trial < 60; trial++) {
      const zone = zones[trial % zones.length];
      const all = Array.from({ length: 700 }, (_, i) => {
        const day = 2 + Math.floor(rand() * 20), hour = Math.floor(rand() * 24), kind = rand();
        const date = `2026-10-${pad(day)}`;
        if (kind < 0.15) return row({ id: `google:b:${i}`, allDay: true, startAt: date, endAt: addDays(date, 1) });
        if (kind < 0.25) return row({ id: `ical:a${i}:x`, allDay: true, startAt: `${date}T00:00:00.000Z`, endAt: `${addDays(date, 1)}T00:00:00.000Z` });
        if (kind < 0.6) {
          const offset = Math.floor(rand() * 27) - 12, sign = offset < 0 ? '-' : '+';
          return row({ id: `google:t:${i}`, startAt: `${date}T${pad(hour)}:00:00${sign}${pad(Math.abs(offset))}:00`, endAt: `${date}T${pad(hour)}:30:00${sign}${pad(Math.abs(offset))}:00` });
        }
        return row({ id: `ical:t${i}:x`, startAt: `${date}T${pad(hour)}:00:00.000Z`, endAt: `${date}T${pad(hour)}:30:00.000Z` });
      });
      const ordered = [...all].sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0));
      const read = ordered.slice(0, SYNC_LIMITS.rows), left = ordered.slice(SYNC_LIMITS.rows);
      const shuffled = read.map(r => [rand(), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
      const result = parse(shuffled, { timezone: zone, today: '2026-10-01', now: '2026-10-01T12:00:00.000Z' });
      const to = result.errors.length ? null : result.warnings[1].match(/up to (\S+) were read/)[1];
      if (!to) continue;
      for (const r of left) {
        const date = r.allDay ? r.startAt.slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(r.startAt));
        expect(date > to, `${zone}: left-out ${r.startAt} (${date}) is inside a window ending ${to}`).toBe(true);
      }
    }
  });

  it('refuses a capped window with nothing complete in it', () => {
    const rows = Array.from({ length: SYNC_LIMITS.rows }, () => row({ startAt: '2026-10-02T08:00:00.000Z', endAt: '2026-10-02T09:00:00.000Z' }));
    expect(parse(rows).errors[0]).toMatch(/too many events tomorrow/);
  });

  it('warns about skipped rows', () => {
    const rows = [
      row(),
      row({ endAt: row().startAt }),
      row({ startAt: '2026-10-05T22:00:00.000Z', endAt: '2026-10-06T01:00:00.000Z' }),
      row({ startAt: 'soon' }),
      row({ endAt: '2026-10-05T06:00:00.000Z' }),
    ];
    const { observations, warnings } = parse(rows);
    expect(observations).toHaveLength(1);
    expect(warnings.slice(2)).toEqual([
      '1 event starts and ends at the same time (such as a deadline) and was skipped.',
      '1 event runs past midnight and was skipped.',
      '2 events have unreadable dates and were skipped.',
    ]);
  });

  it('keeps a lesson ending at midnight', () => {
    const [o] = parse([row({ startAt: '2026-10-05T22:00:00.000Z', endAt: '2026-10-05T23:00:00.000Z' })]).observations;
    expect([o.date, o.start_time, o.end_time]).toEqual(['2026-10-05', '23:00', '23:59']);
  });

  it('needs events and a household time zone', () => {
    expect(parse([row({ connectionId: 'conn-2' })]).errors).toEqual(['No events from this calendar yet. Sync it in Calendar, then try again.']);
    expect(parse([row()], { timezone: null }).errors[0]).toMatch(/no time zone set/);
    expect(parse([row()], { timezone: 'Mars/Olympus' }).errors[0]).toMatch(/"Mars\/Olympus" is not recognised/);
  });
});

describe('calendarSources', () => {
  it('groups by connection and calendar name, most events first, with household-local dates and sample titles', () => {
    const rows = [
      row({ id: 'google:a:1', connectionId: 'g', calendarName: 'Family', title: 'Dentist', startAt: '2026-10-09T09:00:00-04:00' }),
      row({ id: 'google:a:2', connectionId: 'g', calendarName: 'School', title: 'Maths', startAt: '2026-10-02T23:30:00.000Z' }),
      row({ id: 'google:a:3', connectionId: 'g', calendarName: 'School', title: 'Maths', startAt: '2026-10-05T08:00:00-04:00' }),
      row({ id: 'google:a:4', connectionId: 'g', calendarName: 'School', allDay: true, title: 'Day 1', startAt: '2026-10-07' }),
      row({ id: 'google:a:5', connectionId: 'g', calendarName: 'School', title: 'Art', startAt: '2026-10-08T08:00:00-04:00' }),
      row({ id: 'google:a:6', connectionId: 'g', calendarName: 'School', title: 'PE', startAt: '2026-10-08T09:00:00-04:00' }),
      row({ id: 'google:a:7', connectionId: 'g', calendarName: 'School', title: 'Music', startAt: '2026-10-08T10:00:00-04:00' }),
    ];
    expect(calendarSources(rows, { timezone: 'America/New_York' })).toEqual([
      { key: 'g|School', name: 'School', provider: 'google', count: 6, first: '2026-10-02', last: '2026-10-08', samples: ['Maths', 'Art', 'PE'] },
      { key: 'g|Family', name: 'Family', provider: 'google', count: 1, first: '2026-10-09', last: '2026-10-09', samples: ['Dentist'] },
    ]);
  });

  it('reads the provider from the hub id', () => {
    expect(['google:c:e', 'apple:https://x:u', 'ical:uid:1', 'manual-1'].map(id => providerOf({ id }))).toEqual(['google', 'apple', 'ical', null]);
  });
});
