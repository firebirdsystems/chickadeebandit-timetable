// Import pipeline (plan §5): parse → candidate → review → multi-batch draft → activate.
// Pure functions only; index.html owns the DOM, network and ids.
import { validateBellTimes, validateLessons, validatePeriods, validTime } from './logic.js';

// `text` and `notes` match the editor's maxlength on subject/room/teacher/period label and notes.
export const IMPORT_LIMITS = { bytes: 2_000_000, rows: 5_000, periods: 16, text: 80, notes: 500 };
// Batch ceilings enforced by the hub's app database endpoint. `bytes` is UTF-8
// bytes of the serialized statements, leaving headroom under the 256 KiB request.
export const BATCH_LIMITS = { statements: 25, params: 100, bytes: 180_000 };
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_ERRORS = 20;

// ── Delimited text ───────────────────────────────────────────────────────────

/** RFC 4180 rows with the line each row starts on. Detects tab, comma or semicolon. */
export function parseDelimited(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const outside = firstLine.replace(/"[^"]*"/g, '');
  const delimiter = outside.includes('\t') ? '\t'
    : (outside.split(';').length > outside.split(',').length ? ';' : ',');
  const rows = [];
  let row = [], field = '', quoted = false, line = 1, rowLine = 1, i = 0;
  const endRow = () => {
    row.push(field);
    if (row.some(cell => cell.trim())) rows.push({ line: rowLine, cells: row.map(cell => cell.trim()) });
    row = []; field = ''; rowLine = line;
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      if (c === '\n') line++;
      field += c; i++; continue;
    }
    if (c === '"' && !field.trim()) { field = ''; quoted = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && src[i + 1] === '\n') { i++; continue; }
    if (c === '\n') { line++; i++; endRow(); continue; }
    field += c; i++;
  }
  if (quoted) throw new Error(`Row ${rowLine}: a quoted cell is never closed.`);
  if (field || row.length) endRow();
  return { delimiter, rows };
}

// ── Times and day headers ────────────────────────────────────────────────────

// Spreadsheet exports often write "08:30:00"; seconds are accepted and dropped.
const TIME_PART = String.raw`\d{1,2}(?:[:.h]\d{2}(?::\d{2})?)?\s*(?:[ap]\.?\s?m\.?)?`;
const RANGE_RE = new RegExp(String.raw`(${TIME_PART})\s*(?:-|–|—|to)\s*(${TIME_PART})`, 'i');

