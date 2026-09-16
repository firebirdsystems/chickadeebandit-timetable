import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as logic from '../src/logic.js';
import * as importer from '../src/import.js';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const source = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
const TEXT = 'Day,Week,Start,End,Subject\nMon,A,08:30,09:15,Maths\nTue,B,09:20,10:05,Art';
const previous = { id: 'old', member_id: 'student', name: 'Old', status: 'active', revision: 4 };

// Runs saveImport from index.html against mocked db/batch/refresh, without a DOM.
function setup({ batchFails = () => false, deleteFails = false, deleteChanged = 1, active = previous, exceptions = [] } = {}) {
  const calls = [];
  let ids = 0;
  const context = vm.createContext({
    ...logic, ...importer,
    T: 'app_timetable__', DB: '/db', me: { id: 'adult', role: 'adult' }, members: [{ id: 'student', name: 'Sam', role: 'child' }],
    timetables: active ? [active] : [], selected: null, today: '2026-09-14',
    busy: false, importing: false, error: '', importText: TEXT, render: () => {},
    now: () => 'now', crypto: { randomUUID: () => `id-${ids++}` },
    adult: () => true,
    db: vi.fn(async sql => { calls.push({ kind: 'db', sql }); return []; }),
    request: vi.fn(async ({ sql }) => {
      calls.push({ kind: 'db', sql });
      if (deleteFails) throw new Error('delete refused');
      return { rows: [], changed: deleteChanged };
    }),
    batch: vi.fn(async statements => {
      const index = calls.filter(c => c.kind === 'batch').length;
      calls.push({ kind: 'batch', statements });
      if (batchFails(index, statements)) throw new Error('Stale state claim');
    }),
    // Like the real refresh, which always clears busy in its finally block.
    refresh: vi.fn(async () => { context.error = ''; context.busy = false; }),
    FormData: class { constructor(form) { return Object.entries(form.values); } },
    form: { values: { student: 'student', name: 'School', start_date: '2026-09-14', end_date: '2026-12-18', phase_date: '2026-09-14', phase: '1' } },
  });
  context.importReview = {
    text: TEXT, source_kind: 'csv', digest: 'abc123', student: 'student',
    compare: active ? { student: 'student', state: 'ready', timetable: active, periods: [], lessons: [], exceptions } : { student: 'student', state: 'none' },
    candidate: importer.buildCandidate(importer.parseTimetableText(TEXT)),
  };
  for (const [start, end] of [
    ['function insertRows(', 'function addMinutes('],
    ['function activationStatements(', 'async function activateDraft('],
    ['const comparisonReady=', '// Import saves a new draft'],
    ['async function saveImport(', 'function previewGrid('],
  ]) vm.runInContext(source(start, end), context);
  return { context, calls, run: () => vm.runInContext('saveImport(form)', context) };
}

