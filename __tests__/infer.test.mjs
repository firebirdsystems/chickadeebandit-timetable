import { describe, expect, it } from 'vitest';
import { candidateForFit, checkObservedDays, inferTimetable, markerOf, suggestedHolidays } from '../src/infer.js';
import { addDays, mondayOf, weekday } from '../src/logic.js';

const BELLS = [['08:30', '09:20'], ['09:25', '10:15']];
const lesson = (date, p, subject, extra = {}) => ({ all_day: false, date, end_date: date, start_time: BELLS[p][0], end_time: BELLS[p][1], subject, room: '', teacher: '', notes: '', ...extra });
const allDay = (date, subject, end_date = date) => ({ all_day: true, date, end_date, start_time: '', end_time: '', subject, room: '', teacher: '', notes: '' });
// Every school day from `start` for `weeks` weeks, skipping `closed`, with lessons from `subjects(date, n)` where n counts school days.
function term({ start = '2026-09-07', weeks = 6, closed = [], subjects }) {
  const out = [];
  let n = 0;
  for (let date = start; date < addDays(start, weeks * 7); date = addDays(date, 1)) {
    if (weekday(date) > 4 || closed.includes(date)) continue;
    subjects(date, n++).forEach((s, p) => { if (s) out.push(lesson(date, p, s)); });
  }
  return out;
}
const infer = observations => inferTimetable({ observations, warnings: [], errors: [] });
const fits = inference => inference.fits.map(f => `${f.cycle_kind} ${f.cycle_length}`);
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

describe('cycle markers', () => {
  it('reads day and week labels, and nothing else', () => {
    expect(markerOf('Day 3')).toEqual({ rotationDay: 2 });
    expect(markerOf('Cycle day 10.')).toEqual({ rotationDay: 9 });
    expect(markerOf('Week B')).toEqual({ week: 1 });
    expect(markerOf('Timetable week 2')).toEqual({ week: 1 });
    for (const title of ['Day 11', 'Day 0', 'Sports day 3', 'Week E', 'Maths']) expect(markerOf(title)).toBeNull();
  });
});