function clock(raw, meridiem) {
  const m = String(raw ?? '').trim().toLowerCase().match(/^(\d{1,2})(?:[:.h](\d{2})(?::\d{2})?)?\s*([ap])?\.?\s?(?:m\.?)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const ap = m[3] ?? meridiem;
  if (m[2] === undefined && !ap) return null;
  if (ap) {
    if (hour < 1 || hour > 12) return null;
    if (ap === 'p' && hour !== 12) hour += 12;
    if (ap === 'a' && hour === 12) hour = 0;
  }
  const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return validTime(value) ? value : null;
}
const meridiemOf = raw => String(raw).toLowerCase().match(/([ap])\.?\s?m\.?\s*$/)?.[1];

/** "8:30", "08.30", "1:15 pm" → "HH:MM", or null. */
export function normalizeTime(raw) { return clock(raw); }

/** Finds "08:30–09:15" (or "1:00-1:50pm") in text; returns times plus the leftover label. */
export function parseTimeRange(text) {
  const source = String(text ?? '');
  // A false start ("P1 - 08:30…") must not hide a real range later in the text.
  for (let from = 0; from < source.length;) {
    const m = source.slice(from).match(RANGE_RE);
    if (!m) return null;
    const range = rangeFrom(source, m);
    if (range) return range;
    from += m.index + 1;
  }
  return null;
}

function rangeFrom(source, m) {
  const endMeridiem = meridiemOf(m[2]);
  let start = clock(m[1]);
  // "1:00-1:50pm": the start inherits the end's meridiem when that keeps order.
  if (!meridiemOf(m[1]) && endMeridiem) {
    const same = clock(m[1], endMeridiem), other = clock(m[1], endMeridiem === 'p' ? 'a' : 'p');
    const end = clock(m[2]);
    start = same && end && same < end ? same : other && end && other < end ? other : null;
  }
  let end = clock(m[2]), assumedPm = false;
  // Without am/pm anywhere, 1:00–6:59 on a school timetable is a 12-hour afternoon ("1:10-2:00", "12:30-1:15").
  if (start && end && !meridiemOf(m[1]) && !endMeridiem) {
    const early = t => t >= '01:00' && t < '07:00';
    const pm = t => `${Number(t.slice(0, 2)) + 12}${t.slice(2)}`;
    if (early(start)) { start = pm(start); if (early(end)) end = pm(end); assumedPm = true; }
    else if (early(end) && end <= start) { end = pm(end); assumedPm = true; }
  }
  if (!start || !end || start >= end) return null;
  const label = source.replace(m[0], ' ').replace(/[\s()[\]·|,:-]+/g, ' ').trim();
  return { start_time: start, end_time: end, label, ...(assumedPm ? { assumedPm } : {}) };
}

function weekIndex(raw) {
  const m = String(raw ?? '').trim().match(/^(?:week\s*)?([a-d]|[1-4])$/i);
  if (!m) return null;
  return /\d/.test(m[1]) ? Number(m[1]) - 1 : m[1].toLowerCase().charCodeAt(0) - 97;
}

/** "Mon", "Week A Monday", "Mon (B)", "Day 3", "3" → { weekday, week } or { rotationDay }. */
export function parseDayLabel(raw, { allowBareNumber = false } = {}) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  const rotation = text.match(/^(?:day|d)\s*(\d{1,2})$/) ?? (allowBareNumber ? text.match(/^(\d{1,2})$/) : null);
  if (rotation) return { rotationDay: Number(rotation[1]) - 1 };
  const dayMatch = text.match(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/);
  if (!dayMatch) return null;
  const rest = text.replace(dayMatch[0], ' ').replace(/[()[\]·|,:-]/g, ' ').replace(/\s+/g, ' ').trim();
  const week = rest ? weekIndex(rest) : 0;
  if (week === null) return null;
  return { weekday: DAYS.indexOf(dayMatch[1]), week };
}

// ── Recognising the two supported shapes ────────────────────────────────────

const HEADER_FIELDS = [
  ['day', h => ['day', 'weekday', 'dayofweek', 'cycleday', 'rotationday'].includes(h)],
  ['week', h => ['week', 'wk', 'cycleweek', 'weekab', 'timetableweek'].includes(h)],
  ['time', h => ['time', 'times', 'periodtime', 'periodtimes'].includes(h)],
  ['start', h => h.startsWith('start') || ['from', 'begins', 'timestart'].includes(h)],
  ['end', h => h.startsWith('end') || ['to', 'finish', 'finishes', 'timeend'].includes(h)],
  ['subject', h => ['subject', 'subjectname', 'course', 'coursename'].includes(h)],
  // Weak names: a "Lesson" number or "Class" group column is only the subject when nothing better exists.
  ['subject', h => ['class', 'classname', 'lesson'].includes(h), 'weak'],
  ['period', h => ['period', 'periodname', 'block', 'lessonnumber', 'periodnumber'].includes(h)],
  ['room', h => ['room', 'rm', 'location', 'classroom', 'roomnumber'].includes(h)],
  ['teacher', h => ['teacher', 'staff', 'instructor', 'tutor', 'teachername'].includes(h)],
];

function headerMap(cells) {
  const map = {}, used = new Set();
  const names = cells.map(cell => cell.toLowerCase().replace(/[^a-z]/g, ''));
  // Strong names claim columns first, so a weak match never takes a field a later column names exactly.
  for (const strength of [undefined, 'weak']) {
    names.forEach((h, index) => {
      if (used.has(index)) return;
      const hit = HEADER_FIELDS.find(([field, test, s]) => s === strength && map[field] === undefined && test(h));
      if (hit) { map[hit[0]] = index; used.add(index); }
    });
  }
  return map;
}