describe('saving an import', () => {
  it('inserts a draft with provenance, populates it, then activates it replacing the old timetable', async () => {
    const app = setup();
    await app.run();
    const [insert, populate, activate] = app.calls;
    expect(insert.kind).toBe('db');
    expect(insert.sql).toMatch(/^INSERT INTO app_timetable__timetables \(.*source_kind,source_digest\)/);
    expect(populate.statements[0].sql).toMatch(/AND status = 'draft'$/);
    expect(populate.statements.slice(1).map(s => s.sql.split(' (')[0])).toEqual(['INSERT INTO app_timetable__periods', 'INSERT INTO app_timetable__lessons']);
    expect(activate.statements[0]).toMatchObject({ params: ['now', 'old', 4], requireChanges: true });
    expect(activate.statements[0].sql).toMatch(/status = 'archived'/);
    expect(activate.statements[1]).toMatchObject({ params: ['now', 'id-0', 1], requireChanges: true });
    expect(activate.statements.at(-1).sql).toMatch(/INSERT INTO app_timetable__school_days/);
    expect(app.context.importReview).toBeNull();
    expect(app.context.refresh).toHaveBeenCalledWith('id-0');
  });

  it('discards the draft when population fails', async () => {
    const app = setup({ batchFails: index => index === 0 });
    await app.run();
    expect(app.calls.at(-1)).toMatchObject({ kind: 'db', sql: expect.stringMatching(/^DELETE FROM app_timetable__timetables WHERE id = \? AND status = 'draft'/) });
    expect(app.context.error).toMatch(/nothing was saved/);
    expect(app.context.importReview).not.toBeNull();
    expect(app.context.importReview.values).toMatchObject({ name: 'School', start_date: '2026-09-14', phase: '1' });
  });

  it('says an incomplete draft remains when the discard also fails', async () => {
    const app = setup({ batchFails: index => index === 0, deleteFails: true });
    await app.run();
    expect(app.context.error).toMatch(/incomplete timetable School could not be removed/);
  });

  it('does not claim nothing was saved when the draft was no longer a draft to delete', async () => {
    const app = setup({ batchFails: index => index === 0, deleteChanged: 0 });
    await app.run();
    expect(app.context.error).not.toMatch(/nothing was saved/);
    expect(app.context.error).toMatch(/could not be removed, possibly because someone opened or activated it/);
  });

  it('refuses to start while another save is running', async () => {
    const app = setup();
    app.context.busy = true;
    await expect(app.run()).rejects.toThrow(/Wait for the current save/);
    expect(app.calls).toEqual([]);
  });

  it('saves the cycle length chosen on review, within what the lessons need', async () => {
    const app = setup();
    app.context.importReview.candidate = { ...app.context.importReview.candidate, min_cycle_length: 2, cycle_length: 2 };
    app.context.form.values.cycle_length = '3';
    await app.run();
    expect(app.calls[0].sql).toMatch(/source_digest/);
    const low = setup();
    low.context.form.values.cycle_length = '1';
    await expect(low.run()).rejects.toThrow('Cycle length must be 2–4.');
  });

  it('keeps a complete draft when activation fails', async () => {
    const app = setup({ batchFails: (_, statements) => statements.some(s => s.sql.includes("status = 'active'")) });
    await app.run();
    expect(app.calls.some(c => c.kind === 'db' && c.sql.startsWith('DELETE'))).toBe(false);
    expect(app.context.error).toMatch(/saved as a draft but not activated: the current timetable changed/);
    expect(app.context.importReview).toBeNull();
    await expect(app.run()).rejects.toThrow(/Preview an import first/);
    expect(app.calls.filter(c => c.kind === 'db' && c.sql.startsWith('INSERT'))).toHaveLength(1);
    expect(app.context.refresh).toHaveBeenCalledWith('id-0');
  });

  it('refuses to save when the chosen student no longer matches the review', async () => {
    const app = setup();
    app.context.form.values.student = 'someone-else';
    await expect(app.run()).rejects.toThrow(/student changed/);
    expect(app.calls).toEqual([]);
  });
});

describe('comparison for the replace diff', () => {
  function compare({ fail = false } = {}) {
    const pending = [];
    const context = vm.createContext({
      DB: '/db', importReview: null,
      timetables: [
        { id: 'tt-a', member_id: 'a', status: 'active', revision: 1, name: 'A' },
        { id: 'tt-b', member_id: 'b', status: 'active', revision: 1, name: 'B' },
      ],
      pages: (table, id) => new Promise((resolve, reject) => pending.push({ id, table, resolve, reject })),
    });
    vm.runInContext(source('async function loadComparison(', '// Import saves a new draft'), context);
    context.importReview = { student: 'a', candidate: { errors: [] }, compare: null };
    const settle = id => { for (const p of pending.filter(x => x.id === id)) fail ? p.reject(new Error('offline')) : p.resolve([{ id: `${id}-${p.table}` }]); };
    return { context, settle, load: () => vm.runInContext('loadComparison()', context), ready: () => vm.runInContext('comparisonReady(importReview)', context) };
  }

  it('drops a slow load for a student who is no longer selected', async () => {
    const app = compare();
    const first = app.load();
    expect(app.context.importReview.compare.state).toBe('loading');
    expect(app.ready()).toBe(false);
    app.context.importReview.student = 'b';
    const second = app.load();
    app.settle('tt-b');
    await second;
    app.settle('tt-a');
    await first;
    expect(app.context.importReview.compare).toMatchObject({ student: 'b', state: 'ready', timetable: { id: 'tt-b' } });
    expect(app.ready()).toBe(true);
  });

  it('reports a failed load instead of claiming there is no timetable, and blocks import', async () => {
    const app = compare({ fail: true });
    const load = app.load();
    app.settle('tt-a');
    await load;
    expect(app.context.importReview.compare).toMatchObject({ state: 'error', error: 'offline' });
    expect(app.ready()).toBe(false);
  });

  it('is ready at once for a student with no active timetable', async () => {
    const app = compare();
    app.context.importReview.student = 'nobody';
    await app.load();
    expect(app.context.importReview.compare).toEqual({ student: 'nobody', state: 'none' });
    expect(app.ready()).toBe(true);
  });
});

