// Form save paths outside the import: a failed setup cleans up its draft, and editing an imported lesson keeps it uncoloured.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as logic from '../src/logic.js';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const source = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));

describe('creating a timetable', () => {
  const setup = ({ batchFails = true, changed = 1 } = {}) => {
    const messages = [];
    const context = vm.createContext({
      ...logic, T: 'app_timetable__', me: { id: 'adult' }, adult: () => true, timetables: [], selected: null, busy: false,
      render: () => {}, confirm: () => true, now: () => 'now', crypto: { randomUUID: () => 'draft-1' },
      starterPeriods: () => [], insertRows: () => [], projectionStatements: () => [],
      db: vi.fn(async () => []), batch: vi.fn(async () => { if (batchFails) throw new Error('Batch failed'); }),
      request: vi.fn(async () => ({ rows: [], changed })), refresh: vi.fn(async () => {}), message: e => messages.push(e.message),
      FormData: class { constructor(form) { return Object.entries(form.values); } },
      form: { values: { student: 'student', name: 'School', cycle_kind: 'weekly', cycle_length: '1', phase: '0', phase_date: '2026-09-14', start_date: '2026-09-14', end_date: '2026-12-18' } },
    });
    vm.runInContext(source('async function createTimetable(', 'function activationStatements('), context);
    return { context, messages, run: () => vm.runInContext('createTimetable(form)', context) };
  };

  it('removes the draft it inserted when setting it up fails, and keeps the typed setup form', async () => {
    const app = setup();
    app.context.submittedForm = 'setup';
    app.context.refresh = vi.fn(async () => { app.context.skippedOnRefresh = app.context.submittedForm; });
    await app.run();
    expect(app.context.skippedOnRefresh).toBeNull();
    expect(app.context.request).toHaveBeenCalledWith({ sql: "DELETE FROM app_timetable__timetables WHERE id = ? AND status = 'draft'", params: ['draft-1'] });
    expect(app.messages).toEqual(['Batch failed']);
  });

  it('says so when the draft could not be removed, and removes nothing after a successful setup', async () => {
    const stuck = setup({ changed: 0 });
    await stuck.run();
    expect(stuck.messages).toEqual(['Batch failed The empty draft School could not be removed; delete it before trying again.']);
    const fine = setup({ batchFails: false });
    await fine.run();
    expect(fine.context.request).not.toHaveBeenCalled();
    expect(fine.messages).toEqual([]);
  });
});

describe('saving through guarded', () => {
  const setup = ({ batchFails = false, refreshFails = false }) => {
    const context = vm.createContext({
      selected: { id: 't', revision: 1 }, canEdit: () => true, busy: false, error: '', now: () => 'now', T: 'app_timetable__', render: () => {},
      batch: vi.fn(async () => { if (batchFails) throw new Error('Stale state claim'); }),
      refresh: vi.fn(async () => { if (refreshFails) context.error = 'Timetable changed while loading.'; }),
    });
    vm.runInContext(source('function updateGuard(', 'function insertRows('), context);
    return context;
  };

  it('reports only a failed save as a failure, not a reload that failed afterwards', async () => {
    expect(await vm.runInContext('guarded([])', setup({}))).toBe(true);
    const reload = setup({ refreshFails: true });
    expect(await vm.runInContext('guarded([])', reload)).toBe(true);
    const stale = setup({ batchFails: true });
    expect(await vm.runInContext('guarded([])', stale)).toBe(false);
    expect(stale.error).toBe('Someone changed this timetable. Refresh and try again.');
  });
});

