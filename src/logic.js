export const MAX_TERM_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86_400_000;

export function dayNumber(value) {
  if (!DATE_RE.test(value ?? '')) throw new Error('Use a YYYY-MM-DD date.');
  const [year, month, day] = value.split('-').map(Number);
  const ms = Date.UTC(year, month - 1, day);
  if (new Date(ms).toISOString().slice(0, 10) !== value) throw new Error('Invalid calendar date.');
  return Math.round(ms / DAY_MS);
}
export function dateFromDay(number) { return new Date(number * DAY_MS).toISOString().slice(0, 10); }
export function daysBetween(a, b) { return dayNumber(b) - dayNumber(a); }
export function addDays(date, count) { return dateFromDay(dayNumber(date) + count); }
export function weekday(date) { return (dayNumber(date) + 3) % 7; } // Mon=0
export function mondayOf(date) { return addDays(date, -weekday(date)); }
export function mod(value, length) { return ((value % length) + length) % length; }
export function validTime(value) { return TIME_RE.test(value ?? ''); }

// Rotation phases count only days that advance the cycle, so pass the exceptions the timetable will have.
export function anchorFromPhase(date, kind, length, phase, exceptions = [], consumes = 0) {
  if (!Number.isInteger(phase) || phase < 0 || phase >= length) throw new Error('Choose a valid cycle phase.');
  if (weekday(date) > 4) throw new Error('Choose a school day.');
  if (kind === 'weekly') return addDays(mondayOf(date), -7 * phase);
  if (kind !== 'day_rotation') throw new Error('Unknown cycle type.');
  const e = exceptionAt(date, exceptions);
  if (e) throw new Error(`${date} is ${e.kind === 'no_school' ? 'a day off' : 'an overridden day'}. Choose an ordinary school day.`);
  // The chosen school date is phase N; count backwards N cycle-advancing days to Day 1.
  const t = { override_consumes_cycle_day: consumes };
  let anchor = date;
  for (let i = 0; i < phase; i++) {
    do { anchor = addDays(anchor, -1); } while (!advances(anchor, t, exceptions));
  }
  return anchor;
}

/** Exceptions that fit a term: holidays clipped to it, day overrides inside it; the rest are dropped. */
export function clipExceptions(exceptions, start, end) {
  return exceptions
    .map(e => (e.kind === 'no_school' ? { ...e, start_date: e.start_date < start ? start : e.start_date, end_date: e.end_date > end ? end : e.end_date } : e))
    .filter(e => e.start_date <= e.end_date && e.start_date >= start && e.end_date <= end);
}

export function validateTimetable(t, exceptions = []) {
  if (!['weekly', 'day_rotation'].includes(t.cycle_kind)) throw new Error('Choose a cycle type.');
  const min = t.cycle_kind === 'weekly' ? 1 : 2;
  const max = t.cycle_kind === 'weekly' ? 4 : 10;
  if (!Number.isInteger(Number(t.cycle_length)) || t.cycle_length < min || t.cycle_length > max) throw new Error('Invalid cycle length.');
  const length = daysBetween(t.start_date, t.end_date) + 1;
  if (length < 1 || length > MAX_TERM_DAYS) throw new Error('A term must span 1–366 days.');
  dayNumber(t.anchor_date);
  if (t.cycle_kind === 'weekly' && weekday(t.anchor_date) !== 0) throw new Error('Week anchor must be Monday.');
  if (t.cycle_kind === 'day_rotation' && weekday(t.anchor_date) > 4) throw new Error('Day 1 anchor must be a school day.');
  if (!String(t.name ?? '').trim()) throw new Error('Give the timetable a name.');
  for (const e of exceptions) {
    if (!['no_school', 'day_override'].includes(e.kind)) throw new Error('Unknown exception type.');
    if (daysBetween(t.start_date, e.start_date) < 0 || daysBetween(e.end_date, t.end_date) < 0 || daysBetween(e.start_date, e.end_date) < 0) throw new Error('Exception dates must be inside the term.');
    if (e.kind === 'day_override') {
      if (e.start_date !== e.end_date || weekday(e.start_date) > 4) throw new Error('Override a single school day.');
      const maxSlot = t.cycle_kind === 'weekly' ? t.cycle_length * 7 : t.cycle_length;
      if (!Number.isInteger(e.override_slot) || e.override_slot < 0 || e.override_slot >= maxSlot || (t.cycle_kind === 'weekly' && e.override_slot % 7 > 4)) throw new Error('Invalid override slot.');
    }
  }
  for (let i = 0; i < exceptions.length; i++) for (let j = i + 1; j < exceptions.length; j++) {
    const a = exceptions[i], b = exceptions[j];
    if (a.start_date <= b.end_date && b.start_date <= a.end_date && (a.kind === 'day_override' || b.kind === 'day_override')) throw new Error('Exceptions conflict on a school date.');
  }
  return length;
}

