import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { overlappingPeriod, validatePeriods } from '../src/logic.js';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const savePeriodSource = html.slice(html.indexOf('async function savePeriod('), html.indexOf('async function deletePeriod('));
// Distinct early slots so none overlaps the 09:00–09:45 period the form saves.
const period = (id, sort_order) => ({
  id, sort_order, timetable_id: 'tt', label: 'Period',
  start_time: `0${6 + sort_order}:00`, end_time: `0${6 + sort_order}:45`, created_by: 'adult',
});

function setup(periods, periodId = '') {
  const guarded = vi.fn(async () => {});
  const context = vm.createContext({
    // Model the data-period attribute emitted by the bell schedule form.
    form: {
      dataset: { period: periodId },
      values: { label: 'Updated period', start_time: '09:00', end_time: '09:45' },
    },
    FormData: class { constructor(form) { return Object.entries(form.values); } },
    crypto: { randomUUID: () => 'new-period' },
    selected: { id: 'tt' }, me: { id: 'adult' },
    T: 'app_timetable__', periods, validatePeriods, overlappingPeriod, guarded,
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

  it('refuses a period that overlaps another, naming it', async () => {
    const clash = { ...period('p9', 9), label: 'Assembly', start_time: '09:30', end_time: '10:00' };
    const { save, guarded } = setup([clash]);
    await expect(save()).rejects.toThrow('Updated period overlaps Assembly (09:30–10:00).');
    expect(guarded).not.toHaveBeenCalled();
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
