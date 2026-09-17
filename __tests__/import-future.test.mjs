// End to end: a calendar is imported and saved with the review's defaults, then the saved timetable's FUTURE dates
// (after the export ends) are compared with the school's real timetable. Inside-the-export checks agree with the
// inference by construction; only dates the calendar did not show can tell a right timetable from a self-consistent
// wrong one.
import { describe, expect, it } from 'vitest';
import { parseIcs } from '../src/ics.js';
import { candidateForFit, inferTimetable } from '../src/infer.js';
import { addDays, anchorFromPhase, clipExceptions, mondayOf, projectSchoolDays, weekday } from '../src/logic.js';

const TODAY = '2026-09-16';
const BELLS = [['08:50', '09:50'], ['09:50', '10:50'], ['11:10', '12:10'], ['12:10', '13:10'], ['14:00', '15:00']];
const range = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const stamp = (date, time) => `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;

/**
 * The school's real days from `start` to `end`: `slotOf(date, n)` gives the slot (n counts school days) or null for
 * a day off, and `lessons(date, slot)` the [period, subject] pairs the student has that day.
 */
function school({ start, end, slotOf, lessons }) {
  const days = new Map();
  let n = 0;
  for (const date of range(start, end)) {
    if (weekday(date) > 4) continue;
    const slot = slotOf(date, n);
    if (slot === null) continue;
    n++;
    days.set(date, { slot, lessons: lessons(date, slot) });
  }
  return days;
}

function calendar(days, { from, to, allDay = [], tzid = 'Europe/London' }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
  let uid = 0;
  for (const [date, { lessons }] of days) {
    if (date < from || date > to) continue;
    for (const [p, subject] of lessons) {
      lines.push('BEGIN:VEVENT', `UID:l${uid++}`, `DTSTART;TZID=${tzid}:${stamp(date, BELLS[p][0])}`, `DTEND;TZID=${tzid}:${stamp(date, BELLS[p][1])}`, `SUMMARY:${subject}`, 'END:VEVENT');
    }
  }
  for (const { date, end = date, subject } of allDay) {
    lines.push('BEGIN:VEVENT', `UID:a${uid++}`, `DTSTART;VALUE=DATE:${date.replaceAll('-', '')}`, `DTEND;VALUE=DATE:${addDays(end, 1).replaceAll('-', '')}`, `SUMMARY:${subject}`, 'END:VEVENT');
  }
  return [...lines, 'END:VCALENDAR'].join('\r\n');
}

// Imports as the review would and saves with its defaults: suggested term, known date and number, default ticks.
function importCalendar(text, { zone = 'Europe/London' } = {}) {
  const parsed = parseIcs(text, { timezone: zone, from: addDays(TODAY, -120), to: addDays(TODAY, 366) });
  const inference = inferTimetable(parsed);
  const c = candidateForFit(inference, parsed.observations, 0);
  if (c.errors.length) return { c };
  const { term, phase, holidays } = c.ics;
  const closed = clipExceptions(holidays.filter(h => h.ticked).flatMap(h => (h.dates ?? [h.start_date]).map(date => ({ kind: 'no_school', start_date: date, end_date: h.dates ? date : h.end_date }))), term.start, term.end);
  const anchor_date = anchorFromPhase(phase.date, c.cycle_kind, c.cycle_length, phase.phase - 1, closed);
  return { c, closed, t: { id: 't', name: 'School', cycle_kind: c.cycle_kind, cycle_length: c.cycle_length, start_date: term.start, end_date: term.end, anchor_date, override_consumes_cycle_day: 0 } };
}

// Dates in [from, to] where the saved timetable (term extended to `to`, with the real later days off added) shows
// different lessons from the school.
function wrongDates({ c, t, closed }, days, from, to, daysOff = []) {
  const start = t.start_date < addDays(to, -365) ? addDays(to, -365) : t.start_date;
  const extended = { ...t, start_date: start, end_date: to };
  const exceptions = clipExceptions([...closed, ...daysOff.map(date => ({ kind: 'no_school', start_date: date, end_date: date }))], start, to);
  const saved = new Map(projectSchoolDays(extended, exceptions).map(r => [r.day_date, r.slot]));
  const shown = slot => c.lessons.filter(l => l.slot === slot).map(l => `${l.period_key} ${l.subject}`).sort().join(', ');
  const wrong = [];
  for (const [date, { lessons }] of days) {
    if (date < from || date > to) continue;
    const real = lessons.map(([p, subject]) => `${BELLS[p][0]}-${BELLS[p][1]} ${subject}`).sort().join(', ');
    if (!saved.has(date) || shown(saved.get(date)) !== real) wrong.push(date);
  }
  return wrong;
}

const weekAB = (date, anchor = '2025-09-01') => (Math.floor((new Date(mondayOf(date)) - new Date(anchor)) / 6048e5) % 2) * 7 + weekday(date);
const grid = (seed, slot) => BELLS.map((_, p) => [p, `Y${seed} S${slot} P${p}`]);

describe('imports saved with the review defaults show the right lessons after the export ends', () => {
  it('uses the new school year when the calendar still holds last summer, however few weeks of it there are', () => {
    const offs = new Set([...range('2026-05-25', '2026-05-29'), ...range('2026-07-23', '2026-09-01'), ...range('2026-10-26', '2026-10-30')]);
    const days = school({ start: '2026-05-18', end: '2026-12-18', slotOf: date => (offs.has(date) ? null : weekAB(date)), lessons: (date, slot) => grid(date < '2026-08-01' ? 1 : 2, slot) });
    for (const to of ['2026-09-25', '2026-10-09', '2026-10-23']) {
      const saved = importCalendar(calendar(days, { from: '2026-05-18', to }));
      expect(saved.c.errors, to).toEqual([]);
      expect(saved.c.warnings, to).toContain('The timetable changed on 2026-09-02: lessons before then follow a different timetable, so only lessons from 2026-09-02 are used.');
      expect(saved.t.start_date, to).toBe('2026-09-02');
      // Three weeks of the new year show Week A's Monday and Tuesday once each: they are filled from that day and listed to check.
      expect(wrongDates(saved, days, addDays(to, 1), '2026-12-18', range('2026-10-26', '2026-10-30')), to).toEqual([]);
      expect(saved.c.warnings.some(w => w.includes('no lessons')), to).toBe(false);
    }
    expect(importCalendar(calendar(days, { from: '2026-05-18', to: '2026-09-25' })).c.ics.seenOnce.map(o => [o.kind, o.ticked, o.text, o.lessons.length])).toEqual([
      ['day', true, 'Week A · Mon: in the calendar only on 2026-09-14, so its 5 lessons are taken from that day.', 5],
      ['day', true, 'Week A · Tue: in the calendar only on 2026-09-15, so its 5 lessons are taken from that day.', 5]]);
    expect(importCalendar(calendar(days, { from: '2026-05-18', to: '2026-10-09' })).c.ics.seenOnce).toEqual([]);
  });

  it('leaves out a subject the student drops and keeps the one that replaces another', () => {
    const offs = new Set(range('2026-12-21', '2027-01-01'));
    const lessons = (date, slot) => grid(1, slot).filter(([p]) => !(slot === 0 && p === 2 && date > '2026-12-18')).map(([p, s]) => (slot === 1 && p === 1 && date > '2026-12-18' ? [p, 'Study'] : [p, s]));
    const days = school({ start: '2026-09-07', end: '2027-03-26', slotOf: date => (offs.has(date) ? null : weekday(date)), lessons });
    const saved = importCalendar(calendar(days, { from: '2026-09-07', to: '2027-02-12' }));
    expect(saved.c.ics.subjectChanges.items).toEqual([
      'Tue 09:50–10:50: Y1 S1 P1 until 2026-12-15, then Study from 2027-01-05; Study is used.',
      'Mon 11:10–12:10: Y1 S0 P2 is not in the calendar after 2026-12-14 (6 later days without it), so it is left out.',
    ]);
    expect(wrongDates(saved, days, '2027-02-15', '2027-03-26')).toEqual([]);
  });

  it('does not turn an event seen twice into a lesson', () => {
    const days = school({ start: '2026-09-07', end: '2026-12-18', slotOf: date => weekday(date), lessons: (date, slot) => grid(1, slot) });
    const text = calendar(days, { from: '2026-09-07', to: '2026-12-18' }).replace('END:VCALENDAR', ['2026-09-22', '2026-11-24'].map((date, k) =>
      ['BEGIN:VEVENT', `UID:pe${k}`, `DTSTART;TZID=Europe/London:${stamp(date, '17:00')}`, `DTEND;TZID=Europe/London:${stamp(date, '19:30')}`, "SUMMARY:Parents' Evening", 'END:VEVENT'].join('\r\n')).join('\r\n') + '\r\nEND:VCALENDAR');
    const saved = importCalendar(text);
    expect(saved.c.periods.map(p => p.key)).not.toContain('17:00-19:30');
    expect(saved.c.ics.unmatched.items).toEqual(["2026-09-22 17:00–19:30 Parents' Evening", "2026-11-24 17:00–19:30 Parents' Evening"]);
  });

  it('lines up a six-day rotation labelled only on Mondays across a counted day without lessons', () => {
    const offs = new Set(['2026-10-12', ...range('2026-11-25', '2026-11-27')]);
    const days = school({ start: '2026-09-01', end: '2027-01-29', slotOf: (date, n) => (offs.has(date) ? null : n % 6), lessons: (date, slot) => (date === '2026-10-01' ? [] : grid(1, slot)) });
    const labels = [...days].filter(([date]) => weekday(date) === 0 && date <= '2026-12-18').map(([date, { slot }]) => ({ date, subject: `Day ${slot + 1}` }));
    const saved = importCalendar(calendar(days, { from: '2026-09-01', to: '2026-12-18', allDay: labels, tzid: 'America/New_York' }), { zone: 'America/New_York' });
    expect(saved.c).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 6 });
    expect(wrongDates(saved, days, '2027-01-04', '2027-01-29')).toEqual([]);
  });

  it('ticks the holidays a weekly calendar names, so no lessons show on them', () => {
    const halfTerm = range('2026-10-26', '2026-10-30');
    const days = school({ start: '2026-09-07', end: '2026-12-18', slotOf: date => (halfTerm.includes(date) ? null : weekAB(date, '2026-09-07')), lessons: (date, slot) => grid(1, slot) });
    const saved = importCalendar(calendar(days, { from: '2026-09-07', to: '2026-12-18', allDay: [{ date: '2026-10-26', end: '2026-10-30', subject: 'Half Term' }] }));
    expect(saved.c.ics.holidays).toMatchObject([{ start_date: '2026-10-26', label: 'Half Term', ticked: true }]);
    const shown = new Set(projectSchoolDays(saved.t, saved.closed).map(r => r.day_date));
    expect(halfTerm.filter(date => shown.has(date))).toEqual([]);
  });

  it('does not read lessons that move to other bell times when the clocks change as a new timetable', () => {
    // Back-to-back hourly lessons from a London calendar in a UTC household: after 25 October every subject sits one
    // bell later than before, which looks like a change of subject at most bells.
    const hourly = [['08:00', '09:00'], ['09:00', '10:00'], ['10:00', '11:00'], ['11:00', '12:00'], ['12:00', '13:00']];
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
    let uid = 0;
    for (const date of range('2026-09-07', '2026-12-18')) {
      if (weekday(date) > 4) continue;
      hourly.forEach(([start, end], p) => lines.push('BEGIN:VEVENT', `UID:h${uid++}`, `DTSTART;TZID=Europe/London:${stamp(date, start)}`, `DTEND;TZID=Europe/London:${stamp(date, end)}`, `SUMMARY:D${weekday(date)} P${p}`, 'END:VEVENT'));
    }
    const { c } = importCalendar([...lines, 'END:VCALENDAR'].join('\r\n'), { zone: 'UTC' });
    // No cycle fits both halves; the review explains the zone instead of importing only the later half as a new timetable.
    expect(c.errors[0]).toMatch(/^No repeating weekly or rotating cycle/);
    expect(c.warnings[0]).toMatch(/^This calendar uses Europe\/London time, but the household time zone is UTC/);
    expect(c.warnings.some(w => w.includes('timetable changed') || w.includes('change subject'))).toBe(false);
  });

  it('suggests the latest year of a calendar longer than a year', () => {
    const days = school({ start: '2026-05-19', end: '2027-07-21', slotOf: date => weekAB(date), lessons: (date, slot) => grid(1, slot) });
    const saved = importCalendar(calendar(days, { from: '2026-05-19', to: '2027-07-21' }));
    expect(saved.c.ics.term).toEqual({ start: '2026-07-21', end: '2027-07-21' });
    expect(saved.c.ics.phase.date >= '2026-07-21').toBe(true);
  });

  it('warns when the calendar zone differs from the household zone, and fills a day seen once from that day', () => {
    const days = school({ start: '2026-09-03', end: '2026-10-01', slotOf: date => (date === '2026-09-28' ? null : weekAB(date, '2026-08-31')), lessons: (date, slot) => grid(1, slot) });
    const saved = importCalendar(calendar(days, { from: '2026-09-03', to: '2026-10-01' }), { zone: 'America/New_York' });
    const { c } = saved;
    expect(c.warnings).toContain('This calendar was made for Europe/London time, but the household time zone is America/New_York; lesson times are shown in household time. If the household zone is wrong, change it in household settings and import again.');
    expect(c.ics.seenOnce.map(o => o.text)).toEqual(['Week A · Mon: in the calendar only on 2026-09-14, so its 5 lessons are taken from that day.']);
    expect(c.lessons.filter(l => l.slot === 0).map(l => l.subject)).toEqual(['Y1 S0 P0', 'Y1 S0 P1', 'Y1 S0 P2', 'Y1 S0 P3', 'Y1 S0 P4']);
    // A calendar's times are explicit: early household times are not a missing "pm".
    expect(c.warnings.some(w => w.includes('add pm'))).toBe(false);
  });
});

describe('lessons seen once', () => {
  const trimmed = (days, keep) => new Map([...days].map(([date, day]) => [date, { ...day, lessons: day.lessons.filter(([p]) => keep(date, day.slot, p)) }]));

  it('does not fill a day seen once when it holds only an event, or too few lessons for a school day, and names it', () => {
    const days = school({ start: '2026-09-03', end: '2026-10-01', slotOf: date => (date === '2026-09-28' ? null : weekAB(date, '2026-08-31')), lessons: (date, slot) => grid(1, slot) });
    const oneEvent = trimmed(days, (date, slot, p) => slot !== 0 || p === 2);
    const { c } = importCalendar(calendar(oneEvent, { from: '2026-09-03', to: '2026-10-01' }));
    expect(c.ics.seenOnce).toEqual([]);
    expect(c.ics.unmatched.items).toEqual(['2026-09-14 11:10–12:10 Y1 S0 P2']);
    expect(c.warnings).toContain('This day has no lessons: Week A · Mon (in the calendar on 2026-09-14). A day seen only once or twice cannot show which events repeat, so its events are listed as left out. Add its lessons after importing, or import a longer calendar.');
    // Two of a usual five lessons is not a school day's worth.
    const twoLessons = trimmed(days, (date, slot, p) => slot !== 0 || p < 2);
    expect(importCalendar(calendar(twoLessons, { from: '2026-09-03', to: '2026-10-01' })).c.ics.seenOnce).toEqual([]);
    // A day seen once whose events are at other times (a trip) is not filled either.
    const trip = new Map([...days].map(([date, day]) => [date, date === '2026-09-14' ? { ...day, lessons: [] } : day]));
    const text = calendar(trip, { from: '2026-09-03', to: '2026-10-01' }).replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:trip1', 'DTSTART;TZID=Europe/London:20260914T083000', 'DTEND;TZID=Europe/London:20260914T120000', 'SUMMARY:Museum trip', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:trip2', 'DTSTART;TZID=Europe/London:20260914T130000', 'DTEND;TZID=Europe/London:20260914T153000', 'SUMMARY:Museum trip', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    expect(importCalendar(text).c.ics.seenOnce).toEqual([]);
    // In a timetable of two lessons a day, one lesson is not a day's worth either.
    const short = trimmed(days, (date, slot, p) => p < 2 && (slot !== 0 || p === 0));
    expect(importCalendar(calendar(short, { from: '2026-09-03', to: '2026-10-01' })).c.ics.seenOnce).toEqual([]);
  });

  it('fills a day seen once through a duplicated event, but not at a bell with two different events', () => {
    const days = school({ start: '2026-09-03', end: '2026-10-01', slotOf: date => (date === '2026-09-28' ? null : weekAB(date, '2026-08-31')), lessons: (date, slot) => grid(1, slot) });
    const extra = subject => calendar(days, { from: '2026-09-03', to: '2026-10-01' }).replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:dup', 'DTSTART;TZID=Europe/London:20260914T085000', 'DTEND;TZID=Europe/London:20260914T095000', `SUMMARY:${subject}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    expect(importCalendar(extra('Y1 S0 P0')).c.lessons.filter(l => l.slot === 0).map(l => l.subject)).toEqual(['Y1 S0 P0', 'Y1 S0 P1', 'Y1 S0 P2', 'Y1 S0 P3', 'Y1 S0 P4']);
    const clash = importCalendar(extra('Assembly')).c;
    expect(clash.ics.seenOnce.map(o => o.text)).toEqual(['Week A · Mon: in the calendar only on 2026-09-14, so its 4 lessons are taken from that day.']);
    expect(clash.lessons.filter(l => l.slot === 0).map(l => l.subject)).toEqual(['Y1 S0 P1', 'Y1 S0 P2', 'Y1 S0 P3', 'Y1 S0 P4']);
  });

  it('does not fill a day seen once whose events overlap each other', () => {
    // Week B Tuesday has a 08:50–10:50 double, so that bell is a usual one; on the Week A Monday seen once, a trip at
    // those times overlaps two lessons.
    const days = school({ start: '2026-09-03', end: '2026-10-01', slotOf: date => (date === '2026-09-28' ? null : weekAB(date, '2026-08-31')), lessons: (date, slot) => grid(1, slot).filter(([p]) => slot !== 8 || p > 1) });
    const event = (date, subject) => ['BEGIN:VEVENT', `UID:${subject}${date}`, `DTSTART;TZID=Europe/London:${date.replaceAll('-', '')}T085000`, `DTEND;TZID=Europe/London:${date.replaceAll('-', '')}T105000`, `SUMMARY:${subject}`, 'END:VEVENT'];
    const text = calendar(days, { from: '2026-09-03', to: '2026-10-01' }).replace('END:VCALENDAR', [...event('2026-09-08', 'Double'), ...event('2026-09-22', 'Double'), ...event('2026-09-14', 'Trip'), 'END:VCALENDAR'].join('\r\n'));
    const { c } = importCalendar(text);
    expect(c.errors).toEqual([]);
    expect(c.lessons.filter(l => l.slot === 8).map(l => [l.period_key, l.subject]).slice(0, 2)).toEqual([['08:50-09:50', 'Double'], ['09:50-10:50', 'Double']]);
    expect(c.ics.seenOnce.filter(o => o.kind === 'day')).toEqual([]);
    expect(c.warnings.some(w => w.startsWith('This day has no lessons: Week A · Mon'))).toBe(true);
  });

  it('does not fill a day seen twice with different lessons each time', () => {
    const days = school({ start: '2026-09-03', end: '2026-10-09', slotOf: date => weekAB(date, '2026-08-31'), lessons: (date, slot) => grid(slot === 0 && date === '2026-09-28' ? 2 : 1, slot) });
    const { c } = importCalendar(calendar(days, { from: '2026-09-03', to: '2026-10-09' }));
    expect(c.ics.seenOnce).toEqual([]);
    expect(c.warnings.some(w => w.startsWith('This day has no lessons: Week A · Mon (in the calendar on 2026-09-14, 2026-09-28)'))).toBe(true);
  });

  it('lists a lesson seen once on its slot\'s last date at a free bell, unticked, and leaves one-offs elsewhere alone', () => {
    const offs = new Set(range('2026-10-26', '2026-10-30'));
    const days = school({ start: '2026-09-07', end: '2027-03-26', slotOf: date => (offs.has(date) ? null : weekday(date)), lessons: (date, slot) => grid(1, slot).filter(([p]) => p < 4 || slot !== 2 || date >= '2026-12-16') });
    const saved = importCalendar(calendar(days, { from: '2026-09-07', to: '2026-12-18' }));
    expect(saved.c.ics.seenOnce.map(o => [o.kind, o.ticked, o.text])).toEqual([
      ['lesson', false, 'Wed 14:00–15:00: Y1 S2 P4 is in the calendar only on 2026-12-16, the last Wed. It may have just started; tick it to add it.']]);
    expect(saved.c.ics.seenOnce[0].lessons).toEqual([{ slot: 2, period_key: '14:00-15:00', subject: 'Y1 S2 P4', room: '', teacher: '', notes: '', ref: 'Wed 14:00–15:00' }]);
    expect(saved.c.lessons.some(l => l.subject === 'Y1 S2 P4')).toBe(false);
    expect(saved.c.ics.unmatched.count).toBe(0);
    // The same lesson a week earlier, then missing on the last Wednesday: a one-off, not listed.
    const earlier = school({ start: '2026-09-07', end: '2026-12-18', slotOf: date => (offs.has(date) ? null : weekday(date)), lessons: (date, slot) => grid(1, slot).filter(([p]) => p < 4 || slot !== 2 || date === '2026-12-09') });
    const one = importCalendar(calendar(earlier, { from: '2026-09-07', to: '2026-12-18' }));
    expect(one.c.ics.seenOnce).toEqual([]);
    expect(one.c.ics.unmatched.items).toEqual(['2026-12-09 14:00–15:00 Y1 S2 P4']);
    // A cover lesson in place of a usual one on the last date is a variation, not a new lesson.
    const cover = school({ start: '2026-09-07', end: '2026-12-18', slotOf: date => (offs.has(date) ? null : weekday(date)), lessons: (date, slot) => grid(1, slot).map(([p, x]) => [p, slot === 2 && p === 1 && date === '2026-12-16' ? 'Cover' : x]) });
    expect(importCalendar(calendar(cover, { from: '2026-09-07', to: '2026-12-18' })).c.ics.seenOnce).toEqual([]);
    // An after-school club on the last Wednesday is not on a bell the school uses.
    const club = calendar(days, { from: '2026-09-07', to: '2026-12-18' }).replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:club', 'DTSTART;TZID=Europe/London:20261216T153000', 'DTEND;TZID=Europe/London:20261216T163000', 'SUMMARY:Chess club', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    expect(importCalendar(club).c.ics.seenOnce.map(o => o.text)).toEqual(['Wed 14:00–15:00: Y1 S2 P4 is in the calendar only on 2026-12-16, the last Wed. It may have just started; tick it to add it.']);
    // Inside a double lesson the slot already has, a one-off at a single bell is not a new lesson.
    const double = school({ start: '2026-09-07', end: '2026-12-18', slotOf: date => (offs.has(date) ? null : weekday(date)), lessons: (date, slot) => (slot === 2 ? [[0, 'A'], [1, 'B'], [2, 'C'], [3, 'Art double']] : grid(1, slot)) });
    const doubleText = calendar(double, { from: '2026-09-07', to: '2026-12-18' }).replace(/DTSTART;TZID=Europe\/London:(\d{8})T121000\r\nDTEND;TZID=Europe\/London:\d{8}T131000\r\nSUMMARY:Art double/g, 'DTSTART;TZID=Europe/London:$1T121000\r\nDTEND;TZID=Europe/London:$1T150000\r\nSUMMARY:Art double')
      .replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:talk', 'DTSTART;TZID=Europe/London:20261216T140000', 'DTEND;TZID=Europe/London:20261216T150000', 'SUMMARY:Careers talk', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    const withDouble = importCalendar(doubleText).c;
    expect(withDouble.lessons.filter(l => l.slot === 2 && l.subject === 'Art double').map(l => l.period_key)).toEqual(['12:10-13:10', '14:00-15:00']);
    expect(withDouble.ics.seenOnce).toEqual([]);
    // Week A/B: a Wednesday seen twice with a lesson new on its last date is listed as a lesson, not filled as a day.
    const ab = school({ start: '2026-09-07', end: '2026-10-02', slotOf: date => weekAB(date, '2026-09-07'), lessons: (date, slot) => grid(1, slot).filter(([p]) => p < 4 || slot !== 2 || date === '2026-09-23') });
    expect(importCalendar(calendar(ab, { from: '2026-09-07', to: '2026-10-02' })).c.ics.seenOnce.map(o => o.text)).toEqual(['Week A · Wed 14:00–15:00: Y1 S2 P4 is in the calendar only on 2026-09-23, the last Week A · Wed. It may have just started; tick it to add it.']);
  });
});