describe('redrawing forms', () => {
  it('never writes a value back into a file input', () => {
    const file = { name: 'file', type: 'file', get value() { return 'C:\\fakepath\\t.csv'; }, set value(v) { if (v !== '') throw new Error('InvalidStateError'); } };
    const text = { name: 'text', type: 'textarea', value: 'pasted' };
    const form = { id: 'importText', elements: Object.assign([file, text], { namedItem: n => [file, text].find(f => f.name === n) }) };
    const context = vm.createContext({ root: { querySelectorAll: () => [form] }, renderContent: () => { text.value = ''; } });
    vm.runInContext(source('function render(preserveForms=', 'function renderContent('), context);
    expect(() => vm.runInContext('render(true)', context)).not.toThrow();
    expect(text.value).toBe('pasted');
  });
});

describe('review form', () => {
  it('re-renders with the values submitted before a failed save, not the defaults', () => {
    const context = vm.createContext({
      ...logic, busy: false, importing: false, DB: '/db', me: { id: 'adult', role: 'adult' }, today: '2026-09-16', timetables: [],
      members: [{ id: 'student', name: 'Sam', role: 'child' }], adult: () => true, nameOf: () => 'Sam',
      esc: v => String(v ?? ''), previewGrid: () => '', diffHtml: () => '', comparisonReady: () => true,
      cycleText: () => '2-day rotation',
      importReview: {
        student: 'student', digest: 'd', candidate: { errors: [], warnings: [], periods: [], lessons: [], cycle_kind: 'day_rotation', cycle_length: 6, min_cycle_length: 5 },
        values: { name: 'Autumn', start_date: '2026-09-01', end_date: '2026-12-18', phase_date: '2026-09-15', phase: '4', consumes: 'on', cycle_length: '7' },
      },
    });
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context);
    const html = vm.runInContext('importCard()', context);
    for (const fragment of ['name="cycle_length" type="number" min="5" max="10" value="7"', 'value="Autumn"', 'value="2026-09-01"', 'value="2026-12-18"', 'value="2026-09-15"', 'value="4"', 'checked>']) expect(html).toContain(fragment);
  });
});

describe('import form input', () => {
  function listeners() {
    const handlers = {};
    const root = { addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); }, querySelector: sel => nodes[sel] };
    const nodes = { '#importPreview': { innerHTML: '' }, '#importDiff': { innerHTML: '' } };
    let renders = 0;
    const context = vm.createContext({
      root, importText: '', message: () => {}, render: () => { renders++; },
      previewGrid: c => `grid:${c.cycle_length}`, diffHtml: r => `diff:${r.candidate.cycle_length}`,
      FormData: class { constructor(form) { return Object.entries(form.values); } },
      importReview: { student: 'a', candidate: { cycle_kind: 'weekly', cycle_length: 2, min_cycle_length: 1 } },
    });
    const start = html.indexOf("root.addEventListener('input'");
    vm.runInContext(html.slice(start, html.indexOf("root.addEventListener('submit'")), context);
    return { context, nodes, fire: (type, target) => Promise.all(handlers[type].map(fn => fn({ target }))), renders: () => renders };
  }

  it('records typed review values and pasted text for later redraws', async () => {
    const app = listeners();
    const review = { id: 'importReview' };
    await app.fire('input', { name: 'name', type: 'text', value: 'Autumn', form: review });
    await app.fire('input', { name: 'phase', type: 'number', value: '2', form: review });
    await app.fire('input', { name: 'keep_exceptions', type: 'checkbox', checked: false, form: review });
    // Only touched fields are recorded, so untouched ones keep following their defaults (e.g. another student's term).
    expect(app.context.importReview.values).toEqual({ name: 'Autumn', phase: '2', keep_exceptions: '' });
    await app.fire('input', { name: 'text', value: 'Day,Start', form: { id: 'importText' }, closest: () => null });
    expect(app.context.importText).toBe('Day,Start');
  });

  it('updates preview and diff for a new cycle length without redrawing the form', async () => {
    const app = listeners();
    const phase = { max: '2' };
    await app.fire('change', { name: 'cycle_length', value: '3', form: { id: 'importReview', elements: { namedItem: n => (n === 'phase' ? phase : null) } }, closest: sel => (sel === '#importReview' ? {} : null) });
    expect(phase.max).toBe('3');
    expect(app.context.importReview.candidate.cycle_length).toBe(3);
    expect(app.nodes['#importPreview'].innerHTML).toBe('grid:3');
    expect(app.nodes['#importDiff'].innerHTML).toBe('diff:3');
    expect(app.renders()).toBe(0);
  });
});

