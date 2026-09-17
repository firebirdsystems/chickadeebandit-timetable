import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { clashingLesson, columnSlots, validatePeriods } from '../src/logic.js';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const savePeriodSource = html.slice(html.indexOf('async function savePeriod('), html.indexOf('async function deletePeriod('));
// Distinct early slots so none overlaps the 09:00–09:45 period the form saves.
const period = (id, sort_order) => ({
  id, sort_order, timetable_id: 'tt', label: 'Period',
  start_time: `0${6 + sort_order}:00`, end_time: `0${6 + sort_order}:45`, created_by: 'adult',
});

function setup(periods, periodId = '', lessons = []) {
  const guarded = vi.fn(async () => {});
  const context = vm.createContext({
    // Model the data-period attribute emitted by the bell schedule form.
    form: {
      dataset: { period: periodId },
      values: { label: 'Updated period', start_time: '09:00', end_time: '09:45' },
    },
    FormData: class { constructor(form) { return Object.entries(form.values); } },
    crypto: { randomUUID: () => 'new-period' },
    selected: { id: 'tt', cycle_kind: 'weekly', cycle_length: 1 }, me: { id: 'adult' },
    T: 'app_timetable__', periods, lessons, validatePeriods, clashingLesson, columnSlots, guarded,
  });
  vm.runInContext(savePeriodSource, context);
  return { save: () => vm.runInContext('savePeriod(form)', context), guarded };
}

describe('bell period form saves', () => {
  it('updates an existing period without replacing its identity', async () => {
    expect(html).toContain('data-period="${esc(p.id)}"');
    const { save, guarded } = setup([period('p0', 0)], 'p0');
    await save();
    const [statement] = guarded.mock.calls[0][0];
    expect(statement.sql).toMatch(/^UPDATE app_timetable__periods /);
    expect(statement.params).toEqual(['Updated period', '09:00', '09:45', 'p0', 'tt']);
    expect(statement.requireChanges).toBe(true);
  });

  it('adds a period after a middle period has been removed', async () => {
    const { save, guarded } = setup([period('p0', 0), period('p2', 2)]);
    await save();
    const [statement] = guarded.mock.calls[0][0];
    expect(statement.sql).toMatch(/^INSERT INTO app_timetable__periods /);
    expect(statement.params).toEqual(['new-period', 'tt', 'Updated period', '09:00', '09:45', 3, 'adult']);
  });

  it('starts the first period at order zero', async () => {
    const { save, guarded } = setup([]);
    await save();
    expect(guarded.mock.calls[0][0][0].params[5]).toBe(0);
  });

  it('adds a period that overlaps another, for a day with its own bell times', async () => {
    const other = { ...period('p9', 9), label: 'Wednesday 1', start_time: '09:30', end_time: '10:00' };
    const { save, guarded } = setup([other]);
    await save();
    expect(guarded).toHaveBeenCalledTimes(1);
  });

  it('refuses new times that make a lesson overlap another on its day, naming both, and allows them when the lessons are on different days', async () => {
    const assembly = { ...period('p9', 9), label: 'Assembly', start_time: '09:30', end_time: '10:00' };
    const lesson = (id, slot, period_id, subject) => ({ id, slot, period_id, subject, timetable_id: 'tt' });
    const sameDay = setup([period('p0', 0), assembly], 'p0', [lesson('a', 0, 'p0', 'Maths'), lesson('b', 0, 'p9', 'Hymn practice')]);
    await expect(sameDay.save()).rejects.toThrow('Updated period would overlap Assembly (09:30–10:00) on Mon, which has Hymn practice.');
    expect(sameDay.guarded).not.toHaveBeenCalled();
    const otherDays = setup([period('p0', 0), assembly], 'p0', [lesson('a', 0, 'p0', 'Maths'), lesson('b', 2, 'p9', 'Hymn practice')]);
    await otherDays.save();
    expect(otherDays.guarded).toHaveBeenCalledTimes(1);
  });

  it('still saves an unrelated period when two older periods overlap each other', async () => {
    const older = [
      { ...period('a', 0), start_time: '11:00', end_time: '11:45' },
      { ...period('b', 1), start_time: '11:30', end_time: '12:15' },
    ];
    const { save, guarded } = setup(older);
    await save();
    expect(guarded).toHaveBeenCalledTimes(1);
  });

  it('renames an older period that overlaps another without re-checking unchanged times', async () => {
    const older = [
      { ...period('a', 0), start_time: '09:00', end_time: '09:45' },
      { ...period('b', 1), start_time: '09:30', end_time: '10:15' },
    ];
    const { save, guarded } = setup(older, 'a');
    await save();
    expect(guarded).toHaveBeenCalledTimes(1);
  });
});