describe('rules for changes do not misfire on ordinary calendars', () => {
  const offs = new Set([...range('2026-10-26', '2026-10-30'), ...range('2026-12-21', '2027-01-01'), ...range('2027-02-15', '2027-02-19')]);
  const oneWeek = date => (offs.has(date) ? null : weekday(date));
  const ab = date => (offs.has(date) ? null : weekAB(date, '2026-09-07'));
  const later = [...offs].filter(date => date > '2026-12-18');
  const WEEK = [['English', 'Maths', 'History', 'Science', 'PE'], ['Maths', 'French', 'English', 'Science', 'Art'], ['Science', 'Science', 'Maths', 'Geography', 'English'],
    ['French', 'English', 'Music', 'Maths', 'History'], ['Maths', 'Geography', 'English', 'RE', 'Computing']];

  it('uses the new subject when it replaces another that the day already had at another time, or when two bells swap', () => {
    const one = school({ start: '2026-09-07', end: '2027-03-26', slotOf: oneWeek, lessons: (date, slot) => WEEK[slot].map((x, p) => [p, slot === 0 && p === 2 && date >= '2027-01-04' ? 'English' : x]) });
    expect(wrongDates(importCalendar(calendar(one, { from: '2026-09-07', to: '2027-02-12' })), one, '2027-02-22', '2027-03-26')).toEqual([]);
    const swap = school({ start: '2026-09-07', end: '2027-07-16', slotOf: oneWeek, lessons: (date, slot) => WEEK[slot].map((x, p) => [p, date >= '2027-01-04' && (p === 0 || p === 2) ? WEEK[slot][2 - p] : x]) });
    for (const to of ['2027-01-22', '2027-03-26']) expect(wrongDates(importCalendar(calendar(swap, { from: '2026-09-07', to })), swap, addDays(to, 3), '2027-07-16'), to).toEqual([]);
  });

  it('keeps the timetable through mock exams and missing lessons at the end of the calendar', () => {
    const truth = school({ start: '2026-09-07', end: '2027-03-26', slotOf: oneWeek, lessons: (date, slot) => grid(1, slot) });
    const mocks = school({ start: '2026-09-07', end: '2026-12-18', slotOf: oneWeek, lessons: (date, slot) => grid(1, slot).map(([p, x]) => (date >= '2026-11-30' && p < 3 ? [p, 'Mock Exam'] : [p, x])) });
    const withMocks = importCalendar(calendar(mocks, { from: '2026-09-07', to: '2026-12-18' }));
    expect(withMocks.c.warnings.some(w => w.includes('timetable changed') || w.includes('change subject'))).toBe(false);
    expect(wrongDates(withMocks, truth, '2027-01-04', '2027-03-26', later)).toEqual([]);
    // Two lessons missing for the last three weeks are kept: three weeks without them is not enough to call them stopped.
    const twoMissing = school({ start: '2026-09-07', end: '2026-12-18', slotOf: oneWeek, lessons: (date, slot) => grid(1, slot).filter(([p]) => !(date >= '2026-11-30' && p === 4 && (slot === 1 || slot === 3))) });
    const shortGap = importCalendar(calendar(twoMissing, { from: '2026-09-07', to: '2026-12-18' }));
    expect(shortGap.c.ics.subjectChanges.items).toEqual([]);
    expect(wrongDates(shortGap, truth, '2027-01-04', '2027-03-26', later)).toEqual([]);
    const missing = school({ start: '2026-09-07', end: '2026-12-18', slotOf: oneWeek, lessons: (date, slot) => grid(1, slot).filter(([p]) => !(date >= '2026-11-23' && p < 2)) });
    const withGap = importCalendar(calendar(missing, { from: '2026-09-07', to: '2026-12-18' }));
    expect(withGap.c.warnings).toContain('10 lessons are missing from about 2026-11-17 to the end of the calendar, as in exams or a trip, so they are kept. If the student has stopped them, clear them after importing.');
    expect(wrongDates(withGap, truth, '2027-01-04', '2027-03-26', later)).toEqual([]);
  });

  it('keeps a lesson that started a few weeks before the end of the calendar, even when seen twice or missed once', () => {
    const days = school({ start: '2026-09-07', end: '2027-03-26', slotOf: oneWeek, lessons: (date, slot) => grid(1, slot).filter(([p]) => p < 4 || date >= '2027-01-04') });
    expect(wrongDates(importCalendar(calendar(days, { from: '2026-09-07', to: '2027-01-22' })), days, '2027-01-25', '2027-03-26', later)).toEqual([]);
    // Week A/B: each new lesson is seen on both of its dates since it started.
    const fortnight = school({ start: '2026-09-07', end: '2027-03-26', slotOf: ab, lessons: (date, slot) => grid(1, slot).filter(([p]) => p < 4 || date >= '2027-01-04') });
    expect(wrongDates(importCalendar(calendar(fortnight, { from: '2026-09-07', to: '2027-01-29' })), fortnight, '2027-02-01', '2027-03-26', later)).toEqual([]);
    // Seen four times in the five weeks since it started (one trip): still a lesson.
    const trip = school({ start: '2026-09-07', end: '2027-03-26', slotOf: oneWeek, lessons: (date, slot) => grid(1, slot).filter(([p]) => p < 4 || (date >= '2027-01-04' && !(date >= '2027-01-18' && date <= '2027-01-22'))) });
    const real = school({ start: '2026-09-07', end: '2027-03-26', slotOf: oneWeek, lessons: (date, slot) => grid(1, slot).filter(([p]) => p < 4 || date >= '2027-01-04') });
    expect(wrongDates(importCalendar(calendar(trip, { from: '2026-09-07', to: '2027-02-05' })), real, '2027-02-08', '2027-03-26', later)).toEqual([]);
  });

  it('follows "Day N" labels past a repeated day, or a mistyped last label, into the future', () => {
    const base = ['2026-09-07', '2026-10-12', ...range('2026-11-25', '2026-11-27')];
    const rotation = repeat => {
      let k = 0;
      return school({ start: '2026-09-01', end: '2027-01-29', slotOf: date => { if (base.includes(date) || (date >= '2026-12-21' && date <= '2027-01-01')) return null; const slot = k % 6; if (date !== repeat) k++; return slot; }, lessons: (date, slot) => grid(1, slot) });
    };
    const imported = (days, label) => importCalendar(calendar(days, { from: '2026-09-01', to: '2026-12-18', tzid: 'America/New_York',
      allDay: [...days].filter(([date]) => date <= '2026-12-18').map(([date, { slot }]) => ({ date, subject: `Day ${label(date, slot) + 1}` })) }), { zone: 'America/New_York' });
    const repeated = rotation('2026-12-09');
    const saved = imported(repeated, (date, slot) => slot);
    expect(saved.c.warnings.some(w => w.startsWith('The calendar\'s "Day N" labels repeat or skip a day on 2026-12-10'))).toBe(true);
    const christmas = range('2026-12-21', '2027-01-01');
    expect(wrongDates(saved, repeated, '2027-01-04', '2027-01-29', christmas)).toEqual([]);
    const plain = rotation(null);
    expect(wrongDates(imported(plain, (date, slot) => (date === '2026-12-18' ? (slot + 2) % 6 : slot)), plain, '2027-01-04', '2027-01-29', christmas)).toEqual([]);
  });
});