const TEACHER_RE = /^(mr|mrs|ms|miss|mx|dr|prof|sir|sr|sra|mme|mlle)\.?\s+\S/i;
const ROOM_RE = /^(?:(?:rm|room)\b\.?\s*\S+|(?:lab|hall|gym|studio)\s*\d[\w.-]*)$/i;
// Only after the first part, where a bare "Gym" or "Hall" is the subject: room codes ("S12", "IT2")
// are upper-case; facilities ("Sports Hall", "Music Room") end in a place word.
const ROOM_CODE_RE = /^[A-Z]{1,3}\d{1,3}[A-Z]?$/;
const FACILITY_RE = /\b(?:hall|gym|gymnasium|lab|laboratory|studio|library|field|pool|room)$/i;

/** "Maths Rm 12", "Maths (Rm 12)" or a multi-line portal cell (subject, class group, teacher, room). */
function splitCell(cell) {
  const parts = String(cell).split(/\n|\s+[-–|/]\s+|;\s*|,\s*/).map(p => p.trim()).filter(Boolean);
  const out = { subject: '', room: '', teacher: '', notes: '' };
  const rest = [];
  parts.forEach((part, i) => {
    if (!out.teacher && TEACHER_RE.test(part)) out.teacher = part;
    else if (!out.room && (ROOM_RE.test(part) || (i > 0 && (ROOM_CODE_RE.test(part) || FACILITY_RE.test(part))))) out.room = part;
    else rest.push(part);
  });
  out.subject = rest.shift() ?? '';
  const inline = out.subject.match(/^(.*\S)\s*\(([^()]+)\)$/) ?? out.subject.match(/^(.*\S)\s+((?:rm|room)\.?\s*\S+)$/i);
  if (!out.room && inline) { out.subject = inline[1]; out.room = inline[2]; }
  // A further free part is the room, unless it is a class group code ("9X/Ma2"); the rest is kept as notes.
  if (!out.room && rest.length && !rest[0].includes('/')) out.room = rest.shift();
  out.notes = rest.join(' · ');
  return out;
}

function slotOf(day, line, errors) {
  if (day.rotationDay !== undefined) {
    if (day.rotationDay < 0 || day.rotationDay > 9) { errors.push(`Row ${line}: rotations have Day 1 to Day 10.`); return null; }
    return { slot: day.rotationDay, kind: 'day_rotation' };
  }
  if (day.weekday > 4) { errors.push(`Row ${line}: weekend lessons are not supported.`); return null; }
  return { slot: day.week * 7 + day.weekday, kind: 'weekly' };
}

const NEED_TIMES = 'Add start and end times (or a time like 08:30-09:15); period names alone do not give bell times.';

function parseLong(rows, map) {
  const entries = [], errors = [], warnings = [];
  const lessonRows = rows.slice(1).filter(r => (r.cells[map.subject] ?? '').trim());
  const allNumeric = lessonRows.length > 0 && lessonRows.every(r => /^\d{1,2}$/.test(r.cells[map.day] ?? ''));
  for (const { line, cells } of rows.slice(1)) {
    const at = field => (map[field] === undefined ? '' : cells[map[field]] ?? '');
    const subject = at('subject');
    if (!subject) { warnings.push(`Row ${line}: no subject, skipped.`); continue; }
    let day = parseDayLabel(at('day'), { allowBareNumber: allNumeric });
    if (day && day.weekday !== undefined && map.week !== undefined && at('week')) {
      const week = weekIndex(at('week'));
      if (week === null) { errors.push(`Row ${line}: week "${at('week')}" should be A–D or 1–4.`); continue; }
      day = { ...day, week };
    }
    if (!day) { errors.push(`Row ${line}: day "${at('day')}" is not a weekday or "Day N".`); continue; }
    let range = null;
    if (map.start !== undefined && map.end !== undefined) {
      // One range, so "1:00" + "1:50 PM" reads as 13:00–13:50 like "1:00-1:50pm".
      const both = parseTimeRange(`${at('start')} - ${at('end')}`);
      if (both) range = { ...both, label: '' };
    } else if (map.time !== undefined) range = parseTimeRange(at('time'));
    else if (map.period !== undefined) range = parseTimeRange(at('period'));
    if (!range) {
      errors.push(map.start === undefined && map.time === undefined && !parseTimeRange(at('period'))
        ? `Row ${line}: ${NEED_TIMES}` : `Row ${line}: times are missing or end before they start.`);
      continue;
    }
    const slot = slotOf(day, line, errors);
    if (!slot) continue;
    const label = map.period !== undefined ? (parseTimeRange(at('period'))?.label ?? at('period')) : range.label;
    entries.push({ ...slot, line, start_time: range.start_time, end_time: range.end_time, assumedPm: !!range.assumedPm, label,
      subject, room: at('room'), teacher: at('teacher'), notes: '' });
  }
  return { shape: 'long', entries, errors, warnings };
}

