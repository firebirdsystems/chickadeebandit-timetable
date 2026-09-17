// ICS file import (plan §5.2): calendar events → household-local observations.
// No library. Recurrences are expanded only inside the requested window, with explicit caps.
import { addDays, dateFromDay, dayNumber, mod, weekday } from './logic.js';

export const ICS_LIMITS = { bytes: 2_000_000, events: 5_000, perRule: 500, occurrences: 20_000 };

// Zone names Outlook/Exchange-based school portals write instead of IANA names.
const WINDOWS_ZONES = {
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'E. Europe Standard Time': 'Europe/Chisinau',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax',
  'Canada Central Standard Time': 'America/Regina',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'E. Australia Standard Time': 'Australia/Brisbane',
  'Cen. Australia Standard Time': 'Australia/Adelaide', 'AUS Central Standard Time': 'Australia/Darwin',
  'W. Australia Standard Time': 'Australia/Perth', 'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland', 'Singapore Standard Time': 'Asia/Singapore',
  'India Standard Time': 'Asia/Kolkata', 'South Africa Standard Time': 'Africa/Johannesburg',
  'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo', 'UTC': 'UTC',
  'Central European Standard Time': 'Europe/Warsaw', 'FLE Standard Time': 'Europe/Kiev', 'GTB Standard Time': 'Europe/Bucharest',
  'SE Asia Standard Time': 'Asia/Bangkok', 'Arabian Standard Time': 'Asia/Dubai', 'Korea Standard Time': 'Asia/Seoul',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Newfoundland Standard Time': 'America/St_Johns',
  'tzone://Microsoft/Utc': 'UTC', 'tzone://Microsoft/Custom': null,
};
const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
// Line by line, so an empty "Staff:" line (a cover lesson) never takes the next line as its value.
const TEACHER_LINE = /^[ \t]*(?:teachers?|staff|tutor|instructor|professeur(?:\(s\)|s)?)[ \t]*:[ \t]*(\S[^\n]*?)[ \t]*$/im;
// Pronote's DESCRIPTION names the subject ("Matière : ANGLAIS LV1"); its summary may add more.
const SUBJECT_LINE = /^[ \t]*mati[eè]re[ \t]*:[ \t]*(\S[^\n]*?)[ \t]*$/im;
// A room given only in DESCRIPTION (Pronote's "Salle(s) : B12").
const ROOM_LINE = /^[ \t]*(?:salles?|salle\(s\))[ \t]*:[ \t]*(\S[^\n]*?)[ \t]*$/im;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—',
  hellip: '…', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', oacute: 'ó', iacute: 'í', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß' };
// Some portals put HTML in DESCRIPTION; line breaks become new lines, other tags are dropped and entities decoded.
const decodeEntities = text => text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, dec, hex, name) => {
  if (name) return ENTITIES[name.toLowerCase()] ?? whole;
  const code = dec ? Number(dec) : parseInt(hex, 16);
  return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
});
const plainText = html => decodeEntities(html.replace(/<br\s*\/?>|<\/?(?:p|div|li|tr|h[1-6])(?:\s[^<>]*)?>/gi, '\n').replace(/<[^<>]*>/g, ''));

/**
 * File bytes → text. A calendar's folded lines are joined before decoding, since a fold may split a
 * multi-byte character (RFC 5545 §3.1); anything else is decoded as it is.
 */
export function decodeImportFile(buffer) {
  const bytes = new Uint8Array(buffer);
  const isCalendar = text => /^\uFEFF?\s*BEGIN:VCALENDAR/i.test(text);
  // Folds are CR LF, LF or CR followed by a space or tab, removed from a sequence of bytes or UTF-16 code units.
  const unfold = units => {
    const joined = new units.constructor(units.length);
    let length = 0;
    for (let i = 0; i < units.length; i++) {
      const fold = units[i] === 0x0d ? (units[i + 1] === 0x0a ? 2 : 1) : units[i] === 0x0a ? 1 : 0;
      if (fold && (units[i + fold] === 0x20 || units[i + fold] === 0x09)) { i += fold; continue; }
      joined[length++] = units[i];
    }
    return joined.subarray(0, length);
  };
  // Spreadsheet "Unicode text" exports are UTF-16 with a byte-order mark.
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    const little = bytes[0] === 0xff;
    const text = new TextDecoder(little ? 'utf-16le' : 'utf-16be').decode(bytes);
    if (!isCalendar(text)) return text;
    const units = new Uint16Array(Math.floor((bytes.length - 2) / 2)).map((_, i) => (little ? bytes[2 + 2 * i] | (bytes[3 + 2 * i] << 8) : (bytes[2 + 2 * i] << 8) | bytes[3 + 2 * i]));
    const joined = unfold(units);
    let out = '';
    for (let i = 0; i < joined.length; i += 8192) out += String.fromCharCode(...joined.subarray(i, i + 8192));
    return out;
  }
  // Mostly UTF-8 with a stray or truncated byte keeps its UTF-8 text; a file with no UTF-8 sequences at all is a
  // Windows (Latin) export.
  const decode = data => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { /* not clean UTF-8 */ }
    return new TextDecoder(hasUtf8Sequence(data) ? 'utf-8' : 'windows-1252').decode(data);
  };
  const text = decode(bytes);
  return isCalendar(text) ? decode(unfold(bytes)) : text;
}