function exceptionAt(date, exceptions) { return exceptions.find(e => e.start_date <= date && date <= e.end_date); }
function advances(date, t, exceptions) {
  if (weekday(date) > 4) return false;
  const e = exceptionAt(date, exceptions);
  if (e?.kind === 'no_school') return false;
  if (e?.kind === 'day_override' && !t.override_consumes_cycle_day) return false;
  return true;
}
export function rotationIndex(date, t, exceptions) {
  const start = dayNumber(t.anchor_date), target = dayNumber(date);
  let count = 0;
  if (target >= start) for (let n = start; n < target; n++) count += advances(dateFromDay(n), t, exceptions) ? 1 : 0;
  else for (let n = target; n < start; n++) count -= advances(dateFromDay(n), t, exceptions) ? 1 : 0;
  return mod(count, t.cycle_length);
}
export function slotForDate(date, t, exceptions = []) {
  if (weekday(date) > 4) return null;
  const e = exceptionAt(date, exceptions);
  if (e?.kind === 'no_school') return null;
  if (e?.kind === 'day_override') return e.override_slot;
  if (t.cycle_kind === 'day_rotation') return rotationIndex(date, t, exceptions);
  const weeks = Math.floor(daysBetween(t.anchor_date, date) / 7);
  return mod(weeks, t.cycle_length) * 7 + weekday(date);
}
export function projectSchoolDays(t, exceptions = []) {
  const length = validateTimetable(t, exceptions);
  const rows = [];
  for (let i = 0; i < length; i++) {
    const day_date = addDays(t.start_date, i), slot = slotForDate(day_date, t, exceptions);
    if (slot !== null) rows.push({ id: `${t.id}:${day_date}`, timetable_id: t.id, day_date, slot, label: exceptionAt(day_date, exceptions)?.label ?? '', materializer_version: 1 });
  }
  return rows;
}
export function validatePeriods(periods) {
  const ids = new Set(), orders = new Set();
  for (const p of periods) {
    if (ids.has(p.id) || orders.has(Number(p.sort_order))) throw new Error('Periods need unique ids and order.');
    if (!validTime(p.start_time) || !validTime(p.end_time) || p.start_time >= p.end_time) throw new Error('Enter a valid start and end time.');
    ids.add(p.id); orders.add(Number(p.sort_order));
  }
}
// Bell periods may overlap: some days run their own bell times (a late-start Wednesday). Two lessons on the same
// day may not. Checked for the lesson or period being saved (and for a whole import), never on load, so an older
// timetable that breaks the rule stays editable.
export function overlappingPeriod(period, others) {
  return others.find(o => o.id !== period.id && period.start_time < o.end_time && o.start_time < period.end_time) ?? null;
}
/** The lesson on the same day whose period overlaps `period` (other than `lesson` itself), or null. */
export function clashingLesson(lesson, period, lessons, periods) {
  const byId = new Map(periods.map(p => [p.id, p]));
  return lessons.find(o => o.slot === lesson.slot && byId.has(o.period_id) && overlappingPeriod(period, [byId.get(o.period_id)])) ?? null;
}
export function validateDayLessons(lessons, periods) {
  const byId = new Map(periods.map(p => [p.id, p]));
  for (const l of lessons) if (byId.has(l.period_id) && clashingLesson(l, byId.get(l.period_id), lessons, periods)) throw new Error('Two lessons on the same day overlap.');
}
export function validateLessons(lessons, periods, t) {
  validatePeriods(periods);
  const ids = new Set(periods.map(p => p.id)), cells = new Set();
  const maxSlot = t.cycle_kind === 'weekly' ? t.cycle_length * 7 : t.cycle_length;
  for (const l of lessons) {
    if (!ids.has(l.period_id) || l.timetable_id !== t.id) throw new Error('Lesson period belongs to another timetable.');
    if (!Number.isInteger(l.slot) || l.slot < 0 || l.slot >= maxSlot || (t.cycle_kind === 'weekly' && l.slot % 7 > 4)) throw new Error('Lesson uses an invalid cycle slot.');
    const cell = `${l.slot}:${l.period_id}`;
    if (cells.has(cell) || !String(l.subject ?? '').trim()) throw new Error('A period may have only one lesson per day.');
    cells.add(cell);
  }
}
export function columnSlots(t) {
  if (t.cycle_kind === 'day_rotation') return Array.from({length:t.cycle_length},(_,i)=>({slot:i,label:`Day ${i+1}`}));
  return Array.from({length:t.cycle_length},(_,week)=>Array.from({length:5},(_,day)=>({slot:week*7+day,label:`${t.cycle_length===1?'':`Week ${String.fromCharCode(65+week)} · `}${['Mon','Tue','Wed','Thu','Fri'][day]}`}))).flat();
}