function parseGrid(rows) {
  const [head, ...body] = rows;
  const entries = [], errors = [], warnings = [];
  const columns = head.cells.map((cell, index) => (index === 0 ? null : parseDayLabel(cell)));
  if (columns.slice(1).some((c, i) => !c && head.cells[i + 1])) {
    errors.push(`Row ${head.line}: every column heading must be a weekday (optionally with a week) or "Day N".`);
    return { shape: 'grid', entries, errors, warnings };
  }
  // Headers declare the cycle even where a column is empty ("Day 3" with no lessons).
  const declared = columns.filter(Boolean).map(day => slotOf(day, head.line, [])).filter(Boolean);
  for (const { line, cells } of body) {
    const range = parseTimeRange(cells[0]);
    if (!range && !cells.slice(1).some(Boolean)) { warnings.push(`Row ${line}: "${cells[0]}" has no times or lessons, skipped.`); continue; }
    if (!range) { errors.push(`Row ${line}: "${cells[0]}" — ${NEED_TIMES}`); continue; }
    cells.slice(1).forEach((cell, i) => {
      const day = columns[i + 1];
      if (!cell || !day) return;
      const slot = slotOf(day, line, errors);
      if (!slot) return;
      entries.push({ ...slot, line, start_time: range.start_time, end_time: range.end_time, assumedPm: !!range.assumedPm,
        label: range.label, ...splitCell(cell) });
    });
  }
  return { shape: 'grid', entries, errors, warnings, declared };
}

/** Parses pasted or uploaded CSV/TSV text into slot-addressed entries. */
export function parseTimetableText(text) {
  const size = new TextEncoder().encode(String(text ?? '')).length;
  if (!String(text ?? '').trim()) return { shape: null, entries: [], errors: ['Paste a timetable or choose a file.'], warnings: [] };
  if (size > IMPORT_LIMITS.bytes) return { shape: null, entries: [], errors: ['The file is larger than 2 MB. Export only this timetable.'], warnings: [] };
  let parsed;
  try { parsed = parseDelimited(text); } catch (e) { return { shape: null, entries: [], errors: [e.message], warnings: [] }; }
  const { rows } = parsed;
  if (rows.length > IMPORT_LIMITS.rows) return { shape: null, entries: [], errors: [`More than ${IMPORT_LIMITS.rows} rows. Export only this timetable.`], warnings: [] };
  if (rows.length < 2) return { shape: null, entries: [], errors: ['Include a heading row and at least one lesson.'], warnings: [] };
  const map = headerMap(rows[0].cells);
  if (map.subject !== undefined && map.day !== undefined) return parseLong(rows, map);
  if (rows[0].cells.slice(1).some(cell => parseDayLabel(cell))) return parseGrid(rows);
  return { shape: null, entries: [], errors: ['Could not recognise the layout. Use columns named day, start, end and subject, or a grid with days across the top and times down the side.'], warnings: [] };
}

// ── Candidate ────────────────────────────────────────────────────────────────

const intervalKey = p => `${p.start_time}-${p.end_time}`;
const inside = (inner, outer) => inner.start_time >= outer.start_time && inner.end_time <= outer.end_time;
const overlaps = (a, b) => a.start_time < b.end_time && b.start_time < a.end_time;

/**
 * Turns parsed entries into a cycle, non-overlapping periods and lessons.
 * An interval that exactly spans two or more shorter intervals is a multi-period
 * lesson and fills each of them; any other overlap is a blocking conflict.
 */