describe('a US semester change that no cycle fits across', () => {
  it('finds the new semester near its first week and saves it for the rest of the year', () => {
    const blocks = [['07:45', '09:15'], ['09:25', '10:55'], ['11:35', '13:05'], ['13:15', '14:45']];
    const fall = [['English 10', 'Algebra II', 'Chemistry', 'PE'], ['US History', 'Spanish II', 'Band', 'Art']];
    const spring = [['Geometry', 'English 10', 'Biology', 'Health'], ['World History', 'Spanish II', 'Band', 'Computer Science']];
    const offs = new Set(['2026-09-07', '2026-10-12', '2026-11-11', ...range('2026-11-25', '2026-11-27'), ...range('2026-12-21', '2027-01-01'), '2027-01-18', '2027-02-15', ...range('2027-03-22', '2027-03-26'), '2027-05-31']);
    const days = school({ start: '2026-08-17', end: '2027-06-11', slotOf: (date, n) => (offs.has(date) ? null : n % 2), lessons: (date, slot) => (date >= '2027-01-20' ? spring : fall)[slot].map((x, p) => [p, x]) });
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
    let uid = 0;
    for (const [date, { lessons }] of days) if (date <= '2027-05-28') for (const [p, x] of lessons) lines.push('BEGIN:VEVENT', `UID:u${uid++}`, `DTSTART;TZID=America/Chicago:${stamp(date, blocks[p][0])}`, `DTEND;TZID=America/Chicago:${stamp(date, blocks[p][1])}`, `SUMMARY:${x}`, 'END:VEVENT');
    const { c, t, closed } = importCalendar([...lines, 'END:VCALENDAR'].join('\r\n'), { zone: 'America/Chicago' });
    expect(c).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 2 });
    expect(c.ics.term.start >= '2027-01-18' && c.ics.term.start <= '2027-01-20').toBe(true);
    const saved = new Map(projectSchoolDays({ ...t, end_date: '2027-06-11' }, clipExceptions([...closed, ...[...offs].map(date => ({ kind: 'no_school', start_date: date, end_date: date }))], t.start_date, '2027-06-11')).map(r => [r.day_date, r.slot]));
    const wrong = [...days].filter(([date]) => date > '2027-05-28').filter(([date, { lessons }]) =>
      lessons.map(([p, x]) => `${blocks[p][0]}-${blocks[p][1]} ${x}`).sort().join() !== c.lessons.filter(l => l.slot === saved.get(date)).map(l => `${l.period_key} ${l.subject}`).sort().join());
    expect(wrong).toEqual([]);
  });
});