describe('inferring the cycle', () => {
  it('finds a one-week timetable and drops the equivalent 5-day rotation and longer multiples', () => {
    const inference = infer(term({ subjects: date => [`Maths ${DAYS[weekday(date)]}`, 'English'] }));
    expect(inference.errors).toEqual([]);
    expect(fits(inference)).toEqual(['weekly 1']);
  });

  it('finds week A/B, and lists a genuinely different cycle that also fits', () => {
    const ab = infer(term({ subjects: (date, n) => [`${Math.floor(n / 5) % 2 ? 'Art' : 'Maths'} ${DAYS[weekday(date)]}`] }));
    expect(fits(ab)).toEqual(['weekly 2']);
    // Alternating days with five days a week alternate the weeks too: both descriptions fit.
    const alternating = infer(term({ subjects: (_, n) => [n % 2 ? 'Art' : 'Maths'] }));
    expect(fits(alternating)).toEqual(['weekly 2', 'day_rotation 2']);
    const second = candidateForFit(alternating, [], 1);
    expect(second).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 2 });
    expect(second.lessons.map(l => `${l.slot} ${l.subject}`)).toEqual(['0 Maths', '1 Art']);
    // A closed week leaves a 3-week cycle that barely fits; the rotation explaining every lesson comes first.
    const closedWeek = infer(term({ subjects: (_, n) => [n % 2 ? 'Art' : 'Maths'], closed: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'] }));
    expect(fits(closedWeek)).toEqual(['day_rotation 2', 'weekly 3']);
  });

  it('counts a rotation over the days that have lessons, so a closed day does not shift it', () => {
    const observations = term({ weeks: 8, closed: ['2026-09-16', '2026-10-12', '2026-10-13'], subjects: (_, n) => [`Day ${n % 6 + 1} first`, `Day ${n % 6 + 1} second`] });
    const inference = infer(observations);
    expect(fits(inference)).toEqual(['day_rotation 6']);
    const c = candidateForFit(inference, observations);
    expect(c.lessons.filter(l => l.slot === 3).map(l => l.subject)).toEqual(['Day 4 first', 'Day 4 second']);
    expect(c.ics.phase).toEqual({ date: '2026-09-07', phase: 1 });
    expect(c.ics.holidays).toEqual([
      { start_date: '2026-09-16', end_date: '2026-09-16', days: 1, counted: false, label: 'No lessons', ticked: true },
      { start_date: '2026-10-12', end_date: '2026-10-13', days: 2, counted: false, label: 'No lessons', ticked: true },
    ]);
  });

  it('follows "Day N" labels, which count a marked day with no lessons and restart after a school skips a day', () => {
    const observations = [];
    let day = 0;
    for (let date = '2026-09-07'; date < '2026-10-19'; date = addDays(date, 1)) {
      if (weekday(date) > 4) continue;
      observations.push(allDay(date, `Day ${day + 1}`));
      // A trip day keeps its label but has no lessons; the school repeats Day 2 after a snow day on 1 Oct.
      if (date !== '2026-09-22' && date !== '2026-10-01') observations.push(lesson(date, 0, `Lesson ${day + 1}`), lesson(date, 1, `Lab ${day + 1}`));
      if (date !== '2026-10-01') day = (day + 1) % 4;
    }
    const inference = infer(observations);
    expect(fits(inference)).toEqual(['day_rotation 4']);
    const c = candidateForFit(inference, observations);
    expect(c.lessons.filter(l => l.period_key === '08:30-09:20').map(l => l.subject)).toEqual(['Lesson 1', 'Lesson 2', 'Lesson 3', 'Lesson 4']);
    expect(c.ics.unmatched.count).toBe(0);
    expect(c.ics.assignments.find(a => a.date === '2026-09-22')).toEqual({ date: '2026-09-22', slot: 3 });
  });

  it('sets the week from a "Week B" label', () => {
    const observations = [allDay('2026-09-07', 'Week B'), ...term({ subjects: (date, n) => [`${Math.floor(n / 5) % 2 ? 'Art' : 'Maths'} ${DAYS[weekday(date)]}`] })];
    const c = candidateForFit(infer(observations), observations);
    expect(c.ics.phase).toEqual({ date: '2026-09-07', phase: 2 });
    expect(c.lessons.find(l => l.slot === 7).subject).toBe('Maths Mon');
  });

  it('refuses too little evidence, and a timetable with no cycle', () => {
    expect(infer(term({ weeks: 1, subjects: date => [`Maths ${DAYS[weekday(date)]}`] })).errors).toEqual([
      'The calendar has lessons in only 1 week (2026-09-07 to 2026-09-11), not enough to see the timetable repeat. Export at least four weeks, ideally a whole term.',
    ]);
    let seed = 7;
    const random = () => { seed = (seed * 48271) % 2147483647; return ['Maths', 'Art', 'PE', 'Music'][seed % 4]; };
    expect(infer(term({ weeks: 8, subjects: () => [random(), random()] })).errors[0]).toMatch(/^No repeating weekly or rotating cycle matches these lessons \(2026-09-07 to 2026-10-30\); the closest explains \d+% of them/);
    expect(infer([allDay('2026-09-07', 'Day 1')]).errors).toEqual(['No timed lessons found. A school timetable calendar has events with start and end times.']);
  });

  it('warns about weekend, untitled and conflicting labelled events', () => {
    const observations = [...term({ subjects: () => ['Maths'] }), lesson('2026-09-12', 0, 'Saturday club'), lesson('2026-09-14', 1, ''),
      allDay('2026-09-08', 'Day 1'), allDay('2026-09-08', 'Picture day'), allDay('2026-09-08', 'Day 2')];
    expect(infer(observations).warnings).toEqual([
      '1 event has no title and was not used.', '1 event falls on a weekend and was not used.',
      '1 date has two different "Day"/"Week" labels; the first was used.',
    ]);
  });
});

describe('the candidate for a cycle', () => {
  const weekly = term({ weeks: 6, subjects: () => ['Maths', 'English'] });

  it('leaves out one-offs and minority subjects, and uses the most common room and teacher', () => {
    const observations = weekly.map(o => (o.subject === 'Maths' ? { ...o, room: o.date === '2026-09-14' ? 'S14' : 'S12', teacher: o.date === '2026-09-21' ? '' : 'Mr Okafor' } : o));
    observations.push(lesson('2026-09-09', 0, 'Museum trip', { start_time: '09:00', end_time: '15:00' }));
    const swapped = observations.findIndex(o => o.date === '2026-09-16' && o.subject === 'English');
    observations[swapped] = { ...observations[swapped], subject: 'Assembly' };
    const c = candidateForFit(infer(observations), observations);
    expect(c.errors).toEqual([]);
    expect(c.lessons.filter(l => l.slot === 0).map(l => [l.subject, l.room, l.teacher])).toEqual([['Maths', 'S12', 'Mr Okafor'], ['English', '', '']]);
    expect(c.ics.unmatched).toEqual({ count: 2, items: ['2026-09-09 09:00–15:00 Museum trip', '2026-09-16 09:25–10:15 Assembly'] });
    // A teacher missing from one lesson is not a change; a different room is.
    expect(c.ics.variations).toEqual({ count: 1, items: ['Mon 08:30–09:20: Maths room varies (S12 ×5, S14 ×1).'], lessons: 0 });
  });

  it('drops a school name every location shares, and keeps class groups as notes', () => {
    const observations = weekly.map(o => ({ ...o, room: `${o.subject === 'Maths' ? '204' : 'Lab 3'}, Lincoln High School`, notes: o.subject === 'Maths' ? '9X/Ma1' : '' }));
    const c = candidateForFit(infer(observations), observations);
    expect(c.lessons.slice(0, 2).map(l => [l.subject, l.room, l.notes])).toEqual([['Maths', '204', '9X/Ma1'], ['English', 'Lab 3', '']]);
    const mixed = observations.map((o, i) => (i === 0 ? { ...o, room: 'Online' } : o));
    expect(candidateForFit(infer(mixed), mixed).lessons[1].room).toBe('Lab 3, Lincoln High School');
  });

  it('names calendar entries, not rows, when lessons clash', () => {
    const observations = [...weekly, ...weekly.filter(o => o.subject === 'Maths').map(o => ({ ...o, start_time: '08:30', end_time: '10:15', subject: 'Maths double' }))];
    expect(candidateForFit(infer(observations), observations).errors).toContain('Mon 08:30–09:20 and Mon 08:30–10:15 overlap on the same day.');
  });

  it('labels suggested holidays from an all-day event on them, never from a cycle label', () => {
    const observations = [...term({ weeks: 4, closed: ['2026-09-21', '2026-09-22'], subjects: () => ['Maths'] }), allDay('2026-09-21', 'Week B', '2026-09-25'), allDay('2026-09-19', 'Autumn break', '2026-09-22')];
    expect(suggestedHolidays(infer(observations), observations)).toEqual([{ start_date: '2026-09-21', end_date: '2026-09-22', days: 2, counted: false, label: 'Autumn break', ticked: true }]);
    expect(candidateForFit(inferTimetable({ observations: [], warnings: [], errors: ['Bad file'] }), [])).toMatchObject({ errors: ['Bad file'], lessons: [] });
  });
});

describe('checking a timetable against the calendar', () => {
  const observations = term({ weeks: 6, closed: ['2026-09-16'], subjects: (_, n) => [`Day ${n % 3 + 1}`] });
  const c = candidateForFit(infer(observations), observations);
  const t = { id: 't', name: 'T', cycle_kind: 'day_rotation', cycle_length: 3, start_date: '2026-09-07', end_date: '2026-10-16', anchor_date: '2026-09-07', override_consumes_cycle_day: 0 };
  const closed = [{ kind: 'no_school', start_date: '2026-09-16', end_date: '2026-09-16' }];

  it('agrees once the closed day is a holiday, and points at the first wrong day otherwise', () => {
    expect(checkObservedDays(t, closed, c.ics.assignments)).toEqual({ checked: 29, mismatched: [] });
    const unticked = checkObservedDays(t, [], c.ics.assignments);
    expect(unticked.mismatched[0]).toBe('2026-09-17');
    expect(unticked.mismatched).toHaveLength(22);
    expect(checkObservedDays({ ...t, end_date: '2026-09-15' }, [], c.ics.assignments)).toEqual({ checked: 7, mismatched: [] });
  });
});

describe('inference review fixes', () => {
  const weekAB = (differing, weeks = 12) => term({ weeks, subjects: (date, n) => Array.from({ length: 2 }, (_, p) => {
    const week = Math.floor(n / 5) % 2;
    return week && p === 0 && weekday(date) < differing ? `B${weekday(date)}` : `S${weekday(date)}${p}`;
  }) });

  it('keeps Week A/B when only a few lessons differ, and does not split a weekly timetable over a little noise', () => {
    const subtle = weekAB(2);
    const inference = infer(subtle);
    expect(fits(inference)).toEqual(['weekly 2', 'weekly 1']);
    const c = candidateForFit(inference, subtle);
    expect(c.lessons.find(l => l.slot === 7 && l.period_key === '08:30-09:20').subject).toBe('B0');
    const noisy = term({ subjects: date => [`Maths ${DAYS[weekday(date)]}`, 'English'] }).map(o => (['2026-09-07', '2026-09-21'].includes(o.date) && o.subject === 'English' ? { ...o, subject: 'Assembly' } : o));
    expect(fits(infer(noisy))).toEqual(['weekly 1']);
  });

  it('shows how many calendar lessons a saved timetable matches, so a collapsed cycle is visible', () => {
    const subtle = weekAB(2);
    const inference = infer(subtle);
    const t = { id: 't', name: 'T', cycle_kind: 'weekly', start_date: '2026-09-07', end_date: '2026-11-27', anchor_date: '2026-09-07', override_consumes_cycle_day: 0 };
    const two = candidateForFit(inference, subtle, 0), one = candidateForFit(inference, subtle, 1);
    expect(checkObservedDays({ ...t, cycle_length: 2 }, [], two.ics.assignments, { candidate: two, observed: two.ics.observed })).toMatchObject({ lessons: 120, matching: 120, mismatched: [] });
    expect(checkObservedDays({ ...t, cycle_length: 1 }, [], one.ics.assignments, { candidate: one, observed: one.ics.observed })).toMatchObject({ lessons: 120, matching: 108, mismatched: [] });
  });

  it('leaves out early-dismissal bell times instead of refusing the import, but keeps double lessons', () => {
    const observations = term({ weeks: 8, subjects: date => (weekday(date) === 2 ? [] : [`Maths ${DAYS[weekday(date)]}`, `English ${DAYS[weekday(date)]}`]) })
      .map(o => (weekday(o.date) === 4 && ['2026-09-18', '2026-10-02'].includes(o.date) ? { ...o, start_time: o.start_time === '08:30' ? '08:30' : '09:10', end_time: o.start_time === '08:30' ? '09:05' : '09:45' } : o));
    for (let w = 0; w < 8; w++) observations.push(lesson(addDays('2026-09-09', w * 7), 0, 'Lab', { end_time: '10:15' }));
    const c = candidateForFit(infer(observations), observations);
    expect(c.errors).toEqual([]);
    expect(c.periods.map(p => p.key)).toEqual(['08:30-09:20', '09:25-10:15']);
    expect(c.lessons.filter(l => l.subject === 'Lab').map(l => l.period_key)).toEqual(['08:30-09:20', '09:25-10:15']);
    expect(c.warnings).toContain("Lessons at other bell times on 2 days (such as an early dismissal) do not fit that day's usual bell times and are left out.");
    expect(c.ics.unmatched.items.filter(i => i.includes('09:05') || i.includes('09:45'))).toHaveLength(4);
  });

  it('lets a day keep its own bell times only where they clearly outnumber the usual ones on that day', () => {
    // Wednesdays split evenly between their own 09:00 start and the usual 09:30 one: the usual time stays.
    const even = term({ weeks: 10, subjects: date => [`Maths ${DAYS[weekday(date)]}`] })
      .map(o => ({ ...o, start_time: '09:30', end_time: '10:30' }))
      .map(o => (weekday(o.date) === 2 && [1, 1, 0, 0, 1, 0, 1, 0, 0, 1][Math.round((new Date(o.date) - new Date('2026-09-09')) / 6048e5)] ? { ...o, start_time: '09:00', end_time: '10:00' } : o));
    const split = candidateForFit(infer(even), even);
    expect(split).toMatchObject({ cycle_kind: 'weekly', cycle_length: 1 });
    expect(split.lessons.filter(l => l.slot === 2).map(l => l.period_key)).toEqual(['09:30-10:30']);
    expect(split.warnings.some(w => w.startsWith('Lessons at other bell times on '))).toBe(true);
    // Every Wednesday at 09:00: Wednesday keeps its own time.
    const own = even.map(o => (weekday(o.date) === 2 ? { ...o, start_time: '09:00', end_time: '10:00' } : o));
    expect(candidateForFit(infer(own), own).lessons.filter(l => l.slot === 2).map(l => l.period_key)).toEqual(['09:00-10:00']);
  });

  it('accepts a labelled rotation where the school repeats several days', () => {
    const observations = [];
    let day = 0;
    for (let date = '2026-09-07'; date < '2026-11-30'; date = addDays(date, 1)) {
      if (weekday(date) > 4) continue;
      observations.push(allDay(date, `Day ${day + 1}`), lesson(date, 0, `Lesson ${day + 1}`));
      if (!['2026-09-17', '2026-10-06', '2026-10-22', '2026-11-12'].includes(date)) day = (day + 1) % 6;
    }
    const inference = infer(observations);
    expect(fits(inference)).toEqual(['day_rotation 6']);
    expect(inference.fits[0].markerMismatches).toBe(4);
  });

  it('reads a week-long "Week B" label', () => {
    const observations = [allDay('2026-09-07', 'Week B', '2026-09-11'), ...term({ subjects: (date, n) => [`${Math.floor(n / 5) % 2 ? 'Art' : 'Maths'} ${DAYS[weekday(date)]}`] })];
    expect(candidateForFit(infer(observations), observations).ics.phase).toEqual({ date: '2026-09-07', phase: 2 });
  });

  it('reports a subject that changes partway through, and an even split, instead of calling them one-offs', () => {
    const observations = term({ weeks: 10, subjects: date => [date < '2026-10-19' && weekday(date) === 0 ? 'Chemistry' : `Maths ${DAYS[weekday(date)]}`] });
    // Drama and Dance share the Tuesdays all term, in no repeating order.
    observations.push(...observations.filter(o => weekday(o.date) === 1).map((o, k) => lesson(o.date, 1, [0, 1, 3, 6, 8].includes(k) ? 'Drama' : 'Dance')));
    const inference = infer(observations);
    const c = candidateForFit(inference, observations, inference.fits.findIndex(f => f.cycle_kind === 'weekly' && f.cycle_length === 1));
    // The later subject carries on into the future; the change is listed on its own.
    expect(c.ics.subjectChanges.items).toEqual(['Mon 08:30–09:20: Chemistry until 2026-10-12, then Maths Mon from 2026-10-19; Maths Mon is used.']);
    expect(c.lessons.find(l => l.slot === 0).subject).toBe('Maths Mon');
    expect(c.ics.variations.items).toEqual(['Tue 09:25–10:15: Drama and Dance are seen equally often; Drama is used.']);
    expect(c.ics.variations.lessons).toBe(11);
    expect(c.ics.unmatched.count).toBe(0);
  });

  it('asks for more weeks when the calendar is short', () => {
    expect(infer(weekAB(5, 3)).errors).toEqual(['The calendar has lessons in only 3 weeks (2026-09-07 to 2026-09-25), not enough to see the timetable repeat. Export at least four weeks, ideally a whole term.']);
  });

  it('imports a Week A/B cycle that restarts after holidays as a rotation, and refuses one labelled by week', () => {
    const restart = (labels) => {
      const out = [];
      for (const [start, weeks] of [['2026-09-07', 7], ['2026-11-09', 6]]) {
        term({ start, weeks, subjects: (date, n) => [`${Math.floor(n / 5) % 2 ? 'Art' : 'Maths'} ${DAYS[weekday(date)]}`] }).forEach(o => out.push(o));
        if (labels) for (let w = 0; w < weeks; w++) out.push(allDay(addDays(start, w * 7), `Week ${w % 2 ? 'B' : 'A'}`, addDays(start, w * 7 + 4)));
      }
      return labels ? infer(out).errors : out;
    };
    // Without labels it is a 10-day rotation whose count skips the break, which the app can save.
    const plain = restart(false);
    const inference = infer(plain);
    expect(fits(inference)).toEqual(['day_rotation 10']);
    const c = candidateForFit(inference, plain);
    expect(c.warnings).toContain('The lessons follow a 2-week cycle that starts again after holidays, so this is set up as a 10-day rotation that skips the days off: Day 1 is Monday 2026-09-07 and Day 6 the Monday after. With the days off below ticked, the weeks stay in step for these dates only. A new term may start again from Week A: when it does, set its first day as the known date (day 1).');
    expect(c.lessons.find(l => l.slot === 5).subject).toBe('Art Mon');
    // 35 school days then Week A again: the rotation counts 5 of the 10 break weekdays to restart on Day 1.
    expect(c.ics.holidays.map(h => `${h.start_date} ${h.days} ${h.counted}`)).toEqual(['2026-10-26 5 true', '2026-11-02 5 false']);
    const t = { id: 't', name: 'T', cycle_kind: 'day_rotation', cycle_length: 10, start_date: '2026-09-07', end_date: '2026-12-18', anchor_date: '2026-09-07', override_consumes_cycle_day: 0 };
    expect(checkObservedDays(t, [{ kind: 'no_school', start_date: '2026-11-02', end_date: '2026-11-06' }], c.ics.assignments).mismatched).toEqual([]);
    expect(restart(true)).toEqual(["The school's \"Week\" labels start again from Week A after holidays. This app's weekly cycles carry on through holidays, so this calendar cannot be imported as it is. Import one part of the term at a time, or enter the timetable by hand."]);
  });

  it('lists a 5-day rotation beside a weekly cycle when a closed day shows it explains clearly more', () => {
    const observations = term({ weeks: 10, closed: ['2026-11-04'], subjects: (_, n) => [`Day ${n % 5 + 1}`, `Day ${n % 5 + 1} late`] });
    expect(fits(infer(observations))).toEqual(['day_rotation 5', 'weekly 1']);
  });

  it('keeps a shared building name that is not the school', () => {
    const observations = term({ subjects: () => ['Maths', 'English'] }).map(o => ({ ...o, room: `${o.subject === 'Maths' ? 'B1' : 'B2'}, Block B` }));
    expect(candidateForFit(infer(observations), observations).lessons[0].room).toBe('B1, Block B');
  });
});

describe('rotation days without lessons', () => {
  const rotation = ({ weeks = 10, closed = [], counted = [], length = 6 }) => {
    const out = [];
    let n = 0;
    for (let date = '2026-09-07'; date < addDays('2026-09-07', weeks * 7); date = addDays(date, 1)) {
      if (weekday(date) > 4 || closed.includes(date)) continue;
      const day = n++ % length;
      if (!counted.includes(date)) out.push(lesson(date, 0, `Day ${day + 1} first`), lesson(date, 1, `Day ${day + 1} second`));
    }
    return out;
  };

  it('counts an exam day the school kept in the rotation, and skips a closure', () => {
    const observations = rotation({ closed: ['2026-10-12'], counted: ['2026-09-23'] });
    const inference = infer(observations);
    expect(fits(inference)).toEqual(['day_rotation 6']);
    const c = candidateForFit(inference, observations);
    expect(c.ics.unmatched.count).toBe(0);
    expect(c.ics.holidays.map(h => `${h.start_date} ${h.counted}`)).toEqual(['2026-09-23 true', '2026-10-12 false']);
    const t = { id: 't', name: 'T', cycle_kind: 'day_rotation', cycle_length: 6, start_date: '2026-09-07', end_date: '2026-11-13', anchor_date: '2026-09-07', override_consumes_cycle_day: 0 };
    expect(checkObservedDays(t, [{ kind: 'no_school', start_date: '2026-10-12', end_date: '2026-10-12' }], c.ics.assignments).mismatched).toEqual([]);
  });

  it('counts part of a longer break when that lines the lessons up', () => {
    const observations = rotation({ weeks: 12, closed: ['2026-10-26', '2026-10-27', '2026-10-28'], counted: ['2026-10-29', '2026-10-30'] });
    const c = candidateForFit(infer(observations), observations);
    expect(c.ics.holidays.map(h => `${h.start_date} ${h.end_date} ${h.counted}`)).toEqual(['2026-10-26 2026-10-27 true', '2026-10-28 2026-10-30 false']);
    expect(c.ics.unmatched.count).toBe(0);
  });

  it('looks past a stretch too short to choose, and counts nothing when no count is clearly better', () => {
    // A single lesson day between two gaps cannot pick among two counts on its own; the days after it can.
    const observations = rotation({ weeks: 10, counted: ['2026-09-23', '2026-09-25'] });
    const c = candidateForFit(infer(observations), observations);
    expect(c.ics.holidays.map(h => `${h.start_date} ${h.counted}`)).toEqual(['2026-09-23 true', '2026-09-25 true']);
    const t = { id: 't', name: 'T', cycle_kind: 'day_rotation', cycle_length: 6, start_date: '2026-09-07', end_date: '2026-11-13', anchor_date: '2026-09-07', override_consumes_cycle_day: 0 };
    expect(checkObservedDays(t, [], c.ics.assignments).mismatched).toEqual([]);
    // Every day alike: no count lines up more lessons, so nothing is counted.
    const same = term({ weeks: 6, closed: ['2026-09-16'], subjects: () => ['Maths', 'English'] });
    const inference = infer(same);
    const rot = inference.fits.findIndex(f => f.cycle_kind === 'day_rotation');
    if (rot >= 0) expect(candidateForFit(inference, same, rot).ics.holidays.every(h => !h.counted)).toBe(true);
    expect(fits(inference)[0]).toBe('weekly 1');
  });

  it('treats a weekday with no lessons every week as a pattern: no suggestions for a weekly cycle, one row for a rotation', () => {
    const weekly = term({ weeks: 8, subjects: date => (weekday(date) === 2 ? [] : [`Maths ${DAYS[weekday(date)]}`]) });
    const c = candidateForFit(infer(weekly), weekly);
    expect(c).toMatchObject({ cycle_kind: 'weekly', cycle_length: 1 });
    expect(c.ics.holidays).toEqual([]);
    // A rotation that skips Wednesdays (the school does not count them): one ticked-by-default row.
    const skipped = [];
    let n = 0;
    for (let date = '2026-09-07'; date < '2026-11-02'; date = addDays(date, 1)) {
      if (weekday(date) === 2 || weekday(date) > 4) continue;
      skipped.push(lesson(date, 0, `Day ${n++ % 7 + 1}`));
    }
    const r = candidateForFit(infer(skipped), skipped);
    expect(r).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 7 });
    expect(r.ics.holidays).toEqual([{ start_date: '2026-09-09', end_date: '2026-10-28', days: 8, dates: expect.any(Array), counted: false, label: 'No lessons on Wednesdays', ticked: true }]);
  });

  it('lists the Wednesdays one by one when the rotation counts some and skips others', () => {
    const out = [];
    let n = 0;
    for (let date = '2026-09-07'; date < '2026-11-02'; date = addDays(date, 1)) {
      if (weekday(date) > 4) continue;
      // The school counted Wednesdays until October, then stopped.
      const counts = weekday(date) !== 2 || date < '2026-10-01';
      const day = counts ? n++ % 4 : null;
      if (weekday(date) !== 2) out.push(lesson(date, 0, `Day ${day + 1}`), lesson(date, 1, `Day ${day + 1} b`));
    }
    const c = candidateForFit(infer(out), out);
    expect(c.ics.holidays.every(h => !h.dates && h.days === 1)).toBe(true);
    expect(c.ics.holidays.map(h => h.counted)).toEqual([true, true, true, true, false, false, false, false]);
  });

  it('caps the count below the cycle length, so a long break can still realign', () => {
    // Seven-day rotation; an eight-weekday break where the school counted the first day.
    const observations = rotation({ weeks: 14, length: 7, closed: ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21'], counted: ['2026-10-12'] });
    const c = candidateForFit(infer(observations), observations);
    expect(c).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 7 });
    expect(c.ics.holidays.map(h => `${h.start_date} ${h.days} ${h.counted}`)).toEqual(['2026-10-12 1 true', '2026-10-13 7 false']);
  });

  it('counts nothing when two counts line the lessons up equally well', () => {
    // A pattern that repeats every 2 days read as a 4-day rotation: counting 1 or 3 break days fit equally.
    const observations = rotation({ weeks: 8, length: 2, closed: ['2026-10-13', '2026-10-14'], counted: ['2026-10-12'] });
    const inference = infer(observations);
    const four = { ...inference, fits: [{ cycle_kind: 'day_rotation', cycle_length: 4 }] };
    expect(candidateForFit(four, observations).ics.holidays.every(h => !h.counted)).toBe(true);
  });

  it('only treats a weekday as a pattern when it is missing on its own in most weeks', () => {
    // Free Wednesdays plus a half-term week and a Wednesday–Thursday closure: both closures stay whole.
    const closed = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-11-05'];
    const weekly = term({ weeks: 10, closed, subjects: date => (weekday(date) === 2 ? [] : [`Maths ${DAYS[weekday(date)]}`]) });
    expect(candidateForFit(infer(weekly), weekly).ics.holidays.map(h => `${h.start_date} ${h.days}`)).toEqual(['2026-10-19 5', '2026-11-04 2']);
    // Wednesdays missing in 5 of 8 weeks are closures, suggested one by one.
    const some = term({ weeks: 8, subjects: (date) => (weekday(date) === 2 && date < '2026-10-10' ? [] : [`Maths ${DAYS[weekday(date)]}`]) });
    expect(candidateForFit(infer(some), some).ics.holidays.map(h => h.start_date)).toEqual(['2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30', '2026-10-07']);
  });

  it('does not call a genuine 10-day rotation a restarting Week A/B', () => {
    const observations = rotation({ weeks: 10, length: 10, closed: ['2026-09-16', '2026-10-08'] });
    const c = candidateForFit(infer(observations), observations);
    expect(c).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 10 });
    expect(c.warnings.some(w => w.includes('starts again from Week A'))).toBe(false);
  });

  it('reads a part-time student’s rotation as one counted Wednesday row, even where the last stretch is too short to decide', () => {
    // Six-day rotation, three lessons a day, no lessons on Wednesdays (the school counts them), a Monday–Tuesday
    // closure before a counted Wednesday, a Wednesday–Thursday exam break the school counts, term ends on a Thursday.
    const out = [];
    let n = 0;
    for (let date = '2026-09-07'; date < '2026-12-18'; date = addDays(date, 1)) {
      if (weekday(date) > 4 || date === '2026-10-26' || date === '2026-10-27') continue;
      const day = n++ % 6;
      if (weekday(date) === 2 || date === '2026-11-12') continue;
      out.push(lesson(date, 0, `Day ${day + 1} A`), lesson(date, 1, `Day ${day + 1} B`), lesson(date, 0, `Day ${day + 1} C`, { start_time: '10:35', end_time: '11:25' }));
    }
    const c = candidateForFit(infer(out), out);
    expect(c).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 6 });
    expect(c.ics.holidays.map(h => `${h.start_date} ${h.end_date} ${h.counted} ${h.label}`)).toEqual([
      '2026-09-09 2026-12-16 true No lessons on Wednesdays', '2026-10-26 2026-10-27 false No lessons',
      '2026-10-28 2026-10-28 true No lessons', '2026-11-11 2026-11-12 true No lessons',
    ]);
    const t = { id: 't', name: 'T', cycle_kind: 'day_rotation', cycle_length: 6, start_date: '2026-09-07', end_date: '2026-12-17', anchor_date: '2026-09-07', override_consumes_cycle_day: 0 };
    expect(checkObservedDays(t, [{ kind: 'no_school', start_date: '2026-10-26', end_date: '2026-10-27' }], c.ics.assignments, { candidate: c, observed: c.ics.observed }))
      .toMatchObject({ mismatched: [], lessons: 168, matching: 168 });
  });

  it('keeps a Wednesday closed near the end of the calendar unless its weekday is usually counted', () => {
    // counted: school days with no lessons; closed: not school days. The last Wednesday is closed and followed by one lesson day.
    const ending = { closed: ['2026-11-11'] };
    const lastWednesday = c => c.ics.holidays.find(h => h.start_date === '2026-11-11' || h.dates?.includes('2026-11-11'));
    const once = rotation({ weeks: 10, length: 7, counted: ['2026-09-16'], ...ending }).filter(o => o.date <= '2026-11-12');
    expect(lastWednesday(candidateForFit(infer(once), once)).counted).toBe(false);
    // Wednesday–Thursday breaks where only the Wednesday counted are not single-day decisions about Wednesdays.
    const pairs = rotation({ weeks: 10, length: 7, counted: ['2026-09-16', '2026-09-30', '2026-10-14'], closed: ['2026-09-17', '2026-10-01', '2026-10-15', '2026-11-11'] })
      .filter(o => o.date <= '2026-11-12');
    expect(lastWednesday(candidateForFit(infer(pairs), pairs)).counted).toBe(false);
  });

  const saved = (c, end_date) => {
    const exceptions = c.ics.holidays.filter(h => !h.counted).flatMap(h => (h.dates ?? [h.start_date]).map(date => ({ kind: 'no_school', start_date: date, end_date: h.dates ? date : h.end_date })));
    const t = { id: 't', name: 'T', cycle_kind: c.cycle_kind, cycle_length: c.cycle_length, start_date: c.ics.coverage.first, end_date, override_consumes_cycle_day: 0 };
    t.anchor_date = c.ics.phase.date;
    return checkObservedDays(t, exceptions, c.ics.assignments, { candidate: c, observed: c.ics.observed });
  };
  // A seven-day rotation over 22 weeks for a student whose lessons skip some weekdays the school counts.
  const partTime = ({ free, closed = [], length = 7, weeks = 22 }) => {
    const out = [];
    let n = 0;
    for (let date = '2026-09-07'; date < addDays('2026-09-07', weeks * 7); date = addDays(date, 1)) {
      if (weekday(date) > 4 || closed.includes(date)) continue;
      const day = n++ % length;
      if (!free.includes(weekday(date))) out.push(lesson(date, 0, `Day ${day + 1} first`), lesson(date, 1, `Day ${day + 1} second`));
    }
    return out;
  };

  it('counts a usual day off that sits next to a holiday week too short to decide on its own', () => {
    // Fridays free (counted); holiday 11–15 Jan leaves a Monday–Thursday stretch after the Friday 8 Jan.
    const holiday = ['2027-01-11', '2027-01-12', '2027-01-13', '2027-01-14', '2027-01-15'];
    const out = partTime({ free: [4], closed: holiday });
    const c = candidateForFit(infer(out), out);
    expect(c).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 7 });
    expect(c.ics.holidays.find(h => h.start_date === '2027-01-11')).toMatchObject({ end_date: '2027-01-15', counted: false });
    expect(saved(c, '2027-02-04')).toMatchObject({ mismatched: [], lessons: 168, matching: 168 });
  });

  it('reads two counted weekdays off, even with a single lesson day between them', () => {
    for (const length of [6, 9]) {
      const out = partTime({ free: [1, 3], length, weeks: 14 });
      const c = candidateForFit(infer(out), out);
      expect(c).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: length });
      expect(c.ics.holidays.map(h => `${h.label} ${h.counted}`)).toEqual(['No lessons on Tuesdays true', 'No lessons on Thursdays true']);
      expect(saved(c, '2026-12-11')).toMatchObject({ mismatched: [], lessons: 84, matching: 84 });
    }
  });

  it('marks a day the "Day N" labels skip over as counted', () => {
    const out = [];
    let n = 0;
    for (let date = '2026-09-07'; date < '2026-11-14'; date = addDays(date, 1)) {
      if (weekday(date) > 4) continue;
      const day = n++ % 6;
      if (date === '2026-10-14') continue;
      out.push(allDay(date, `Day ${day + 1}`), lesson(date, 0, `Day ${day + 1} first`));
    }
    const inference = infer(out);
    expect(inference.fits.map(f => [f.cycle_kind, f.cycle_length, f.markerMismatches])).toEqual([['day_rotation', 6, 0]]);
    const c = candidateForFit(inference, out);
    expect(c.ics.holidays).toMatchObject([{ start_date: '2026-10-14', counted: true }]);
    expect(saved(c, '2026-11-13')).toMatchObject({ mismatched: [], matching: 49 });
  });
});