export function buildCandidate(parsed) {
  const errors = [...parsed.errors], warnings = [...parsed.warnings];
  const entries = parsed.entries;
  const empty = { cycle_kind: null, cycle_length: 0, periods: [], lessons: [], errors, warnings, shape: parsed.shape };
  if (errors.length) return { ...empty, errors: errors.slice(0, MAX_ERRORS), errorCount: errors.length };
  if (!entries.length) return { ...empty, errors: ['No lessons found.'], errorCount: 1 };
  for (const e of entries) if (!String(e.subject ?? '').trim()) errors.push(`Row ${e.line}: a lesson has a room or teacher but no subject.`);
  for (const e of entries) for (const field of ['subject', 'room', 'teacher', 'label', 'notes']) {
    const max = field === 'notes' ? IMPORT_LIMITS.notes : IMPORT_LIMITS.text;
    if (String(e[field] ?? '').length > max) errors.push(`Row ${e.line}: ${field === 'label' ? 'period name' : field} is longer than ${max} characters.`);
  }
  if (errors.length) return { ...empty, errors: errors.slice(0, MAX_ERRORS), errorCount: errors.length };
  const kinds = new Set(entries.map(e => e.kind));
  if (kinds.size > 1) return { ...empty, errors: ['Use either weekdays or "Day N" labels, not both.'], errorCount: 1 };
  const cycle_kind = [...kinds][0];
  const lengthFor = top => (cycle_kind === 'weekly' ? Math.floor(top / 7) + 1 : Math.max(2, top + 1));
  // The shortest cycle that holds every lesson; declared columns or the review may lengthen it.
  const min_cycle_length = lengthFor(Math.max(...entries.map(e => e.slot)));
  const cycle_length = Math.max(min_cycle_length, ...(parsed.declared ?? []).filter(d => d.kind === cycle_kind).map(d => lengthFor(d.slot)));
  if (cycle_kind === 'weekly' && cycle_length > 4) errors.push('Weekly patterns can repeat over at most 4 weeks.');

  const intervals = [...new Map(entries.map(e => [intervalKey(e), { start_time: e.start_time, end_time: e.end_time }])).values()]
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.end_time.localeCompare(b.end_time));
  const atomic = intervals.filter(i => !intervals.some(o => o !== i && inside(o, i)));
  for (let i = 0; i < atomic.length; i++) for (let j = i + 1; j < atomic.length; j++) {
    if (overlaps(atomic[i], atomic[j])) errors.push(`Lessons at ${intervalKey(atomic[i])} and ${intervalKey(atomic[j])} overlap. Use one bell schedule for every day.`);
  }
  const covers = new Map();
  for (const outer of intervals.filter(i => !atomic.includes(i))) {
    const parts = atomic.filter(a => inside(a, outer));
    const partial = atomic.some(a => overlaps(a, outer) && !inside(a, outer));
    if (partial || parts.length < 2 || parts[0].start_time !== outer.start_time || parts.at(-1).end_time !== outer.end_time) {
      errors.push(`The lesson at ${intervalKey(outer)} does not line up with the other bell times.`);
    } else covers.set(intervalKey(outer), parts.map(intervalKey));
  }
  if (atomic.length > IMPORT_LIMITS.periods) errors.push(`${atomic.length} different bell periods found; the limit is ${IMPORT_LIMITS.periods}.`);

  const labels = new Map();
  for (const e of entries) if (e.label && !covers.has(intervalKey(e))) {
    const key = intervalKey(e);
    labels.set(key, labels.has(key) && labels.get(key) !== e.label ? null : e.label);
  }
  const early = atomic.filter(p => p.start_time < '07:00');
  if (early.length) warnings.push(`Lessons at ${early.map(intervalKey).join(', ')} start before 07:00. If these are afternoon times, add pm and preview again.`);
  if (entries.some(e => e.assumedPm)) warnings.push('Times from 1:00 to 6:59 without am/pm were read as afternoon. Check the bell times below.');
  const periodLabel = (key, n) => { const raw = labels.get(key); return !raw ? `Period ${n}` : /^\d+$/.test(raw) ? `Period ${raw}` : raw; };
  const periods = atomic.map((p, sort_order) => ({ key: intervalKey(p), ...p, sort_order, label: periodLabel(intervalKey(p), sort_order + 1) }));

  const cells = new Map();
  for (const e of entries) {
    for (const period_key of covers.get(intervalKey(e)) ?? [intervalKey(e)]) {
      const lesson = { slot: e.slot, period_key, subject: e.subject, room: e.room ?? '', teacher: e.teacher ?? '', notes: e.notes ?? '', line: e.line };
      const cell = `${e.slot}|${period_key}`;
      const prior = cells.get(cell);
      if (!prior) cells.set(cell, lesson);
      else if (prior.subject !== lesson.subject || prior.room !== lesson.room || prior.teacher !== lesson.teacher || prior.notes !== lesson.notes) {
        errors.push(`Rows ${prior.line} and ${e.line} put different lessons in the same slot and period.`);
      }
    }
  }
  const lessons = [...cells.values()].sort((a, b) => a.slot - b.slot || a.period_key.localeCompare(b.period_key));
  const used = new Set(lessons.map(l => l.slot));
  const days = cycle_kind === 'weekly'
    ? Array.from({ length: cycle_length * 5 }, (_, i) => Math.floor(i / 5) * 7 + (i % 5))
    : Array.from({ length: cycle_length }, (_, i) => i);
  const emptyDays = days.filter(slot => !used.has(slot)).length;
  if (emptyDays) warnings.push(`${emptyDays} school ${emptyDays === 1 ? 'day has' : 'days have'} no lessons in this import.`);
  return { shape: parsed.shape, cycle_kind, cycle_length, min_cycle_length, periods, lessons, errors: errors.slice(0, MAX_ERRORS), errorCount: errors.length, warnings };
}