describe('refresh while saving', () => {
  function guards({ busy, day = '2026-09-17' }) {
    const refresh = vi.fn();
    const context = vm.createContext({ busy, importing: false, today: '2026-09-16', localToday: () => day, refresh });
    vm.runInContext(source('function refreshIfIdle(', 'setInterval(midnightTick'), context);
    return { refresh, run: code => vm.runInContext(code, context) };
  }

  it('the Refresh button does nothing while a save is running', () => {
    const busy = guards({ busy: true });
    busy.run('refreshIfIdle()');
    expect(busy.refresh).not.toHaveBeenCalled();
    const idle = guards({ busy: false });
    idle.run('refreshIfIdle()');
    expect(idle.refresh).toHaveBeenCalledTimes(1);
  });

  it('both wait for an import even when busy was cleared', () => {
    const app = guards({ busy: false });
    app.run('importing = true; refreshIfIdle(); midnightTick()');
    expect(app.refresh).not.toHaveBeenCalled();
  });

  it('refresh re-checks the import comparison even when loading the open timetable fails', async () => {
    const loadComparison = vi.fn(async () => {});
    const context = vm.createContext({
      busy: false, loading: false, error: '', selected: null, timetables: [], importReview: { student: 's' },
      render: () => {}, loadContext: async () => {}, localToday: () => '2026-09-16', loadList: async () => {},
      loadSelected: async () => { throw new Error('Timetable changed while loading.'); }, loadComparison,
    });
    vm.runInContext(source('async function refresh(', 'function updateGuard('), context);
    await vm.runInContext('refresh()', context);
    expect(loadComparison).toHaveBeenCalledTimes(1);
    expect(context.error).toMatch(/changed while loading/);
  });

  it('the midnight refresh waits for a running save, then fires on a later tick', () => {
    const app = guards({ busy: true });
    app.run('midnightTick()');
    expect(app.refresh).not.toHaveBeenCalled();
    app.run('busy = false; midnightTick()');
    expect(app.refresh).toHaveBeenCalledTimes(1);
    const sameDay = guards({ busy: false, day: '2026-09-16' });
    sameDay.run('midnightTick()');
    expect(sameDay.refresh).not.toHaveBeenCalled();
  });
});