describe('saving a lesson', () => {
  const setup = existing => {
    const guarded = vi.fn(async () => true);
    const context = vm.createContext({
      ...logic, T: 'app_timetable__', me: { id: 'adult' }, error: '', selected: { id: 't', cycle_kind: 'weekly', cycle_length: 1 },
      cell: { slot: 0, periodId: 'p1' }, periods: [{ id: 'p1', label: 'P1', start_time: '08:30', end_time: '09:20', sort_order: 0 }],
      lessons: existing ? [existing] : [], guarded, dialog: { close: () => {} }, cellError: () => {}, crypto: { randomUUID: () => 'new' },
    });
    vm.runInContext(source('async function saveLesson(', 'async function clearLesson('), context);
    return { guarded, save: v => vm.runInContext(`saveLesson(${JSON.stringify(v)}, 'save')`, context) };
  };
  const imported = { id: 'l1', slot: 0, period_id: 'p1', subject: 'Maths', room: '', teacher: '', color: '', notes: '', created_by: 'adult' };

  it('keeps an imported lesson uncoloured unless the colour is changed', async () => {
    const app = setup(imported);
    await app.save({ subject: 'Maths', room: '12', teacher: '', color: '#607cae', color_set: '', notes: '' });
    expect(app.guarded.mock.calls[0][0][0].params.slice(0, 5)).toEqual(['Maths', '12', '', '', '']);
    await app.save({ subject: 'Maths', room: '12', teacher: '', color: '#aa3300', color_set: '1', notes: '' });
    expect(app.guarded.mock.calls[1][0][0].params[3]).toBe('#aa3300');
  });

  it('refuses a new lesson that overlaps another that day, and moves "next" past cells another lesson covers', async () => {
    const periods = [{ id: 'w1', label: 'Wed 1', start_time: '08:30', end_time: '10:00', sort_order: 2 }, { id: 'p2', label: 'P2', start_time: '09:25', end_time: '10:15', sort_order: 1 },
      { id: 'p1', label: 'P1', start_time: '08:30', end_time: '09:20', sort_order: 0 }];
    const opened = [];
    const context = vm.createContext({
      ...logic, T: 'app_timetable__', me: { id: 'adult' }, error: '', selected: { id: 't', cycle_kind: 'weekly', cycle_length: 1 }, cell: { slot: 2, periodId: 'p1' }, periods,
      lessons: [{ id: 'w', slot: 2, period_id: 'w1', subject: 'Late start', timetable_id: 't' }], guarded: vi.fn(async () => true), dialog: { close: () => {} }, cellError: () => {},
      crypto: { randomUUID: () => 'new' }, openCell: (slot, id) => opened.push([slot, id]),
    });
    vm.runInContext(source('async function saveLesson(', 'async function clearLesson('), context);
    vm.runInContext(source('function periodRows(', 'function openCell('), context);
    await expect(vm.runInContext(`saveLesson(${JSON.stringify({ subject: 'Maths', color: '', notes: '' })}, 'save')`, context)).rejects.toThrow('This overlaps Late start (Wed 1, 08:30–10:00) on this day.');
    expect(context.guarded).not.toHaveBeenCalled();
    // Rows run in time order (P1, Wed 1, P2); on Wednesday, P1 and P2 sit under the late start, so "next" from Tuesday's P2 lands on Wed 1.
    context.cell = { slot: 1, periodId: 'p2' };
    await vm.runInContext(`saveLesson(${JSON.stringify({ subject: 'Art', color: '', notes: '' })}, 'next')`, context);
    expect(opened).toEqual([[2, 'w1']]);
    expect(vm.runInContext('periodRows().map(p => p.id)', context)).toEqual(['p1', 'w1', 'p2']);
    // A cell under two lessons names the earlier one.
    context.lessons = [{ id: 'b', slot: 0, period_id: 'p2', subject: 'Second' }, { id: 'a', slot: 0, period_id: 'p1', subject: 'First' }];
    expect(vm.runInContext("coveredBy(0, periods.find(p => p.id === 'w1')).subject", context)).toBe('First');
  });

  it('gives a new lesson the colour shown', async () => {
    const app = setup(null);
    await app.save({ subject: 'Art', room: '', teacher: '', color: '#607cae', color_set: '', notes: '' });
    expect(app.guarded.mock.calls[0][0][0].params).toContain('#607cae');
  });
});