/** Candidate → table rows for a draft, validated with the editor's own rules. */
export function candidateRows(candidate, timetable, memberId, uuid) {
  const periods = candidate.periods.map(p => ({ id: uuid(), timetable_id: timetable.id, label: p.label,
    start_time: p.start_time, end_time: p.end_time, sort_order: p.sort_order, created_by: memberId }));
  const byKey = new Map(candidate.periods.map((p, i) => [p.key, periods[i].id]));
  const lessons = candidate.lessons.map(l => ({ id: uuid(), timetable_id: timetable.id, slot: l.slot,
    period_id: byKey.get(l.period_key), subject: l.subject, room: l.room, teacher: l.teacher, color: '', notes: l.notes ?? '', created_by: memberId }));
  validatePeriods(periods);
  validateBellTimes(periods);
  validateLessons(lessons, periods, timetable);
  return { cycle_kind: timetable.cycle_kind, periods, lessons };
}

// ── Diff against the timetable being replaced ───────────────────────────────

/** Changes by slot and bell time, plus added/removed bell times and cycle changes. */
export function diffCandidate(candidate, current) {
  const lessonMap = (periods, lessons, keyOf) => {
    const times = new Map(periods.map(p => [keyOf(p), intervalKey(p)]));
    return new Map(lessons.map(l => [`${l.slot}|${times.get(l.period_key ?? l.period_id)}`, l]));
  };
  const before = lessonMap(current.periods, current.lessons, p => p.id);
  const after = lessonMap(candidate.periods, candidate.lessons, p => p.key);
  const lessons = [];
  const describe = l => [l.subject, l.room, l.teacher].filter(Boolean).join(' · ');
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const [slot, time] = key.split('|');
    const b = before.get(key), a = after.get(key);
    if (b && a && describe(b) === describe(a)) continue;
    lessons.push({ slot: Number(slot), time, change: !b ? 'added' : !a ? 'removed' : 'changed', before: b ? describe(b) : '', after: a ? describe(a) : '' });
  }
  lessons.sort((x, y) => x.slot - y.slot || x.time.localeCompare(y.time));
  // Week slots and rotation days are different numbering schemes; matching them would pair unrelated days.
  const kindChanged = current.timetable.cycle_kind !== candidate.cycle_kind;
  const oldTimes = new Set(current.periods.map(intervalKey)), newTimes = new Set(candidate.periods.map(p => p.key));
  return {
    cycleChanged: current.timetable.cycle_kind !== candidate.cycle_kind || Number(current.timetable.cycle_length) !== candidate.cycle_length,
    addedTimes: [...newTimes].filter(t => !oldTimes.has(t)).sort(),
    removedTimes: [...oldTimes].filter(t => !newTimes.has(t)).sort(),
    kindChanged,
    lessonCounts: { before: current.lessons.length, after: candidate.lessons.length },
    lessons: kindChanged ? [] : lessons,
  };
}