describe('replacing a timetable', () => {
  const halfTerm = { id: 'x-old', timetable_id: 'old', start_date: '2026-10-19', end_date: '2026-10-23', kind: 'no_school', override_slot: null, label: 'Half term', created_by: 'adult' };
  const inserts = (app, table) => app.calls.filter(c => c.kind === 'batch').flatMap(c => c.statements).filter(s => s.sql.startsWith(`INSERT INTO app_timetable__${table}`));

  it('keeps holidays when ticked: copied into the draft and honoured by the projection', async () => {
    const app = setup({ exceptions: [halfTerm] });
    app.context.form.values.keep_exceptions = 'on';
    await app.run();
    const [copy] = inserts(app, 'exceptions');
    expect(copy.params).toEqual([expect.stringMatching(/^id-/), 'id-0', '2026-10-19', '2026-10-23', 'no_school', null, 'Half term', 'adult']);
    const days = inserts(app, 'school_days').flatMap(s => s.params);
    expect(days).toContain('2026-10-16');
    expect(days).not.toContain('2026-10-19');
  });

  it('counts the chosen rotation day past a kept holiday, so the chosen date keeps its day', async () => {
    const holiday = { ...halfTerm, start_date: '2026-09-15', end_date: '2026-09-15', label: 'Inset day' };
    const app = setup({ exceptions: [holiday] });
    const text = 'Day,Start,End,Subject\n1,08:30,09:15,Maths\n2,08:30,09:15,Art\n3,08:30,09:15,Music';
    app.context.importReview.candidate = importer.buildCandidate(importer.parseTimetableText(text));
    Object.assign(app.context.form.values, { keep_exceptions: 'on', start_date: '2026-09-01', phase_date: '2026-09-16', phase: '3', cycle_length: '6' });
    await app.run();
    const days = inserts(app, 'school_days').flatMap(s => s.params);
    const slotOn = date => days[days.indexOf(date) + 1];
    expect(slotOn('2026-09-16')).toBe(2);
    expect(slotOn('2026-09-14')).toBe(1);
    expect(days).not.toContain('2026-09-15');
  });

  it('drops holidays when unticked', async () => {
    const app = setup({ exceptions: [halfTerm] });
    await app.run();
    expect(inserts(app, 'exceptions')).toEqual([]);
    expect(inserts(app, 'school_days').flatMap(s => s.params)).toContain('2026-10-19');
  });

  it('refuses kept holidays outside the new term, before writing anything', async () => {
    const app = setup({ exceptions: [{ ...halfTerm, start_date: '2027-02-15', end_date: '2027-02-19' }] });
    app.context.form.values.keep_exceptions = 'on';
    await expect(app.run()).rejects.toThrow(/kept from Old don't fit this timetable: .*Adjust the term dates or untick/);
    expect(app.calls).toEqual([]);
  });

  it('carries a lesson colour for a matching subject into the saved rows', async () => {
    const app = setup();
    Object.assign(app.context.importReview.compare, {
      periods: [{ id: 'op', start_time: '08:30', end_time: '09:15' }],
      lessons: [{ slot: 0, period_id: 'op', subject: 'Maths', color: '#aa0000', notes: '' }],
    });
    await app.run();
    expect(inserts(app, 'lessons').flatMap(s => s.params)).toContain('#aa0000');
  });

  it('stays locked for the whole import even if another error clears busy', async () => {
    let release;
    const app = setup({ batchFails: () => false });
    const gate = new Promise(resolve => { release = resolve; });
    const original = app.context.batch;
    app.context.batch = vi.fn(async statements => { await gate; return original(statements); });
    const first = app.run();
    await new Promise(resolve => setTimeout(resolve, 0));
    app.context.busy = false; // what message() does for an unrelated failure
    await expect(app.run()).rejects.toThrow(/Wait for the current save/);
    release();
    await first;
    expect(app.context.importing).toBe(false);
  });
});

describe('comparison readiness', () => {
  const ready = (compare, timetables) => {
    const context = vm.createContext({ timetables });
    vm.runInContext(source('const comparisonReady=', '// Import saves a new draft'), context);
    context.r = { student: 's', compare };
    return vm.runInContext('comparisonReady(r)', context);
  };
  const active = { id: 'tt', member_id: 's', status: 'active', revision: 3 };

  it('is stale once the compared timetable is no longer the active one, or has changed', () => {
    expect(ready({ student: 's', state: 'ready', timetable: active }, [active])).toBe(true);
    expect(ready({ student: 's', state: 'ready', timetable: active }, [{ ...active, revision: 4 }])).toBe(false);
    expect(ready({ student: 's', state: 'ready', timetable: active }, [{ ...active, id: 'newer' }])).toBe(false);
    expect(ready({ student: 's', state: 'none' }, [active])).toBe(false);
    expect(ready({ student: 's', state: 'none' }, [])).toBe(true);
  });
});

describe('review form defaults when replacing', () => {
  const card = values => {
    const base = { student: 'student', state: 'ready', timetable: { id: 'old', name: 'Old', start_date: '2026-09-02', end_date: '2027-07-16' }, exceptions: [{ id: 'x' }, { id: 'y' }] };
    const context = vm.createContext({
      ...logic, busy: false, importing: false, DB: '/db', me: { id: 'adult', role: 'adult' }, today: '2026-09-16',
      timetables: [], members: [{ id: 'student', name: 'Sam', role: 'child' }], adult: () => true, nameOf: () => 'Sam',
      esc: v => String(v ?? ''), previewGrid: () => '', diffHtml: () => '', comparisonReady: () => true, cycleText: () => '',
      importReview: { student: 'student', digest: 'd', compare: base, values,
        candidate: { errors: [], warnings: [], periods: [], lessons: [], cycle_kind: 'weekly', cycle_length: 2, min_cycle_length: 1 } },
    });
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context);
    return vm.runInContext('importCard()', context);
  };

  it('starts from the replaced term and offers to keep its holidays, ticked', () => {
    const html = card(undefined);
    expect(html).toContain('name="start_date" type="date" value="2026-09-02"');
    expect(html).toContain('name="end_date" type="date" value="2027-07-16"');
    expect(html).toMatch(/name="keep_exceptions" type="checkbox" style="width:auto" checked> Keep 2 holidays and day overrides from Old/);
  });

  it('remembers an unticked keep box across redraws', () => {
    expect(card({ keep_exceptions: '' })).not.toMatch(/name="keep_exceptions"[^>]*checked/);
  });
});
