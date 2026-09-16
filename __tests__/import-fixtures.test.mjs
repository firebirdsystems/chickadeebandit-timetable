// Realistic school exports (plan §10 gate 5). Each fixture is modelled on what a parent actually
// gets: a SIMS portal copy, a PowerSchool-style CSV, a Google Sheets download and an HTML table
// pasted from a school site. Expectations are what the review screen should show before saving.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BATCH_LIMITS, buildCandidate, candidateRows, parseTimetableText, planImportBatches } from '../src/import.js';
import { columnSlots, projectSchoolDays, anchorFromPhase } from '../src/logic.js';

const load = name => buildCandidate(parseTimetableText(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')));
const cell = (c, label, periodIndex) => {
  const slot = columnSlots(c).find(s => s.label === label).slot;
  const lesson = c.lessons.find(l => l.slot === slot && l.period_key === c.periods[periodIndex].key);
  return lesson && [lesson.subject, lesson.room, lesson.teacher, lesson.notes];
};

// Every fixture must also survive the save path unchanged: rows validate, a term projects, batches fit.
function saves(c) {
  let n = 0;
  const t = { id: 'tt', name: 'School', cycle_kind: c.cycle_kind, cycle_length: c.cycle_length,
    anchor_date: anchorFromPhase('2026-09-14', c.cycle_kind, c.cycle_length, 0), start_date: '2026-09-01', end_date: '2027-07-16', revision: 0 };
  const rows = candidateRows(c, t, 'adult', () => `id-${n++}`);
  expect(projectSchoolDays(t, []).length).toBeGreaterThan(200);
  const { batches } = planImportBatches(t, rows.periods, rows.lessons, [], { prefix: 'app_timetable__', now: 'now' });
  for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(BATCH_LIMITS.statements);
  const inserted = batches.flatMap(b => b.slice(1)).reduce((sum, s) => sum + s.params.length / s.sql.slice(s.sql.indexOf('(') + 1, s.sql.indexOf(')')).split(',').length, 0);
  expect(inserted).toBe(rows.periods.length + rows.lessons.length);
  return rows;
}

describe('UK SIMS portal copy (two-week grid, multi-line cells)', () => {
  const c = load('uk-sims-week-ab.tsv');

  it('reads a two-week cycle with registration and four lessons, skipping break and lunch', () => {
    expect(c.errors).toEqual([]);
    expect(c).toMatchObject({ shape: 'grid', cycle_kind: 'weekly', cycle_length: 2 });
    expect(c.periods.map(p => `${p.label} ${p.key}`)).toEqual([
      'Reg 08:40-08:55', 'P1 08:55-09:55', 'P2 10:15-11:15', 'P3 12:00-13:00', 'P4 13:00-14:00',
    ]);
    expect(c.warnings).toEqual(['Row 66: "Lunch" has no times or lessons, skipped.']);
    expect(c.lessons).toHaveLength(50);
  });

  it('splits subject code, room code and teacher, keeping the class group as a note', () => {
    expect(cell(c, 'Week A · Mon', 1)).toEqual(['Ma', 'S12', 'Mr J Okafor', '9X/Ma2']);
    expect(cell(c, 'Week A · Fri', 1)).toEqual(['PE', 'Sports Hall', 'Miss K Brown', '9X/PE']);
    expect(cell(c, 'Week B · Wed', 1)).toEqual(['Fr', 'M7', 'Mme C Martin', '9X/Fr2']);
    expect(cell(c, 'Week A · Thu', 4)).toEqual(['Co', 'IT2', 'Mr B Wood', '9X/Co1']);
    expect(cell(c, 'Week B · Tue', 0)).toEqual(['9X Reg', '', '', '']);
  });

  it('saves within batch limits', () => { expect(saves(c).lessons).toHaveLength(50); });
});

describe('US PowerSchool-style CSV (six-day rotation, 12-hour times)', () => {
  const c = load('us-rotation-6day.csv');

  it('reads numbered cycle days as a six-day rotation with eight afternoon-correct bells', () => {
    expect(c.errors).toEqual([]);
    expect(c.warnings).toEqual([]);
    expect(c).toMatchObject({ shape: 'long', cycle_kind: 'day_rotation', cycle_length: 6 });
    expect(c.periods.map(p => p.key)).toEqual([
      '08:05-08:52', '08:56-09:43', '09:47-10:34', '10:38-11:25', '11:29-12:04', '12:08-12:55', '12:59-13:46', '13:50-14:37',
    ]);
    expect(c.periods.map(p => p.label)).toEqual(Array.from({ length: 8 }, (_, i) => `Period ${i + 1}`));
  });

  it('keeps "Last, First" teachers and a double lab as two lessons', () => {
    expect(cell(c, 'Day 1', 0)).toEqual(['Algebra I', '204', 'Nguyen, Linh', '']);
    expect(cell(c, 'Day 1', 2)).toEqual(['Biology', 'Lab 3', 'Kaur, Priya', '']);
    expect(cell(c, 'Day 1', 3)).toEqual(['Biology', 'Lab 3', 'Kaur, Priya', '']);
    expect(cell(c, 'Day 6', 7)).toEqual(['Band', 'Music Room', 'Stone, Eli', '']);
    expect(cell(c, 'Day 2', 3)).toBeUndefined();
  });

  it('saves within batch limits', () => { expect(saves(c).lessons).toHaveLength(21); });
});

describe('Google Sheets download (BOM, CRLF, seconds, spacer row)', () => {
  const c = load('google-sheets-week-ab.csv');

  it('reads a week A/B timetable and splits the double science practical', () => {
    expect(c.errors).toEqual([]);
    expect(c).toMatchObject({ shape: 'long', cycle_kind: 'weekly', cycle_length: 2 });
    expect(c.periods.map(p => p.key)).toEqual(['08:45-09:35', '09:40-10:30', '10:50-11:40', '13:30-14:20']);
    expect(c.warnings).toEqual(['6 school days have no lessons in this import.']);
    expect(cell(c, 'Week B · Mon', 0)).toEqual(['Science practical', 'Lab 1', 'Mr Doyle', '']);
    expect(cell(c, 'Week B · Mon', 1)).toEqual(['Science practical', 'Lab 1', 'Mr Doyle', '']);
    expect(cell(c, 'Week A · Tue', 0)).toEqual(['Irish', 'Rm 7', 'Ms Ni Bhriain', '']);
  });

  it('saves within batch limits', () => { expect(saves(c).lessons).toHaveLength(8); });
});

describe('School website table pasted into the textarea', () => {
  const c = load('portal-paste-weekly.tsv');

  it('reads afternoon times without am/pm and says so', () => {
    expect(c.errors).toEqual([]);
    expect(c).toMatchObject({ shape: 'grid', cycle_kind: 'weekly', cycle_length: 1 });
    expect(c.periods.map(p => `${p.label} ${p.key}`)).toEqual([
      'Period 1 08:50-09:40', 'Period 2 09:40-10:30', 'Period 3 10:50-11:40', 'Period 4 11:40-12:30', 'Period 5 13:10-14:00', 'Period 6 14:00-14:50',
    ]);
    expect(c.warnings).toEqual([
      'Row 4: "Recess" has no times or lessons, skipped.',
      'Row 7: "Lunch" has no times or lessons, skipped.',
      'Times from 1:00 to 6:59 without am/pm were read as afternoon. Check the bell times below.',
    ]);
  });

  it('takes rooms from brackets and leaves a merged double lesson as a free period for review', () => {
    expect(cell(c, 'Mon', 0)).toEqual(['Maths', 'Rm 12', '', '']);
    expect(cell(c, 'Wed', 1)).toEqual(['Art', 'Studio', '', '']);
    expect(cell(c, 'Fri', 1)).toEqual(['PE', 'Gym', '', '']);
    expect(cell(c, 'Fri', 4)).toEqual(['Assembly', '', '', '']);
    // The source merged Thursday P1–P2 into one cell; the paste carries no lesson for P2.
    expect(cell(c, 'Thu', 1)).toBeUndefined();
    expect(c.lessons).toHaveLength(29);
  });

  it('saves within batch limits', () => { expect(saves(c).lessons).toHaveLength(29); });
});