// ── Saving ───────────────────────────────────────────────────────────────────

/**
 * Keeps what an import cannot know from the timetable it replaces: a lesson colour for a matching
 * subject, and notes on a lesson that is unchanged (same slot, bell time and subject). Notes are
 * only matched when both use the same cycle kind, since week slots and rotation days differ.
 */
export function carryOver(rows, current) {
  const oldTimes = new Map(current.periods.map(p => [p.id, intervalKey(p)]));
  const newTimes = new Map(rows.periods.map(p => [p.id, intervalKey(p)]));
  const sameKind = current.timetable.cycle_kind === rows.cycle_kind;
  const colours = new Map(), notes = new Map();
  for (const l of current.lessons) {
    if (l.color && !colours.has(l.subject)) colours.set(l.subject, l.color);
    if (l.notes && sameKind) notes.set(`${l.slot}|${oldTimes.get(l.period_id)}|${l.subject}`, l.notes);
  }
  return {
    ...rows,
    lessons: rows.lessons.map(l => ({ ...l, color: l.color || colours.get(l.subject) || '',
      notes: l.notes || notes.get(`${l.slot}|${newTimes.get(l.period_id)}|${l.subject}`) || '' })),
  };
}

const PERIOD_COLUMNS = ['id', 'timetable_id', 'label', 'start_time', 'end_time', 'sort_order', 'created_by'];
const EXCEPTION_COLUMNS = ['id', 'timetable_id', 'start_date', 'end_date', 'kind', 'override_slot', 'label', 'created_by'];
const LESSON_COLUMNS = ['id', 'timetable_id', 'slot', 'period_id', 'subject', 'room', 'teacher', 'color', 'notes', 'created_by'];

function insertStatements(prefix, table, columns, rows, limits) {
  const perStatement = Math.floor(limits.params / columns.length);
  const out = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    out.push({
      sql: `INSERT INTO ${prefix}${table} (${columns.join(',')}) VALUES ${chunk.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}`,
      params: chunk.flatMap(row => columns.map(c => row[c])),
    });
  }
  return out;
}

/**
 * Batches that populate a draft. Each batch leads with a guard that requires the
 * row to still be this draft at the expected revision, so a concurrent edit or
 * activation stops the import instead of mixing with it. Periods precede lessons
 * (composite foreign key); exceptions kept from a replaced timetable follow. Returns the revision the draft has after the last batch.
 */
export function planImportBatches(draft, periods, lessons, exceptions, { prefix, now, limits = BATCH_LIMITS }) {
  const statements = [
    ...insertStatements(prefix, 'periods', PERIOD_COLUMNS, periods, limits),
    ...insertStatements(prefix, 'lessons', LESSON_COLUMNS, lessons, limits),
    ...insertStatements(prefix, 'exceptions', EXCEPTION_COLUMNS, exceptions, limits),
  ];
  const guard = revision => ({
    sql: `UPDATE ${prefix}timetables SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'draft'`,
    params: [now, draft.id, revision], requireChanges: true,
  });
  const encoder = new TextEncoder();
  const bytes = s => encoder.encode(JSON.stringify(s)).length;
  const batches = [];
  let revision = draft.revision, current = null, size = 0;
  for (const statement of statements) {
    if (bytes(statement) + bytes(guard(revision)) > limits.bytes) throw new Error('A single import statement is too large.');
    if (!current || current.length >= limits.statements || size + bytes(statement) > limits.bytes) {
      current = [guard(revision)];
      size = bytes(current[0]);
      batches.push(current);
      revision++;
    }
    current.push(statement);
    size += bytes(statement);
  }
  return { batches, revision };
}

/** Hex SHA-256 of the imported text, for "you imported this before". */
export async function digestText(text, subtle = globalThis.crypto?.subtle) {
  const hash = await subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
