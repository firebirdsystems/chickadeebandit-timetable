// Calendar exports modelled on three portals (plan §10 gate 5): an Arbor-style UK Week A/B file with one
// event per lesson, a Google Calendar copy of a US district feed with "Day N" labels and UTC times, and an
// Outlook file with a Windows zone name, repeat rules and changed occurrences. They are written from knowledge
// of those formats, not collected from schools.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseIcs } from '../src/ics.js';
import { candidateRows, planImportBatches } from '../src/import.js';
import { candidateForFit, checkObservedDays, inferTimetable } from '../src/infer.js';
import { anchorFromPhase, columnSlots, projectSchoolDays } from '../src/logic.js';

function load(name, timezone) {
  const parsed = parseIcs(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'), { timezone, from: '2026-06-01', to: '2027-08-31' });
  const inference = inferTimetable(parsed);
  return { parsed, inference, c: candidateForFit(inference, parsed.observations) };
}
const cell = (c, label, periodIndex) => {
  const slot = columnSlots(c).find(s => s.label === label).slot;
  const lesson = c.lessons.find(l => l.slot === slot && l.period_key === c.periods[periodIndex].key);
  return lesson && [lesson.subject, lesson.room, lesson.teacher, lesson.notes];
};
// Saves as the review would by default: calendar term and phase, with the chosen suggested holidays ticked.
function saved(c, ticked) {
  const exceptions = ticked.map(i => ({ ...c.ics.holidays[i], kind: 'no_school', override_slot: null }));
  const t = { id: 'tt', name: 'School', cycle_kind: c.cycle_kind, cycle_length: c.cycle_length, start_date: c.ics.coverage.first, end_date: c.ics.coverage.last,
    override_consumes_cycle_day: 0, revision: 0 };
  t.anchor_date = anchorFromPhase(c.ics.phase.date, c.cycle_kind, c.cycle_length, c.ics.phase.phase - 1, exceptions);
  let n = 0;
  const rows = candidateRows(c, t, 'adult', () => `id-${n++}`);
  expect(projectSchoolDays(t, exceptions).length).toBeGreaterThan(0);
  expect(planImportBatches(t, rows.periods, rows.lessons, exceptions, { prefix: 'app_timetable__', now: 'now' }).batches.length).toBeGreaterThan(0);
  return checkObservedDays(t, exceptions, c.ics.assignments);
}

describe('Arbor-style UK export (Week A/B, Europe/London, one event per lesson)', () => {
  const { parsed, inference, c } = load('uk-arbor-week-ab.ics', 'Europe/London');

  it('infers a two-week cycle with five periods across the October clock change', () => {
    expect(parsed.warnings).toEqual([]);
    expect(inference.fits.map(f => [f.cycle_kind, f.cycle_length, f.agree, f.repeated, f.total])).toEqual([['weekly', 2, 350, 350, 351]]);
    expect(c.errors).toEqual([]);
    expect(c.periods.map(p => p.key)).toEqual(['08:50-09:50', '09:50-10:50', '11:10-12:10', '12:10-13:10', '14:00-15:00']);
    expect(c.lessons).toHaveLength(50);
    expect(c.ics.coverage).toEqual({ first: '2026-09-03', last: '2026-12-18', days: 71, lessons: 351 });
    expect(c.ics.phase).toEqual({ date: '2026-09-03', phase: 1 });
  });

  it('splits the class group into notes and reads the teacher from the description', () => {
    expect(cell(c, 'Week A · Mon', 0)).toEqual(['Maths', 'S12', 'Mr J Okafor', '9X/Ma1']);
    expect(cell(c, 'Week B · Fri', 1)).toEqual(['PE', 'Sports Hall', 'Miss K Brown', '9X/PE1']);
  });

  it('lists the field trip, the room change, half term and the INSET day for review', () => {
    expect(c.ics.unmatched.items).toEqual(['2026-10-07 09:00–15:00 Geography field trip']);
    expect(c.ics.variations.items).toEqual(['Week A · Wed 11:10–12:10: Maths room varies (S12 ×5, S14 ×1).', 'Week A · Wed 14:00–15:00: Maths room varies (S12 ×5, S14 ×1).']);
    expect(c.ics.holidays.map(h => `${h.start_date} ${h.end_date}`)).toEqual(['2026-10-26 2026-10-30', '2026-11-16 2026-11-16']);
  });

  it('saves a timetable that matches every school day, holidays or not (weeks run through holidays)', () => {
    expect(saved(c, [])).toEqual({ checked: 71, mismatched: [] });
    expect(saved(c, [0, 1])).toEqual({ checked: 71, mismatched: [] });
  });

  it('explains a household time zone that disagrees with the calendar, and leaves out the shifted half of the term', () => {
    const { c: utc } = load('uk-arbor-week-ab.ics', 'UTC');
    expect(utc.errors).toEqual([]);
    expect(utc.ics.unmatched.count).toBe(90);
    // Lessons shift an hour together when the clocks change, which is a move, not a change of subject; two slots with a
    // double lesson do not shift symmetrically and are listed as changes.
    expect(utc.ics.subjectChanges.count).toBe(2);
    expect(utc.warnings).toEqual(['This calendar uses Europe/London time, but the household time zone is UTC, so lesson times move by an hour when the clocks change in one and not the other. If the household zone is wrong, change it in household settings and import again.',
      "Lessons at other bell times on 34 days (such as an early dismissal) do not fit that day's usual bell times and are left out."]);
  });
});

describe('Google Calendar copy of a US district feed (6-day rotation, "Day N" labels, UTC times)', () => {
  const { parsed, inference, c } = load('us-google-rotation-markers.ics', 'America/New_York');

  it('infers the six-day rotation from the labels, with seven bells either side of daylight saving', () => {
    expect(parsed.warnings).toEqual([]);
    expect(inference.fits.map(f => [f.cycle_kind, f.cycle_length, f.markerMismatches])).toEqual([['day_rotation', 6, 0]]);
    expect(c.errors).toEqual([]);
    expect(c.periods.map(p => p.key)).toEqual(['08:05-08:52', '08:56-09:43', '09:47-10:34', '10:38-11:25', '12:05-12:52', '12:56-13:43', '13:47-14:34']);
    expect(c.lessons).toHaveLength(42);
  });

  it('drops the school name from rooms and splits the double Biology lab over both periods', () => {
    expect(cell(c, 'Day 1', 0)).toEqual(['Algebra I', '204', 'Nguyen, Linh', '']);
    expect(cell(c, 'Day 1', 2)).toEqual(['Biology', 'Lab 3', 'Nguyen, Linh', '']);
    expect(cell(c, 'Day 1', 3)).toEqual(['Biology', 'Lab 3', 'Nguyen, Linh', '']);
    expect(cell(c, 'Day 6', 6)).toEqual(['Study Hall', 'Library', 'Nguyen, Linh', '']);
  });

  it('leaves out the early-dismissal day and suggests the closures, labelled from the feed', () => {
    expect(c.ics.unmatched.count).toBe(4);
    expect(c.ics.unmatched.items.every(i => i.startsWith('2026-11-25'))).toBe(true);
    expect(c.ics.holidays.map(h => `${h.start_date} ${h.end_date} ${h.label}`)).toEqual([
      "2026-10-12 2026-10-12 No School - Indigenous Peoples' Day", '2026-11-03 2026-11-03 No lessons', '2026-11-26 2026-11-27 Thanksgiving Break',
    ]);
  });

  it('only matches every school day once the closures are ticked', () => {
    const unticked = saved(c, []);
    expect(unticked.checked).toBe(60);
    expect(unticked.mismatched[0]).toBe('2026-10-13');
    expect(saved(c, [0, 1, 2])).toEqual({ checked: 60, mismatched: [] });
  });
});

describe('Outlook export (weekly, Windows zone name, repeat rules, changed occurrences)', () => {
  const { parsed, inference, c } = load('outlook-sydney-weekly.ics', 'Australia/Sydney');

  it('expands the repeat rules into a one-week timetable', () => {
    expect(parsed.warnings).toEqual([]);
    expect(inference.fits.map(f => [f.cycle_kind, f.cycle_length])).toEqual([['weekly', 1]]);
    expect(c.errors).toEqual([]);
    expect(c.periods.map(p => p.key)).toEqual(['09:00-09:55', '10:00-10:55', '11:25-12:20']);
    expect(c.lessons).toHaveLength(15);
    expect(cell(c, 'Tue', 0)).toEqual(['Science, Year 8', 'Lab 2', 'Dr P Rao', '']);
  });

  it('applies the moved lesson and the cancellation, and suggests the excluded public holiday', () => {
    expect(c.ics.variations.items).toEqual(['Wed 09:00–09:55: Mathematics room varies (B12 ×9, Library ×1).']);
    expect(parsed.observations.some(o => o.date === '2026-11-10' && o.subject === 'English')).toBe(false);
    expect(c.ics.holidays).toEqual([{ start_date: '2026-10-26', end_date: '2026-10-26', days: 1, counted: false, label: 'No lessons', ticked: false }]);
    expect(saved(c, [0])).toEqual({ checked: 49, mismatched: [] });
  });
});