function hasUtf8Sequence(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const extra = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;
    if (!extra || i + extra >= bytes.length) continue;
    let ok = true;
    for (let k = 1; k <= extra; k++) if ((bytes[i + k] & 0xc0) !== 0x80) ok = false;
    if (ok) return true;
  }
  return false;
}

// ── Lines and properties ─────────────────────────────────────────────────────

function contentLines(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  let quoted = false, i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    // Exchange writes TZID=tzone://Microsoft/Utc unquoted; that colon is part of the value.
    else if (line[i] === ':' && !quoted && line.slice(i, i + 3) !== '://') break;
  }
  if (i >= line.length) return null;
  const [name, ...rest] = line.slice(0, i).match(/(?:[^;"]|"[^"]*")+/g) ?? [''];
  const params = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

const unescapeText = value => value.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

// ── Time zones ───────────────────────────────────────────────────────────────

const formatters = new Map();
function zoneParts(ms, zone) {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(zone, format);
  }
  const p = Object.fromEntries(format.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
const wallMs = (date, time) => dayNumber(date) * 86_400_000 + time.split(':').reduce((s, n, i) => s + Number(n) * [3_600_000, 60_000, 1000][i], 0);
const wallFromMs = ms => ({ date: dateFromDay(Math.floor(ms / 86_400_000)), time: new Date(mod(ms, 86_400_000)).toISOString().slice(11, 19) });

/**
 * Wall-clock time in an IANA zone → UTC ms, using the offsets either side of any clock change. A repeated
 * wall time takes its first occurrence; a time skipped by a change moves forward by the gap.
 */
export function zonedToUtc(date, time, zone) {
  const target = wallMs(date, time);
  const offset = ms => { const p = zoneParts(ms, zone); return wallMs(p.date, p.time) - ms; };
  const [before, after] = [target - offset(target - 86_400_000), target - offset(target + 86_400_000)];
  const lands = ms => { const p = zoneParts(ms, zone); return wallMs(p.date, p.time) === target; };
  return [before, after].sort((a, b) => a - b).find(lands) ?? before;
}

/** An IANA zone for a TZID, via the Windows table or a path-style prefix; null when unknown. */
export function resolveZone(tzid) {
  const raw = String(tzid ?? '').trim();
  if (Object.hasOwn(WINDOWS_ZONES, raw) && !WINDOWS_ZONES[raw]) return null;
  const candidates = [raw, WINDOWS_ZONES[raw], raw.split('/').slice(-2).join('/'), raw.split('/').slice(-3).join('/')];
  for (const zone of candidates) {
    if (!zone || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) continue;
    try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone; } catch { /* next */ }
  }
  return null;
}

// ── Values ───────────────────────────────────────────────────────────────────

/** A DATE or DATE-TIME property → { allDay, date, time, zone } where zone is 'UTC', an IANA name or null (floating). */
function parseStamp(prop, unknownZones) {
  const m = String(prop?.value ?? '').trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  try { dayNumber(date); } catch { return null; }
  if (m[4] === undefined) return { allDay: true, date, time: '00:00:00', zone: null };
  const time = `${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  if (Number(m[4]) > 23 || Number(m[5]) > 59) return null;
  if (m[7]) return { allDay: false, date, time, zone: 'UTC' };
  if (!prop.params.TZID) return { allDay: false, date, time, zone: null };
  const zone = resolveZone(prop.params.TZID);
  if (!zone) unknownZones.add(prop.params.TZID);
  return { allDay: false, date, time, zone };
}

function parseDuration(value) {
  const m = String(value ?? '').trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m || m[1] === '-') return null;
  const [w, d, h, min, s] = m.slice(2).map(n => Number(n ?? 0));
  return { days: w * 7 + d, ms: ((h * 60 + min) * 60 + s) * 1000 };
}

function parseRule(value) {
  // Values are case-insensitive (RFC 5545 §3.3.10); a trailing comma in BYDAY is tolerated.
  const rule = Object.fromEntries(String(value).toUpperCase().split(';').filter(Boolean).map(part => {
    const eq = part.indexOf('=');
    return [part.slice(0, eq).toUpperCase(), part.slice(eq + 1)];
  }));
  const supported = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT', 'WKST']);
  if (!['WEEKLY', 'DAILY'].includes(rule.FREQ) || Object.keys(rule).some(k => !supported.has(k))) return null;
  const interval = rule.INTERVAL === undefined ? 1 : Number(rule.INTERVAL);
  const count = rule.COUNT === undefined ? null : Number(rule.COUNT);
  const byday = rule.BYDAY ? rule.BYDAY.split(',').filter(d => d.trim()).map(d => DAY_CODES.indexOf(d.trim())) : null;
  const wkst = rule.WKST ? DAY_CODES.indexOf(rule.WKST) : 0;
  if (!Number.isInteger(interval) || interval < 1 || (count !== null && (!Number.isInteger(count) || count < 1))
    || byday?.some(d => d < 0) || wkst < 0) return null;
  return { freq: rule.FREQ, interval, count, byday, wkst, until: rule.UNTIL ?? null };
}

// MIS exports append the class group to the subject ("Maths: 9X/Ma1", "Maths - 9X/Ma1"); it becomes a note.
function splitSummary(summary) {
  const text = summary.trim();
  const m = text.match(/^(.*\S)\s*(?::|\s[-–])\s*(\S+\/\S+)$/);
  return m ? [m[1], m[2]] : [text, ''];
}

// ── Parse ────────────────────────────────────────────────────────────────────

function readEvents(text) {
  const events = [];
  let current = null, depth = 0, sawCalendar = false, calendarZone = null, zoneBlock = null;
  // Each VTIMEZONE's offsets (minutes east of UTC), for zones named in a way no table knows.
  const zoneOffsets = new Map();
  for (const line of contentLines(text)) {
    if (!line.trim()) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (!current) {
      const value = prop.value.trim().toUpperCase();
      if (prop.name === 'BEGIN' && value === 'VTIMEZONE') zoneBlock = { id: null, offsets: [] };
      else if (prop.name === 'END' && value === 'VTIMEZONE') { if (zoneBlock?.id && zoneBlock.offsets.length) zoneOffsets.set(zoneBlock.id, zoneBlock.offsets); zoneBlock = null; }
      else if (zoneBlock && prop.name === 'TZID') zoneBlock.id = prop.value.trim();
      else if (zoneBlock && prop.name === 'TZOFFSETTO') {
        const m = prop.value.trim().match(/^([+-])(\d{2})(\d{2})(\d{2})?$/);
        if (m) zoneBlock.offsets.push((m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])));
      }
    }
    if (prop.name === 'BEGIN') {
      if (prop.value.toUpperCase() === 'VCALENDAR') sawCalendar = true;
      if (current) depth++;
      else if (prop.value.toUpperCase() === 'VEVENT') current = { props: {}, multi: {} };
      continue;
    }
    if (prop.name === 'END') {
      if (current && depth) depth--;
      else if (current && prop.value.toUpperCase() === 'VEVENT') { events.push(current); current = null; }
      continue;
    }
    // Properties of a nested component (VALARM) belong to it, not the event.
    if (!current && prop.name === 'X-WR-TIMEZONE') calendarZone ??= prop.value.trim();
    if (!current || depth) continue;
    if (prop.name === 'EXDATE') (current.multi.EXDATE ??= []).push(prop);
    else if (prop.name === 'RRULE' || prop.name === 'RDATE' || prop.name === 'EXRULE') (current.multi[prop.name] ??= []).push(prop);
    else current.props[prop.name] ??= prop;
  }
  return { events, sawCalendar, calendarZone, zoneOffsets, truncated: !!current };
}

/**
 * Parses an ICS file into observations `{ date, start_time, end_time, subject, room, teacher, notes, all_day, end_date }`
 * in the household zone, keeping only occurrences whose household date is inside `from`–`to` (inclusive).
 * A file with zoned or UTC times needs a valid household zone; without one the times cannot be placed.
 */
export function parseIcs(text, { timezone, from, to }) {
  const fail = message => ({ observations: [], warnings: [], errors: [message] });
  const source = String(text ?? '');
  if (new TextEncoder().encode(source).length > ICS_LIMITS.bytes) return fail('The file is larger than 2 MB. Export only this timetable or one school year.');
  const { events, sawCalendar, calendarZone, zoneOffsets, truncated } = readEvents(source);
  if (!sawCalendar) return fail('This is not a calendar (.ics) file.');
  if (!events.length) return fail('The calendar has no events.');
  if (events.length > ICS_LIMITS.events) return fail(`The calendar has more than ${ICS_LIMITS.events.toLocaleString('en-US')} events. Export only this timetable or one school year.`);

  // Zone conversions dominate the cost; the same wall times and instants recur across lessons.
  const utcMemo = new Map(), partsMemo = new Map();
  const instant = s => {
    if (!s.zone) return wallMs(s.date, s.time);
    const key = `${s.zone}|${s.date}T${s.time}`;
    if (!utcMemo.has(key)) utcMemo.set(key, zonedToUtc(s.date, s.time, s.zone));
    return utcMemo.get(key);
  };
  const zone = timezone ? resolveZone(timezone) : null;
  // Outlook sometimes names a zone no table knows ("Customized Time Zone", "(UTC-05:00) Eastern Time (US and Canada)").
  // One whose offsets match the household zone's, by its VTIMEZONE block or the UTC offset in its name, is read as it.
  if (zone) {
    const year = Number(String(from).slice(0, 4));
    const mine = [`${year}-01-15`, `${year}-07-15`].map(d => (wallMs(d, '12:00:00') - zonedToUtc(d, '12:00:00', zone)) / 60_000);
    const matches = tzid => {
      const defined = zoneOffsets.get(tzid);
      if (defined) return Math.min(...defined) === Math.min(...mine) && Math.max(...defined) === Math.max(...mine);
      const m = tzid.match(/^\((?:UTC|GMT)(?:([+-])(\d{1,2}):(\d{2}))?\)/);
      return !!m && (m[1] === '-' ? -1 : 1) * (Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) === Math.min(...mine);
    };
    const alias = new Map();
    for (const event of events) {
      for (const prop of [...Object.values(event.props), ...Object.values(event.multi).flat()]) {
        const tzid = prop.params?.TZID;
        if (!tzid) continue;
        if (!alias.has(tzid)) alias.set(tzid, !resolveZone(tzid) && matches(String(tzid).trim()));
        if (alias.get(tzid)) prop.params.TZID = zone;
      }
    }
  }
  const household = ms => {
    if (!partsMemo.has(ms)) partsMemo.set(ms, zoneParts(ms, zone));
    return partsMemo.get(ms);
  };

  const unknownZones = new Set();
  const counts = { unsupportedRule: 0, rdate: 0, invalid: 0, noEnd: 0, noLength: 0, crossesMidnight: 0, capped: 0, orphanOverrides: 0 };
  const outside = new Set();
  const overrides = new Map();
  let overrideCount = 0;
  const masters = [];
  let zoned = false;
  const usedZones = new Set();
  for (const event of events) {
    const recurrenceId = event.props['RECURRENCE-ID'];
    const uid = event.props.UID?.value ?? '';
    const key = recurrenceId && uid ? parseStamp(recurrenceId, unknownZones) : null;
    // A change with no DTSTART (often just a cancellation) keeps the occurrence's original start.
    const start = parseStamp(event.props.DTSTART, unknownZones) ?? key;
    if (!start) { counts.invalid++; continue; }
    if (start.zone) { zoned = true; usedZones.add(start.zone); }
    if (key) {
      // RANGE=THISANDFUTURE changes this occurrence and every later one of the series.
      const range = recurrenceId.params.RANGE?.toUpperCase() === 'THISANDFUTURE';
      (overrides.get(uid) ?? overrides.set(uid, []).get(uid)).push({ event, start, key, range, order: overrideCount++, used: false, sequence: Number(event.props.SEQUENCE?.value) || 0 });
      continue;
    }
    masters.push({ event, start, uid });
  }
  if (zoned && !zone) {
    return fail(timezone
      ? `The household time zone "${timezone}" is not recognised, so the calendar's times cannot be placed. Fix it in household settings and import again.`
      : 'The household has no time zone set, so the calendar\'s times cannot be placed. Set it in household settings and import again.');
  }

  const observations = [];
  let total = 0, iterations = 0;
  const fromDay = dayNumber(from), toDay = dayNumber(to);
  // A named calendar zone whose gap to the household zone changes (their clocks change on different dates).
  const shifts = new Map();
  const cancelled = event => event.props.STATUS?.value?.toUpperCase() === 'CANCELLED';

  // A change that gives no end keeps its series' length.
  const allDayLength = (event, base) => {
    const end = parseStamp(event.props.DTEND, new Set());
    const duration = event.props.DURATION ? parseDuration(event.props.DURATION.value) : null;
    if (!end && !duration && event.master) return allDayLength(event.master, event.master.baseStart);
    return end?.allDay ? dayNumber(end.date) - dayNumber(base.date) : duration ? duration.days + Math.floor(duration.ms / 86_400_000) : 1;
  };
  const timedLength = event => {
    const end = parseStamp(event.props.DTEND, unknownZones);
    const duration = event.props.DURATION ? parseDuration(event.props.DURATION.value) : null;
    if (end && !end.allDay) return instant(end) - instant(event.baseStart);
    if (duration) return duration.days * 86_400_000 + duration.ms;
    return !end && event.master ? timedLength(event.master) : null;
  };
  const emit = (event, start) => {
    if (cancelled(event)) return;
    const props = event.props;
    // Text is read once per event, not once per occurrence.
    event.text ??= (() => {
      // Titles and places are plain text, but Sentral and Pronote escape them as HTML ("English &amp; Drama").
      const summary = decodeEntities(unescapeText(props.SUMMARY?.value ?? ''));
      const description = plainText(unescapeText(props.DESCRIPTION?.value ?? ''));
      const location = decodeEntities(unescapeText(props.LOCATION?.value ?? '')).trim().replace(/^(?:room|rm)\s*:\s*/i, '');
      // Somtoday writes "room - lesson group - teacher" as the summary, so a room change would read as a new subject.
      const parts = /somtoday/i.test(props.UID?.value ?? '') ? summary.split(' - ').map(x => x.trim()) : [];
      if (parts.length === 3 && parts[1]) return { subject: parts[1], notes: '', room: location || parts[0], teacher: parts[2] };
      const named = description.match(SUBJECT_LINE)?.[1];
      const [subject, notes] = named ? [named, ''] : splitSummary(summary);
      return { subject, notes, room: location || (description.match(ROOM_LINE)?.[1] ?? ''), teacher: description.match(TEACHER_LINE)?.[1] ?? '' };
    })();
    const { subject, notes, room, teacher } = event.text;
    if (start.allDay) {
      // Some systems (Blackbaud, older Canvas) end a one-day event on the day it starts.
      const length = allDayLength(event, event.baseStart);
      const days = length === 0 ? 1 : length;
      if (days < 1) { counts.invalid++; return; }
      // A holiday that began before the window still covers the dates inside it.
      const last = dayNumber(start.date) + days - 1;
      if (last < fromDay || dayNumber(start.date) > toDay) { outside.add(event); return; }
      if (dayNumber(start.date) < fromDay) outside.add(event);
      observations.push({ all_day: true, date: dateFromDay(Math.max(dayNumber(start.date), fromDay)), end_date: dateFromDay(last), start_time: '', end_time: '', subject, room, teacher, notes });
      total++;
      return true;
    }
    // An occurrence keeps its event's duration; a zoned start is converted once, in instants.
    const startMs = instant(start);
    const lengthMs = timedLength(event);
    if (lengthMs === null) { counts.noEnd++; return; }
    // An event that starts and ends at the same moment is a deadline or reminder, not a lesson.
    if (lengthMs === 0) { counts.noLength++; return; }
    if (!(lengthMs > 0)) { counts.invalid++; return; }
    const a = start.zone ? household(startMs) : wallFromMs(startMs);
    const b = start.zone ? household(startMs + lengthMs) : wallFromMs(startMs + lengthMs);
    if (dayNumber(a.date) < fromDay || dayNumber(a.date) > toDay) { outside.add(event); return; }
    if (start.zone && start.zone !== 'UTC' && start.zone !== zone) {
      (shifts.get(start.zone) ?? shifts.set(start.zone, new Set()).get(start.zone)).add(wallMs(a.date, a.time) - wallMs(start.date, start.time));
    }
    if (a.date !== b.date && !(b.time === '00:00:00' && dayNumber(b.date) === dayNumber(a.date) + 1)) { counts.crossesMidnight++; return; }
    const end_time = b.date !== a.date ? '23:59' : b.time.slice(0, 5);
    if (end_time <= a.time.slice(0, 5)) { counts.invalid++; return; }
    observations.push({ all_day: false, date: a.date, end_date: a.date, start_time: a.time.slice(0, 5), end_time, subject, room, teacher, notes });
    total++;
    return true;
  };

  // The date a timed value names for an all-day occurrence: its own date when it has a TZID; for UTC, the household
  // date when that is midnight (Google's form), else the UTC date at UTC midnight, else the household date.
  const dateOf = stamp => {
    if (!stamp.zone || !zone || stamp.zone !== 'UTC') return stamp.date;
    const local = household(instant(stamp));
    return local.time === '00:00:00' || stamp.time !== '00:00:00' ? local.date : stamp.date;
  };
  // RECURRENCE-ID and EXDATE values name an occurrence by date (all-day), by instant (zoned or UTC) or by wall time
  // (floating). A floating occurrence is also matched by its instant in household time, and a zoned value names
  // an all-day occurrence by its household date.
  const keysOf = stamp => {
    if (stamp.allDay) return { day: `D${stamp.date}`, date: stamp.date };
    if (stamp.zone) return { at: `T${instant(stamp)}`, date: dateOf(stamp) };
    return { at: `W${stamp.date}T${stamp.time}`, date: stamp.date };
  };
  const lookupsOf = occurrence => {
    if (occurrence.allDay) return [`A${occurrence.date}`];
    const out = [`D${occurrence.date}`, `W${occurrence.date}T${occurrence.time}`];
    if (occurrence.zone) out.push(`T${instant(occurrence)}`);
    else if (zone) out.push(`T${instant({ ...occurrence, zone })}`);
    return out;
  };
  // Of several changes to one occurrence, the highest SEQUENCE wins (the later one in the file on a tie).
  const newest = list => list.reduce((best, o) => (o.sequence > best.sequence || (o.sequence === best.sequence && o.order > best.order) ? o : best));
  // Changes a series matches are marked as its own, so a "this and future" change of one series sharing a UID with
  // another is never applied to the other.
  const indexOverrides = (own, owner = null) => {
    const index = new Map();
    const add = (key, o) => (index.get(key) ?? index.set(key, []).get(key)).push(o);
    for (const o of own) {
      const keys = keysOf(o.key);
      add(`A${keys.date}`, o);
      add(keys.day ?? keys.at, o);
    }
    // An exact match (same kind: all-day for all-day, a time for a timed occurrence) comes before a date-only one.
    return occurrence => {
      const pick = (keys, keep) => [...new Set(keys.flatMap(key => index.get(key) ?? []))].filter(o => !o.used && keep(o));
      const keys = lookupsOf(occurrence);
      const exact = occurrence.allDay ? pick(keys, o => o.key.allDay) : pick(keys.filter(key => key[0] !== 'D'), () => true);
      const open = exact.length ? exact : pick(keys, () => true);
      if (!open.length) return null;
      for (const o of open) { o.used = true; o.owner ??= owner; }
      return newest(open);
    };
  };
  const emitOverride = override => { override.event.baseStart = override.start; return emit(override.event, override.start); };
  const masterUids = new Set(masters.map(m => m.uid));
  const mastersPerUid = masters.reduce((map, m) => map.set(m.uid, (map.get(m.uid) ?? 0) + 1), new Map());
  // An instant for any value (a floating one read in household time), and its wall time in a zone (household when null).
  const instantOf = stamp => (stamp.zone ? instant(stamp) : zone ? instant({ ...stamp, zone }) : wallMs(stamp.date, stamp.time));
  const wallIn = (stamp, target) => {
    const tz = target ?? zone;
    return stamp.allDay || !tz || (!stamp.zone && !target) ? { date: stamp.date, time: stamp.time } : zoneParts(instantOf(stamp), tz);
  };

  for (const { event, start, uid } of masters) {
    if (total > ICS_LIMITS.occurrences) break;
    const own = overrides.get(uid) ?? [];
    // A cancelled series takes its changed occurrences with it.
    if (cancelled(event)) { for (const o of own) o.used = true; continue; }
    event.baseStart = start;
    for (const o of own) o.event.master = event;
    const overrideFor = indexOverrides(own, event);
    // "This and future" changes, latest first: an occurrence after one takes its details, moved by the same amount of
    // wall time in the change's own zone. A change is this series' once the series has matched its key; a key the
    // expansion never reaches counts when no other series shares the UID.
    const position = stamp => (stamp.allDay ? dayNumber(stamp.date) * 86_400_000 : instantOf(stamp));
    const ranges = own.filter(o => o.range).sort((a, b) => position(b.key) - position(a.key));
    const sole = mastersPerUid.get(uid) === 1;
    const rangeFor = occurrence => ranges.find(o => (o.owner === event || (sole && !o.owner)) && position(o.key) < position(occurrence));
    const moved = (occurrence, change) => {
      if (change.start.allDay !== occurrence.allDay || change.key.allDay !== occurrence.allDay) return occurrence;
      const key = wallIn(change.key, change.start.zone), at = wallIn(occurrence, change.start.zone);
      const shifted = wallFromMs(wallMs(at.date, at.time) + wallMs(change.start.date, change.start.time) - wallMs(key.date, key.time));
      return { ...change.start, date: shifted.date, time: change.start.allDay ? '00:00:00' : shifted.time };
    };
    const emitRange = (change, occurrence) => {
      change.used = true;
      change.event.baseStart = change.start;
      return emit(change.event, moved(occurrence, change)) === true;
    };
    // How many days a change can move an occurrence, so ones just outside the window are still read.
    const reach = Math.max(0, ...ranges.map(o => { const key = wallIn(o.key, o.start.zone); return Math.ceil(Math.abs(wallMs(o.start.date, o.start.time) - wallMs(key.date, key.time)) / 86_400_000) + 1; }));
    const excluded = new Set();
    for (const prop of event.multi.EXDATE ?? []) for (const value of prop.value.split(',')) {
      const stamp = parseStamp({ value: value.trim(), params: prop.params }, unknownZones);
      if (!stamp) continue;
      const keys = keysOf(stamp);
      excluded.add(keys.day ?? keys.at);
      excluded.add(`A${keys.date}`);
    }
    const isExcluded = occurrence => excluded.size > 0 && lookupsOf(occurrence).some(key => excluded.has(key));
    // The changed occurrence replaces the original even when the original is excluded or outside the window.
    const occur = occurrence => {
      const override = overrideFor(occurrence);
      // Only occurrences that add a row count toward the repeat cap.
      if (override) return emitOverride(override) === true;
      if (isExcluded(occurrence)) return false;
      const change = rangeFor(occurrence);
      return change ? emitRange(change, occurrence) : emit(event, occurrence) === true;
    };
    if (event.multi.RDATE || event.multi.EXRULE) counts.rdate++;
    const rules = event.multi.RRULE ?? [];
    const rule = rules.length === 1 ? parseRule(rules[0].value) : null;
    const untilStamp = rule?.until ? parseStamp({ value: rule.until, params: {} }, unknownZones) : null;
    if (!rules.length) { occur(start); continue; }
    if (!rule || (rule.until && !untilStamp)) { counts.unsupportedRule++; occur(start); continue; }
    // UNTIL is compared in the same terms as the occurrence: a date, a wall time when either side floats, or an instant.
    let past = () => false;
    if (untilStamp?.allDay) past = o => o.date > untilStamp.date;
    else if (untilStamp && start.allDay) { const d = dateOf(untilStamp); past = o => o.date > d; }
    else if (untilStamp && !start.zone && untilStamp.zone && zone) { const at = household(instant(untilStamp)); const wall = `${at.date}T${at.time}`; past = o => `${o.date}T${o.time}` > wall; }
    else if (untilStamp && (!untilStamp.zone || !start.zone)) { const wall = `${untilStamp.date}T${untilStamp.time}`; past = o => `${o.date}T${o.time}` > wall; }
    else if (untilStamp) { const ms = instant(untilStamp); past = o => instant(o) > ms; }
    const byday = rule.byday ?? [weekday(start.date)];
    const first = dayNumber(start.date);
    const weekBase = first - mod(weekday(start.date) - rule.wkst, 7);
    // COUNT needs every date from the start; otherwise begin just before the window, or at the earliest changed
    // occurrence, which may move into the window (from up to a year either side). The same goes for the end.
    const overrideDays = own.map(o => Math.min(Math.max(dayNumber(o.key.date), fromDay - 366), toDay + 366));
    // A multi-day all-day occurrence that starts before the window still covers dates inside it.
    const lead = start.allDay ? Math.min(allDayLength(event, start) - 1, 366) : 0;
    const begin = rule.count !== null ? first : Math.max(first, Math.min(fromDay - 2 - lead - reach, ...overrideDays.map(d => d - 1)));
    const finish = Math.max(toDay + 1 + reach, ...overrideDays.map(d => d + 1));
    if (first < fromDay - 1) outside.add(event);
    let seen = 0, emitted = 0;
    for (let n = begin; n <= finish; n++) {
      if (++iterations > 3_000_000) return fail('The calendar\'s repeating events go back too far to read. Export only this school year.');
      const date = dateFromDay(n);
      // DTSTART on a day the rule does not name is not an occurrence (as Outlook and Google treat it).
      const matches = rule.freq === 'WEEKLY'
        ? Math.floor((n - weekBase) / 7) % rule.interval === 0 && byday.includes(weekday(date))
        : (n - first) % rule.interval === 0 && (!rule.byday || byday.includes(weekday(date)));
      if (!matches) continue;
      const occurrence = { ...start, date };
      if (past(occurrence)) break;
      if (rule.count !== null && ++seen > rule.count) break;
      const inWindow = n >= fromDay - 1 - lead && n <= toDay + 1;
      if (!inWindow) {
        // Outside the window only a change can bring an occurrence in; neither counts toward the repeat cap.
        const override = overrideFor(occurrence);
        if (override) emitOverride(override);
        else if (!isExcluded(occurrence)) {
          const change = rangeFor(occurrence);
          const day = change && dayNumber(wallIn(moved(occurrence, change), null).date);
          if (change && day >= fromDay - 1 && day <= toDay + 1) emitRange(change, occurrence);
        }
        continue;
      }
      if (emitted >= ICS_LIMITS.perRule) { if (n <= toDay) counts.capped++; break; }
      if (occur(occurrence)) emitted++;
    }
  }
  // A changed occurrence with no repeating event is a one-off event (a single-instance invitation, a deleted series).
  for (const [uid, own] of overrides) {
    if (masterUids.has(uid)) {
      for (const o of own.filter(x => !x.used)) {
        const day = dayNumber(o.key.date);
        if (day < fromDay - 366 || day > toDay + 366) outside.add(o.event); else counts.orphanOverrides++;
      }
      continue;
    }
    const groups = new Map();
    for (const o of own) { const keys = keysOf(o.key); const id = keys.day ?? keys.at; (groups.get(id) ?? groups.set(id, []).get(id)).push(o); }
    for (const group of groups.values()) emitOverride(newest(group));
  }

  if (total > ICS_LIMITS.occurrences) return fail(`The calendar expands to more than ${ICS_LIMITS.occurrences.toLocaleString('en-US')} events in this date range. Export only this timetable.`);
  const warnings = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const shifted = [...shifts].filter(([, gaps]) => gaps.size > 1).map(([name]) => name);
  if (shifted.length) warnings.push(`This calendar uses ${shifted[0]} time, but the household time zone is ${zone}, so lesson times move by an hour when the clocks change in one and not the other. If the household zone is wrong, change it in household settings and import again.`);
  // A calendar zone whose clock differs from the household's at any time of year, named by a TZID or (Google and
  // Compass, which write UTC times) only by X-WR-TIMEZONE. Lesson times are then shown in household time.
  const year = Number(from.slice(0, 4));
  const offsets = z => [`${year}-01-15`, `${year}-07-15`].map(d => zonedToUtc(d, '12:00:00', z));
  const named = calendarZone && resolveZone(calendarZone);
  const differing = zone && !shifted.length && [...usedZones, named].find(z => z && z !== 'UTC' && z !== zone && offsets(z).some((ms, i) => ms !== offsets(zone)[i]));
  if (differing) warnings.push(`This calendar was made for ${differing} time, but the household time zone is ${zone}; lesson times are shown in household time. If the household zone is wrong, change it in household settings and import again.`);
  if (unknownZones.size) warnings.push(`Unrecognised time zone ${[...unknownZones].slice(0, 3).map(z => `"${z}"`).join(', ')}: those times were read as local times. Check the bell times below.`);
  if (truncated) warnings.push('The file ends partway through an event, so that event was skipped. The download may be incomplete.');
  if (counts.unsupportedRule) warnings.push(`${plural(counts.unsupportedRule, 'repeating event uses', 'repeating events use')} a repeat rule this import does not read (only daily and weekly repeats); only the first occurrence was used.`);
  if (counts.rdate) warnings.push(`${plural(counts.rdate, 'event lists', 'events list')} extra dates (RDATE or EXRULE) that were ignored.`);
  if (counts.capped) warnings.push(`${plural(counts.capped, 'repeating event has', 'repeating events have')} more than ${ICS_LIMITS.perRule} occurrences; only the first ${ICS_LIMITS.perRule} were read.`);
  if (counts.orphanOverrides) warnings.push(`${plural(counts.orphanOverrides, 'changed occurrence does', 'changed occurrences do')} not match any date of ${counts.orphanOverrides === 1 ? 'its' : 'their'} repeating event and ${counts.orphanOverrides === 1 ? 'was' : 'were'} ignored.`);
  if (counts.noEnd) warnings.push(`${plural(counts.noEnd, 'event has', 'events have')} no end time and ${counts.noEnd === 1 ? 'was' : 'were'} skipped.`);
  if (counts.crossesMidnight) warnings.push(`${plural(counts.crossesMidnight, 'event runs', 'events run')} past midnight and ${counts.crossesMidnight === 1 ? 'was' : 'were'} skipped.`);
  if (counts.noLength) warnings.push(`${plural(counts.noLength, 'event starts and ends', 'events start and end')} at the same time (such as a deadline) and ${counts.noLength === 1 ? 'was' : 'were'} skipped.`);
  if (counts.invalid) warnings.push(`${plural(counts.invalid, 'event has', 'events have')} unreadable dates and ${counts.invalid === 1 ? 'was' : 'were'} skipped.`);
  if (outside.size) warnings.push(`${plural(outside.size, 'event has', 'events have')} dates outside ${from} to ${to}; those dates were ignored.`);
  observations.sort((x, y) => x.date.localeCompare(y.date) || x.start_time.localeCompare(y.start_time));
  return { observations, warnings, errors: [] };
}