describe('inference review cycle 3 fixes', () => {
  // Week A/B that starts again from Week A after every break of a week or more.
  const restarting = ({ first, last, breaks }) => {
    const out = [];
    let base = mondayOf(first);
    for (let date = first; date <= last; date = addDays(date, 1)) {
      if (weekday(date) > 4) continue;
      const pause = breaks.find(([a, b]) => date >= a && date <= b);
      if (pause) { if (addDays(pause[0], 4) <= pause[1]) base = mondayOf(addDays(pause[1], 3)); continue; }
      const week = Math.round((new Date(mondayOf(date)) - new Date(base)) / 6048e5) % 2;
      for (let p = 0; p < 2; p++) out.push(lesson(date, p, `W${week}D${weekday(date)}P${p}`));
    }
    return out;
  };

  it('numbers a restarting Week A/B from Monday the same way however often the candidate is built', () => {
    const observations = restarting({ first: '2025-09-10', last: '2026-02-13', breaks: [['2025-10-27', '2025-10-31'], ['2025-12-22', '2026-01-02']] });
    const inference = infer(observations);
    expect(inference.restartWeeks).toBe(2);
    for (let k = 0; k < 3; k++) {
      const c = candidateForFit(inference, observations, 0);
      expect(c.ics.phase).toEqual({ date: '2025-09-10', phase: 3 });
      expect(c.lessons.find(l => l.slot === 5 && l.period_key === c.periods[0].key).subject).toBe('W1D0P0');
    }
  });

  it('fits a restart after a break even when the calendar ends days later, and explains it beside a weaker weekly fit', () => {
    const breaks = [['2025-10-27', '2025-11-07']];
    const short = infer(restarting({ first: '2025-09-08', last: '2025-11-14', breaks }));
    expect(fits(short)).toEqual(['day_rotation 10']);
    const shorter = infer(restarting({ first: '2025-09-08', last: '2025-11-12', breaks }));
    expect(fits(shorter)).toEqual(['day_rotation 10', 'weekly 2']);
    expect(shorter.restartWeeks).toBe(2);
  });

  it('does not re-align the year on a short last stretch with one changed lesson', () => {
    const TT = [['Math', 'English', 'Science', 'PE', 'Art'], ['English', 'Math', 'History', 'Science', 'Music'], ['Math', 'Science', 'English', 'French', 'PE'],
      ['Science', 'Math', 'English', 'History', 'Art'], ['English', 'History', 'Math', 'PE', 'French'], ['Math', 'English', 'PE', 'Science', 'Music']];
    const at = p => ({ start_time: `${String(8 + p).padStart(2, '0')}:30`, end_time: `${String(9 + p).padStart(2, '0')}:20` });
    for (let startPos = 0; startPos < 6; startPos++) {
      const out = [];
      let n = startPos;
      for (let date = '2026-01-05'; date <= '2026-04-13'; date = addDays(date, 1)) {
        if (weekday(date) > 4 || (date >= '2026-03-30' && date <= '2026-04-10')) continue;
        const day = TT[n++ % 6];
        (date === '2026-04-13' ? [day[1], day[0], ...day.slice(2)] : day).forEach((subject, p) => out.push(lesson(date, 0, subject, at(p))));
      }
      const c = candidateForFit(infer(out), out);
      const slot = date => c.ics.assignments.find(a => a.date === date).slot;
      expect(mod6(slot('2026-04-13') - slot('2026-03-27'))).toBe(1);
      expect(c.ics.holidays.every(h => !h.counted)).toBe(true);
    }
  });

  it('does not call a genuine 10-day rotation a restarting Week A/B when the weekly cycle fits nearly as well', () => {
    const off = new Set(['2025-09-24', '2025-11-10']);
    for (let date = '2025-10-13'; date <= '2025-10-26'; date = addDays(date, 1)) off.add(date);
    const out = [];
    let n = 4;
    for (let date = '2025-09-03'; date < addDays('2025-09-03', 31 * 7); date = addDays(date, 1)) {
      if (weekday(date) > 4 || off.has(date)) continue;
      const day = n++ % 10;
      for (let p = 0; p < 2; p++) out.push(lesson(date, p, `S${day}-${p}`));
    }
    const inference = infer(out);
    expect(fits(inference)).toEqual(['day_rotation 10', 'weekly 2']);
    expect(inference.restartWeeks).toBeNull();
  });

  it('ranks equally explained rotations by the lessons the saved timetable shows', () => {
    // A 5-day rotation for a student with lessons only on Tuesdays and Thursdays; 2- and 3-day rotations explain as many by reading changes.
    const off = new Set(['2026-01-28', '2026-01-29', '2026-01-30', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06', '2026-03-11', '2026-03-12', '2026-03-13']);
    const out = [];
    let n = 0;
    for (let date = '2025-09-02'; date < addDays('2025-09-02', 32 * 7); date = addDays(date, 1)) {
      if (weekday(date) > 4 || off.has(date)) continue;
      if ([1, 3].includes(weekday(date))) for (let p = 0; p < 2; p++) out.push(lesson(date, p, `S${n % 5}-${p}`));
      n++;
    }
    const inference = infer(out);
    expect(fits(inference).slice(0, 3)).toEqual(['day_rotation 5', 'day_rotation 3', 'day_rotation 2']);
    expect(inference.fits.slice(0, 3).map(f => f.shown)).toEqual([120, 76, 24]);
  });
});
const mod6 = n => ((n % 6) + 6) % 6;

describe('rotations labelled on only some days', () => {
  it('only considers counts that can still reach the next "Day N" label', () => {
    // A seeded calendar of look-alike days (few subjects), labels on some dates and counted days without lessons,
    // where the count that lines up best locally cannot reach the next label. Found by comparing with and without the
    // reachability rule; without it two dates are misplaced instead of one.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const bells = [['08:30', '09:20'], ['09:25', '10:15'], ['10:30', '11:20']];
    let observations, truth;
    for (let it = 0; it <= 447; it++) {
      const L = 4 + Math.floor(rnd() * 5), weeks = 6 + Math.floor(rnd() * 6), vocab = 2 + Math.floor(rnd() * 3);
      const table = Array.from({ length: L }, () => bells.map(() => `S${Math.floor(rnd() * vocab)}`));
      const labelRate = rnd() * 0.5, countedRate = rnd() * 0.15;
      observations = []; truth = new Map();
      let n = 0;
      for (let date = '2026-09-07'; date < addDays('2026-09-07', weeks * 7); date = addDays(date, 1)) {
        if (weekday(date) > 4) continue;
        const day = n++ % L;
        truth.set(date, day);
        if (rnd() < labelRate) observations.push(allDay(date, `Day ${day + 1}`));
        if (rnd() < countedRate) continue;
        bells.forEach(([start_time, end_time], p) => observations.push(lesson(date, 0, table[day][p], { start_time, end_time })));
      }
    }
    const inference = infer(observations);
    const c = candidateForFit(inference, observations, inference.fits.findIndex(f => f.cycle_kind === 'day_rotation' && f.cycle_length === 6));
    expect(c.ics.assignments.filter(a => a.slot !== truth.get(a.date))).toHaveLength(1);
  });
});
