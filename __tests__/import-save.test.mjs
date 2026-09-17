import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as logic from '../src/logic.js';
import * as importer from '../src/import.js';
import * as inferer from '../src/infer.js';

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
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context); vm.runInContext(source('// Lessons seen only once', 'function previewGrid('), context);
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

  it('re-checks a calendar import against the calendar as the review form changes', async () => {
    const app = listeners();
    app.nodes['#importCheck'] = { innerHTML: '' };
    app.context.importCheckHtml = (r, v) => `check:${v.phase}`;
    await app.fire('input', { name: 'phase', type: 'number', value: '3', form: { id: 'importReview', values: { phase: '3' } } });
    expect(app.nodes['#importCheck'].innerHTML).toBe('');
    app.context.importReview.candidate.ics = {};
    await app.fire('input', { name: 'phase', type: 'number', value: '3', form: { id: 'importReview', values: { phase: '3' } } });
    expect(app.nodes['#importCheck'].innerHTML).toBe('check:3');
    expect(app.renders()).toBe(0);
  });

  it('moves the known date to the first calendar school day in the term until it is edited, and recounts kept holidays outside the term', async () => {
    const app = listeners();
    app.context.keptOutsideNote = (base, start, end) => `outside:${base.exceptions.length}:${start}:${end}`;
    app.nodes['#importKeptOutside'] = { textContent: '' };
    const inputs = { phase_date: { value: '2026-09-07' }, phase: { value: '1' } };
    const values = { start_date: '2026-09-07', end_date: '2026-12-18', phase_date: '2026-09-07', phase: '1' };
    const form = { id: 'importReview', values, elements: { namedItem: n => inputs[n] ?? null } };
    Object.assign(app.context.importReview, {
      candidate: { cycle_kind: 'weekly', cycle_length: 2, ics: { assignments: [{ date: '2026-09-07', slot: 0 }, { date: '2026-09-21', slot: 8 }, { date: '2026-09-22', slot: 1 }] } },
      compare: { state: 'ready', exceptions: [{}, {}] },
    });
    values.start_date = '2026-09-19';
    await app.fire('input', { name: 'start_date', type: 'date', value: '2026-09-19', form });
    expect([inputs.phase_date.value, inputs.phase.value]).toEqual(['2026-09-21', '2']);
    expect(app.context.importReview.values).toMatchObject({ phase_date: '2026-09-21', phase: '2' });
    expect(app.nodes['#importKeptOutside'].textContent).toBe('outside:2:2026-09-19:2026-12-18');
    await app.fire('input', { name: 'phase', type: 'number', value: '1', form });
    values.start_date = '2026-09-22';
    await app.fire('input', { name: 'start_date', type: 'date', value: '2026-09-22', form });
    expect(inputs.phase_date.value).toBe('2026-09-21');
  });

  it('moves the known date to the last correctly labelled school day in the term when the labels repeat a day', async () => {
    const app = listeners();
    app.context.keptOutsideNote = () => '';
    const inputs = { phase_date: { value: '2026-09-01' }, phase: { value: '1' } };
    // The term is moved to end before the calendar's own known date: the last usable day in it is 2026-09-15 (not the
    // mislabelled 2026-09-16, nor the first, 2026-09-02).
    const values = { start_date: '2026-09-02', end_date: '2026-09-18' };
    const form = { id: 'importReview', values, elements: { namedItem: n => inputs[n] ?? null } };
    Object.assign(app.context.importReview, {
      candidate: { cycle_kind: 'day_rotation', cycle_length: 6, ics: { phase: { date: '2026-09-29', phase: 4, latest: true }, labelMismatches: ['2026-09-16'],
        assignments: [{ date: '2026-09-01', slot: 0 }, { date: '2026-09-02', slot: 1 }, { date: '2026-09-15', slot: 2 }, { date: '2026-09-16', slot: 5 }, { date: '2026-09-29', slot: 3 }] } },
    });
    await app.fire('input', { name: 'end_date', type: 'date', value: '2026-09-18', form });
    expect([inputs.phase_date.value, inputs.phase.value]).toEqual(['2026-09-15', '3']);
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
      formDrafts: () => new Map(), restoreForms: () => {}, submittedForm: null,
    });
    vm.runInContext(source('async function refresh(', 'function updateGuard('), context);
    await vm.runInContext('refresh()', context);
    expect(loadComparison).toHaveBeenCalledTimes(1);
    expect(context.error).toMatch(/changed while loading/);
  });

  it('keeps edited fields in other forms through a refresh, but not untouched ones, the form just saved, or timetable forms after a switch', async () => {
    // Each form has an edited field (value differs from the rendered default) and an untouched one.
    const form = (id, edited, untouched) => {
      const fields = [{ name: 'label', value: edited, defaultValue: `${id} default` }, { name: 'end', value: untouched, defaultValue: untouched }];
      fields.namedItem = name => fields.find(f => f.name === name) ?? null;
      return { id, dataset: {}, elements: fields };
    };
    let forms;
    const typed = () => { forms = [form('term', 'typed term', 'old end'), form('saved', 'typed saved', 'old end'), form('setup', 'typed setup', 'old end')]; };
    const context = vm.createContext({
      busy: false, loading: false, error: '', selected: { id: 'a' }, timetables: [{ id: 'a' }], importReview: null,
      root: { querySelectorAll: () => forms }, renderContent: () => { forms = [form('term', 'loaded term', 'new end'), form('saved', 'loaded saved', 'new end'), form('setup', 'loaded setup', 'new end')]; },
      loadContext: async () => {}, localToday: () => '2026-09-16', loadList: async () => {}, loadSelected: async id => { context.selected = { id }; }, submittedForm: 'saved',
    });
    vm.runInContext(source('function render(preserveForms=', 'function renderContent('), context);
    vm.runInContext(source('async function refresh(', 'function updateGuard('), context);
    const values = () => forms.map(f => f.elements.map(x => x.value).join(' / '));
    typed();
    await vm.runInContext("refresh('a')", context);
    expect(values()).toEqual(['typed term / new end', 'loaded saved / new end', 'typed setup / new end']);
    typed();
    context.timetables = [{ id: 'a' }, { id: 'b' }];
    await vm.runInContext("refresh('b')", context);
    expect(values()).toEqual(['loaded term / new end', 'loaded saved / new end', 'typed setup / new end']);
  });

  it('opening another timetable keeps only edited input in forms that are not about a timetable', async () => {
    const form = (id, edited, untouched, dataset = {}) => {
      const fields = [{ name: 'label', value: edited, defaultValue: `${id} default` }, { name: 'end', value: untouched, defaultValue: untouched }];
      fields.namedItem = name => fields.find(f => f.name === name) ?? null;
      return { id, dataset, elements: fields };
    };
    let forms = [form('term', 'typed term', 'old end'), form('', 'typed period', 'old end', { period: 'p1' }), form('setup', 'typed setup', 'old end')];
    const handlers = {};
    const context = vm.createContext({
      busy: false, loading: false, error: '', selected: { id: 'a' }, importReview: null, message: e => { throw e; },
      root: { addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); }, querySelectorAll: () => forms },
      renderContent: () => { forms = [form('term', 'loaded term', 'new end'), form('', 'loaded period', 'new end', { period: 'p1' }), form('setup', 'term default', 'new end')]; },
      loadSelected: async id => { context.selected = { id }; },
    });
    vm.runInContext(source('function render(preserveForms=', 'function renderContent('), context);
    vm.runInContext(html.slice(html.indexOf("root.addEventListener('click'"), html.indexOf("root.addEventListener('input'")), context);
    await handlers.click[0]({ target: { closest: () => ({ dataset: { select: 'b' } }) } });
    expect(context.selected).toEqual({ id: 'b' });
    expect(forms.map(f => f.elements.map(x => x.value).join(' / '))).toEqual(['loaded term / new end', 'loaded period / new end', 'typed setup / new end']);
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

  it('leaves out kept holidays outside the new term and clips one that overlaps it', async () => {
    const app = setup({ exceptions: [{ ...halfTerm, start_date: '2027-02-15', end_date: '2027-02-19' }, { ...halfTerm, id: 'x-2', start_date: '2026-12-14', end_date: '2027-01-04', label: 'Winter' }] });
    app.context.form.values.keep_exceptions = 'on';
    await app.run();
    expect(inserts(app, 'exceptions').map(s => s.params.slice(2, 4))).toEqual([['2026-12-14', '2026-12-18']]);
  });

  it("ignores a comparison loaded for a different student", async () => {
    const app = setup({ exceptions: [halfTerm] });
    app.context.form.values.keep_exceptions = 'on';
    vm.runInContext(source('function importDraft(', 'function previewGrid('), app.context);
    app.context.importReview.compare = { ...app.context.importReview.compare, student: 'someone-else' };
    expect(vm.runInContext('importDraft(importReview, form.values, "student", importReview.candidate)', app.context).kept).toEqual([]);
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
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context); vm.runInContext(source('// Lessons seen only once', 'function previewGrid('), context);
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

describe('calendar import', () => {
  // A three-day rotation over six weeks with the school closed on Wed 16 Sep.
  const observations = [];
  for (let date = '2026-09-07', n = 0; date < '2026-10-17'; date = logic.addDays(date, 1)) {
    if (logic.weekday(date) > 4 || date === '2026-09-16') continue;
    observations.push({ all_day: false, date, end_date: date, start_time: '08:30', end_time: '09:20', subject: ['Maths', 'Art', 'PE'][n++ % 3], room: '', teacher: '', notes: '' });
  }
  observations.push({ all_day: true, date: '2026-09-16', end_date: '2026-09-16', start_time: '', end_time: '', subject: 'Staff training', room: '', teacher: '', notes: '' });
  const inference = inferer.inferTimetable({ observations, warnings: [], errors: [] });
  const candidate = inferer.candidateForFit(inference, observations);
  const review = (app, values) => {
    Object.assign(app.context.importReview, { source_kind: 'ics', candidate, inference, observations, fit: 0 });
    Object.assign(app.context.form.values, { start_date: '2026-09-07', end_date: '2026-10-16', phase_date: '2026-09-17', phase: '2' }, values);
  };
  const inserts = (app, table) => app.calls.filter(c => c.kind === 'batch').flatMap(c => c.statements).filter(s => s.sql.startsWith(`INSERT INTO app_timetable__${table}`));
  const slots = app => { const p = inserts(app, 'school_days').flatMap(s => s.params); return date => (p.includes(date) ? p[p.indexOf(date) + 1] : null); };

  it('saves a ticked day off as a holiday and counts the rotation past it', async () => {
    const app = setup({ active: null });
    review(app, { 'holiday:0': 'on' });
    await app.run();
    expect(app.calls[0].sql).toMatch(/source_kind,source_digest/);
    expect(app.calls[0].sql).toMatch(/^INSERT INTO app_timetable__timetables/);
    expect(app.context.error).toBe('');
    const [holiday] = inserts(app, 'exceptions');
    expect(holiday.params).toEqual([expect.stringMatching(/^id-/), 'id-0', '2026-09-16', '2026-09-16', 'no_school', null, 'Staff training', 'adult']);
    const slotOn = slots(app);
    expect([slotOn('2026-09-15'), slotOn('2026-09-16'), slotOn('2026-09-17'), slotOn('2026-10-16')]).toEqual([0, null, 1, 1]);
    const check = inferer.checkObservedDays({ id: 'x', name: 'x', cycle_kind: 'day_rotation', cycle_length: 3, start_date: '2026-09-07', end_date: '2026-10-16', anchor_date: '2026-09-07', override_consumes_cycle_day: 0 },
      [{ kind: 'no_school', start_date: '2026-09-16', end_date: '2026-09-16' }], candidate.ics.assignments);
    expect(check.mismatched).toEqual([]);
  });

  it('saves nothing extra when the day off is unticked, and clips a ticked day off to the term', async () => {
    const unticked = setup({ active: null });
    review(unticked);
    await unticked.run();
    expect(inserts(unticked, 'exceptions')).toEqual([]);
    const clipped = setup({ active: null });
    review(clipped, { 'holiday:0': 'on', start_date: '2026-09-16', phase_date: '2026-09-17' });
    clipped.context.importReview.candidate = { ...candidate, ics: { ...candidate.ics, holidays: [{ start_date: '2026-09-14', end_date: '2026-09-16', label: 'Closed' }] } };
    await clipped.run();
    expect(inserts(clipped, 'exceptions')[0].params.slice(2, 4)).toEqual(['2026-09-16', '2026-09-16']);
  });

  it('does not save a ticked day off twice when a kept holiday already covers it', async () => {
    const app = setup({ exceptions: [{ id: 'k', timetable_id: 'old', start_date: '2026-09-14', end_date: '2026-09-18', kind: 'no_school', override_slot: null, label: 'Kept', created_by: 'adult' }] });
    review(app, { 'holiday:0': 'on', keep_exceptions: 'on', phase_date: '2026-09-21', phase: '1' });
    await app.run();
    expect(inserts(app, 'exceptions').map(s => s.params[6])).toEqual(['Kept']);
  });

  it('saves only the part of a ticked day off that a kept holiday does not cover, and refuses a known date outside the term', async () => {
    const kept = { id: 'k', timetable_id: 'old', start_date: '2026-09-14', end_date: '2026-09-15', kind: 'no_school', override_slot: null, label: 'Kept', created_by: 'adult' };
    const app = setup({ exceptions: [kept] });
    review(app, { 'holiday:0': 'on', keep_exceptions: 'on', phase_date: '2026-09-21', phase: '1' });
    app.context.importReview.candidate = { ...candidate, ics: { ...candidate.ics, holidays: [{ start_date: '2026-09-15', end_date: '2026-09-16', label: 'Closed' }] } };
    await app.run();
    expect(app.context.error).toBe('');
    // Rows of 8 values: id, timetable, start, end, kind, slot, label, author.
    const rows = inserts(app, 'exceptions').flatMap(s => s.params).reduce((out, value, i) => (i % 8 ? out.at(-1).push(value) : out.push([value])) && out, []);
    expect(rows.map(r => [r[2], r[3], r[6]])).toEqual([['2026-09-14', '2026-09-15', 'Kept'], ['2026-09-16', '2026-09-16', 'Closed']]);
    const outside = setup({ active: null });
    review(outside, { start_date: '2026-09-21' });
    await expect(outside.run()).rejects.toThrow('Choose a known school date inside the term.');
    expect(outside.calls).toEqual([]);
  });

  it('does not record the keep box as unticked when the form does not show it', async () => {
    const app = setup({ active: null });
    review(app, { name: '   ' });
    app.context.form.elements = { namedItem: name => (name === 'keep_exceptions' ? null : {}) };
    await expect(app.run()).rejects.toThrow(/^Give the timetable a name/);
    expect(app.context.importReview.values).not.toHaveProperty('keep_exceptions');
    expect(app.context.importReview.values).toMatchObject({ consumes: '', 'holiday:0': '' });
  });

  it('reports a blank name as it is, not as a clash with the days off', async () => {
    const app = setup({ active: null });
    review(app, { 'holiday:0': 'on', name: '   ' });
    await expect(app.run()).rejects.toThrow(/^Give the timetable a name/);
  });

  it('remembers an unticked day off after a failed save, so a redraw does not tick it again', async () => {
    const app = setup({ active: null });
    review(app, { name: '   ' });
    expect(candidate.ics.holidays.length).toBeGreaterThan(0);
    await expect(app.run()).rejects.toThrow(/^Give the timetable a name/);
    expect(app.context.importReview.values).toMatchObject({ 'holiday:0': '', consumes: '', keep_exceptions: '' });
  });

  function checker(values) {
    const app = setup({ active: null });
    review(app, values);
    vm.runInContext(source('function importCard(', 'async function savePeriod('), Object.assign(app.context, { esc: v => String(v ?? ''), checkObservedDays: inferer.checkObservedDays }));
    return vm.runInContext('importCheckHtml(importReview, form.values)', app.context);
  }

  it('checks the review against the calendar as days off, dates and numbers change', () => {
    expect(checker({ 'holiday:0': 'on' })).toBe('<p class="small">All 29 school days in the calendar land on the same cycle day. 29 of 29 calendar lessons are in this timetable on their dates.</p>');
    expect(checker({})).toBe('<div class="banner" role="status">7 of 29 school days in the calendar would show a different cycle day, starting 2026-09-07. 22 of 29 calendar lessons are in this timetable on their dates. Tick the days the school was closed, or check the known date and day number.</div>');
    expect(checker({ start_date: '2026-11-02', end_date: '2026-12-18', phase_date: '2026-11-02' })).toBe('<p class="small muted">No school days from the calendar fall inside these term dates.</p>');
    expect(checker({ phase_date: '2026-09-16', 'holiday:0': 'on' })).toBe("<p class=\"small muted\">Can't check against the calendar yet: 2026-09-16 is a day off. Choose an ordinary school day.</p>");
  });

  it('refuses dates that would make the check crawl, and names both sources of a clash', async () => {
    expect(checker({ phase_date: '0202-09-08' })).toBe("<p class=\"small muted\">Can't check against the calendar yet: Use dates between 2000 and 2099.</p>");
    expect(checker({ phase_date: '2024-09-09' })).toBe("<p class=\"small muted\">Can't check against the calendar yet: Choose a known school date inside the term.</p>");
    expect(checker({ end_date: '2029-09-09' })).toBe("<p class=\"small muted\">Can't check against the calendar yet: A term must span 1–366 days.</p>");
    expect(checker({ start_date: '' })).toBe("<p class=\"small muted\">Can't check against the calendar yet: Fill in the term dates and a known school date.</p>");
    // A kept override from a longer cycle names a day this one does not have.
    const app = setup({ exceptions: [{ id: 'o', timetable_id: 'old', start_date: '2026-09-18', end_date: '2026-09-18', kind: 'day_override', override_slot: 5, label: 'Swap', created_by: 'adult' }] });
    review(app, { 'holiday:0': 'on', keep_exceptions: 'on' });
    await expect(app.run()).rejects.toThrow("The holidays and day overrides kept from Old and the ticked days off don't fit this timetable: Invalid override slot. Adjust the term dates, untick keeping Old's, or untick days off.");
    expect(app.calls).toEqual([]);
    // A kept override on a ticked day off wins: the day off is not saved there.
    const overlap = setup({ exceptions: [{ id: 'o', timetable_id: 'old', start_date: '2026-09-16', end_date: '2026-09-16', kind: 'day_override', override_slot: 0, label: 'Swap', created_by: 'adult' }] });
    review(overlap, { 'holiday:0': 'on', keep_exceptions: 'on', phase_date: '2026-09-17', phase: '1' });
    await overlap.run();
    expect(overlap.context.error).toBe('');
    expect(inserts(overlap, 'exceptions').flatMap(s => s.params).filter(v => ['Swap', 'Staff training'].includes(v))).toEqual(['Swap']);
  });

  it('switches to another fitting cycle, dropping the old cycle position and days off but keeping other answers', async () => {
    const handlers = {};
    const alternating = [];
    for (let date = '2026-09-07', n = 0; date < '2026-10-17'; date = logic.addDays(date, 1)) {
      if (logic.weekday(date) < 5) alternating.push({ all_day: false, date, end_date: date, start_time: '08:30', end_time: '09:20', subject: n++ % 2 ? 'Art' : 'Maths', room: '', teacher: '', notes: '' });
    }
    const both = inferer.inferTimetable({ observations: alternating, warnings: [], errors: [] });
    let renders = 0;
    const context = vm.createContext({
      ...logic, root: { addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); }, querySelector: () => null }, render: () => { renders++; }, message: e => { throw e; },
      candidateForFit: inferer.candidateForFit, loadComparison: vi.fn(async () => {}),
      importReview: { phaseEdited: true, inference: both, observations: alternating, fit: 0, candidate: inferer.candidateForFit(both, alternating, 0), values: { name: 'Autumn', fit: '1', phase: '2', phase_date: '2026-09-08', 'holiday:0': 'on', 'once:0': 'on' } },
    });
    vm.runInContext(html.slice(html.indexOf("root.addEventListener('input'"), html.indexOf("root.addEventListener('submit'")), context);
    await Promise.all(handlers.change.map(fn => fn({ target: { name: 'fit', value: '1', closest: sel => (sel.split(',').includes('#importFit') ? {} : null) } })));
    expect(context.importReview.candidate).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 2 });
    expect(context.importReview.fit).toBe(1);
    expect(context.importReview.values).toEqual({ name: 'Autumn' });
    expect(context.importReview.phaseEdited).toBe(false);
    // The first cycle may have had errors, which skip the comparison; the new one needs it.
    expect(context.loadComparison).toHaveBeenCalledTimes(1);
    expect(renders).toBe(2);
  });

  it('keeps the known date inside a moved term when the cycle changes, skipping kept overrides, and returns focus to the cycle', async () => {
    const handlers = {};
    const alternating = [];
    for (let date = '2026-09-07', n = 0; date < '2026-10-17'; date = logic.addDays(date, 1)) {
      if (logic.weekday(date) < 5) alternating.push({ all_day: false, date, end_date: date, start_time: '08:30', end_time: '09:20', subject: n++ % 2 ? 'Art' : 'Maths', room: '', teacher: '', notes: '' });
    }
    const both = inferer.inferTimetable({ observations: alternating, warnings: [], errors: [] });
    const focused = [], note = { textContent: '' };
    const context = vm.createContext({
      root: { addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); }, querySelector: sel => (sel === '#importFollow' ? note : sel === '[name="fit"]' ? { focus: () => focused.push('fit') } : null) },
      render: () => {}, message: e => { throw e; }, candidateForFit: inferer.candidateForFit, clipExceptions: logic.clipExceptions, loadComparison: async () => {},
      importReview: { student: 's', inference: both, observations: alternating, fit: 0, candidate: inferer.candidateForFit(both, alternating, 0), values: { start_date: '2026-10-05', end_date: '2026-10-16' },
        compare: { student: 's', state: 'ready', exceptions: [{ kind: 'day_override', start_date: '2026-10-05', end_date: '2026-10-05', override_slot: 0 }] } },
    });
    vm.runInContext(html.slice(html.indexOf("root.addEventListener('input'"), html.indexOf("root.addEventListener('submit'")), context);
    await Promise.all(handlers.change.map(fn => fn({ target: { name: 'fit', value: '1', closest: sel => (sel.split(',').includes('#importFit') ? {} : null) } })));
    const r = context.importReview;
    expect(r.candidate).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 2 });
    const slot = r.candidate.ics.assignments.find(a => a.date === '2026-10-06').slot;
    expect(r.values).toEqual({ start_date: '2026-10-05', end_date: '2026-10-16', phase_date: '2026-10-06', phase: String(slot + 1) });
    expect(note.textContent).toBe(`Known school date moved to 2026-10-06, day ${slot + 1}.`);
    expect(focused).toEqual(['fit']);
  });

  it('moves the default known date off a kept override when the student changes, announces it after redrawing, and clears the note on a manual edit', async () => {
    const handlers = {};
    const alternating = [];
    for (let date = '2026-09-07', n = 0; date < '2026-10-17'; date = logic.addDays(date, 1)) {
      if (logic.weekday(date) < 5) alternating.push({ all_day: false, date, end_date: date, start_time: '08:30', end_time: '09:20', subject: n++ % 2 ? 'Art' : 'Maths', room: '', teacher: '', notes: '' });
    }
    const both = inferer.inferTimetable({ observations: alternating, warnings: [], errors: [] });
    const events = [];
    let note = { textContent: '' };
    const context = vm.createContext({
      ...logic, root: { addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); }, querySelector: sel => (sel === '#importFollow' ? note : null) },
      render: () => { events.push('render'); note = { textContent: '' }; }, message: e => { throw e; }, candidateForFit: inferer.candidateForFit,
      importReview: { student: 'a', inference: both, observations: alternating, fit: 0, candidate: inferer.candidateForFit(both, alternating, 0), compare: { student: 'a', state: 'none' } },
    });
    context.loadComparison = async () => { context.importReview.compare = { student: 'b', state: 'ready', exceptions: [{ kind: 'day_override', start_date: '2026-09-07', end_date: '2026-09-07', override_slot: 0 }] }; };
    vm.runInContext(html.slice(html.indexOf("root.addEventListener('input'"), html.indexOf("root.addEventListener('submit'")), context);
    await Promise.all(handlers.change.map(fn => fn({ target: { name: 'student', value: 'b', closest: sel => (sel === '#importReview' ? {} : null) } })));
    const r = context.importReview;
    expect(r.values).toMatchObject({ phase_date: '2026-09-08' });
    expect(note.textContent).toMatch(/^Known school date moved to 2026-09-08, /);
    expect(events).toEqual(['render', 'render']);
    await handlers.input[0]({ target: { name: 'phase', type: 'number', value: '1', form: { id: 'importReview', values: {} } } });
    expect(note.textContent).toBe('');
    expect(r.phaseEdited).toBe(true);
  });

  it('starts the review from the calendar: its term, suggested date, days off and cycle choices', () => {
    const alternating = [];
    for (let date = '2026-09-07', n = 0; date < '2026-10-17'; date = logic.addDays(date, 1)) {
      if (logic.weekday(date) < 5 && date !== '2026-09-29' && date !== '2026-09-30') alternating.push({ all_day: false, date, end_date: date, start_time: '08:30', end_time: '09:20', subject: n++ % 2 ? 'Art' : 'Maths', room: '', teacher: '', notes: '' });
    }
    const both = inferer.inferTimetable({ observations: alternating, warnings: [], errors: [] });
    const context = vm.createContext({
      ...logic, busy: false, importing: false, DB: '/db', me: { id: 'adult', role: 'adult' }, today: '2026-09-16', timetables: [],
      members: [{ id: 'student', name: 'Sam', role: 'child' }], adult: () => true, nameOf: () => 'Sam', crypto: { randomUUID: () => 'id' }, now: () => 'now',
      esc: v => String(v ?? ''), previewGrid: () => '', diffHtml: () => '', comparisonReady: () => true, anchorFromPhase: logic.anchorFromPhase, checkObservedDays: inferer.checkObservedDays,
      cycleText: t => `${t.cycle_kind} ${t.cycle_length}`,
      importReview: { student: 'student', digest: 'd', source_kind: 'ics', compare: { student: 'student', state: 'none' }, fit: 1, candidate: inferer.candidateForFit(both, alternating, 1) },
    });
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context); vm.runInContext(source('// Lessons seen only once', 'function previewGrid('), context);
    vm.runInContext(source('function importDraft(', 'function previewGrid('), context);
    const card = vm.runInContext('importCard()', context);
    for (const fragment of ['name="start_date" type="date" value="2026-09-07"', 'name="end_date" type="date" value="2026-10-16"', 'name="phase_date" type="date" value="2026-09-07"',
      '<option value="0" >weekly 2</option><option value="1" selected>day_rotation 2</option>', 'name="holiday:0" type="checkbox" style="width:auto" checked> 2026-09-29 to 2026-09-30 · No lessons',
      'Worked out from 28 lessons on 28 school days, 2026-09-07 to 2026-10-16', '<div id="importCheck"><p class="small">All 28 school days in the calendar land on the same cycle day. 28 of 28 calendar lessons are in this timetable on their dates.</p></div>']) expect(card).toContain(fragment);
    expect(card).not.toContain('name="cycle_length"');
  });
});

describe('calendar review screen', () => {
  const baseContext = extra => vm.createContext({
    ...logic, busy: false, importing: false, DB: '/db', me: { id: 'adult', role: 'adult' }, today: '2026-09-16', timetables: [],
    members: [{ id: 'student', name: 'Sam', role: 'child' }], adult: () => true, nameOf: () => 'Sam',
    esc: v => String(v ?? ''), previewGrid: () => '', diffHtml: () => '', comparisonReady: () => true, cycleText: t => `${t.cycle_kind} ${t.cycle_length}`,
    ...extra,
  });

  it('ticks the days off a weekly calendar names, and leaves unnamed ones unticked', () => {
    const holidays = [{ start_date: '2026-10-26', end_date: '2026-10-30', days: 5, counted: false, label: 'Half Term', ticked: true }, { start_date: '2026-11-16', end_date: '2026-11-16', days: 1, counted: false, label: 'No lessons', ticked: false }];
    const ics = { fit: { agree: 1, repeated: 1 }, fits: [{ cycle_kind: 'weekly', cycle_length: 2 }], phase: { date: '2026-09-07', phase: 1 }, assignments: [], observed: [], coverage: { first: '2026-09-07', last: '2026-12-18', days: 1, lessons: 1 },
      term: { start: '2026-09-07', end: '2026-12-18' }, holidays, unmatched: { count: 0, items: [] }, variations: { count: 0, items: [] }, subjectChanges: { count: 0, items: [] } };
    const candidate = { errors: [], warnings: [], periods: [], lessons: [], cycle_kind: 'weekly', cycle_length: 2, min_cycle_length: 1, ics };
    const context = baseContext({ checkObservedDays: () => ({ checked: 0, mismatched: [] }), importDraft: () => { throw new Error('skip'); }, importReview: { student: 'student', digest: 'd', source_kind: 'ics', fit: 0, compare: { student: 'student', state: 'none' }, candidate } });
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context); vm.runInContext(source('// Lessons seen only once', 'function previewGrid('), context);
    const card = vm.runInContext('importCard()', context);
    expect(card).toContain('name="holiday:0" type="checkbox" style="width:auto" checked>');
    expect(card).toContain('name="holiday:1" type="checkbox" style="width:auto" >');
  });

  it('keeps the known date of the day the review opened when it is still open after midnight', () => {
    const candidate = { errors: [], warnings: [], periods: [], lessons: [], cycle_kind: 'weekly', cycle_length: 1, min_cycle_length: 1 };
    const context = baseContext({ today: '2026-09-17', importReview: { student: 'student', digest: 'd', today: '2026-09-16', compare: { student: 'student', state: 'none' }, candidate } });
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context); vm.runInContext(source('// Lessons seen only once', 'function previewGrid('), context);
    expect(vm.runInContext('importCard()', context)).toContain('name="phase_date" type="date" value="2026-09-16"');
  });

  it('offers the other cycles when the chosen one cannot be built', () => {
    const context = baseContext({ importReview: { student: 'student', fit: 0, candidate: { errors: ['Lessons clash'], warnings: [], ics: { fits: [{ cycle_kind: 'weekly', cycle_length: 2 }, { cycle_kind: 'day_rotation', cycle_length: 2 }] } } } });
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context); vm.runInContext(source('// Lessons seen only once', 'function previewGrid('), context);
    expect(vm.runInContext('importCard()', context)).toContain('<div id="importFit" class="fields"><label>Try another cycle<select name="fit" ><option value="0" selected>weekly 2</option><option value="1" >day_rotation 2</option></select></label></div>');
  });

  it('says how many kept holidays fall outside the new term', () => {
    const exceptions = [{ id: 'a', kind: 'no_school', start_date: '2026-10-19', end_date: '2026-10-23' }, { id: 'b', kind: 'no_school', start_date: '2027-02-15', end_date: '2027-02-19' }];
    const context = baseContext({ importReview: { student: 'student', digest: 'd', values: { start_date: '2026-09-01', end_date: '2026-12-18' },
      compare: { student: 'student', state: 'ready', timetable: { id: 'old', name: 'Old', start_date: '2026-09-01', end_date: '2027-07-16' }, exceptions },
      candidate: { errors: [], warnings: [], periods: [], lessons: [], cycle_kind: 'weekly', cycle_length: 2, min_cycle_length: 1 } } });
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context); vm.runInContext(source('// Lessons seen only once', 'function previewGrid('), context);
    expect(vm.runInContext('importCard()', context)).toContain('Keep 2 holidays and day overrides from Old<span id="importKeptOutside"> (1 outside the new term is left out)</span></label>');
  });

  it('does not re-run the calendar check while the name is typed', async () => {
    const handlers = {};
    const check = { innerHTML: 'before' };
    const context = vm.createContext({
      root: { addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); }, querySelector: () => check },
      importCheckHtml: () => 'after', FormData: class { constructor(form) { return Object.entries(form.values); } },
      importReview: { candidate: { ics: {} } },
    });
    vm.runInContext(html.slice(html.indexOf("root.addEventListener('input'"), html.indexOf("root.addEventListener('change'")), context);
    handlers.input[0]({ target: { name: 'name', type: 'text', value: 'A', form: { id: 'importReview', values: {} } } });
    expect(check.innerHTML).toBe('before');
    handlers.input[0]({ target: { name: 'holiday:0', type: 'checkbox', checked: true, form: { id: 'importReview', values: {} } } });
    expect(check.innerHTML).toBe('after');
  });

  it('recognises a calendar re-downloaded later as the same import, and passes the household zone as set', async () => {
    const digests = [], zones = [];
    const context = vm.createContext({
      ...logic, today: '2026-09-16', householdZone: null, members: [], me: { id: 'adult' }, adult: () => false, render: () => {}, loadComparison: async () => {}, followTerm: vi.fn(() => ''),
      parseIcs: (text, opts) => { zones.push(opts.timezone); return { observations: [], warnings: [], errors: [] }; },
      inferTimetable: () => ({}), candidateForFit: () => ({ errors: [] }), buildCandidate: () => ({ errors: [] }), parseTimetableText: () => ({}),
      digestText: async text => { digests.push(text); return 'd'; },
    });
    vm.runInContext(source('async function previewImport(', '// The replace diff needs'), context);
    const file = stamp => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTAMP:${stamp}\r\nSUMMARY:Maths\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    await vm.runInContext(`previewImport(${JSON.stringify(file('20260901T000000Z'))})`, context);
    await vm.runInContext(`previewImport(${JSON.stringify(file('20260915T120000Z'))})`, context);
    // The known date follows the default term (and any kept exceptions) once the comparison has loaded.
    expect(context.followTerm).toHaveBeenLastCalledWith(context.importReview);
    expect(digests[0]).toBe(digests[1]);
    expect(zones).toEqual([null, null]);
    expect(context.importReview.source_kind).toBe('ics');
  });
});

describe('calendar days off that the rotation counts', () => {
  // Lessons Mon, Tue, Thu, Fri; a six-day rotation that also counts every Wednesday (the student is part-time).
  const observations = [];
  for (let date = '2026-09-07', n = 0; date < '2026-11-02'; date = logic.addDays(date, 1)) {
    if (logic.weekday(date) > 4) continue;
    const day = n++ % 6;
    if (logic.weekday(date) !== 2) observations.push({ all_day: false, date, end_date: date, start_time: '08:30', end_time: '09:20', subject: `Day ${day + 1}`, room: '', teacher: '', notes: '' });
  }
  const inference = inferer.inferTimetable({ observations, warnings: [], errors: [] });
  const candidate = inferer.candidateForFit(inference, observations);

  it('shows every Wednesday as one row, counted and unticked, and saves no holidays unless ticked', async () => {
    expect(candidate).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 6 });
    expect(candidate.ics.holidays).toEqual([{ start_date: '2026-09-09', end_date: '2026-10-28', days: 8, dates: expect.any(Array), counted: true, label: 'No lessons on Wednesdays', ticked: false }]);
    const context = vm.createContext({
      ...logic, busy: false, importing: false, DB: '/db', me: { id: 'adult', role: 'adult' }, today: '2026-09-16', timetables: [],
      members: [{ id: 'student', name: 'Sam', role: 'child' }], adult: () => true, nameOf: () => 'Sam', crypto: { randomUUID: () => 'id' }, now: () => 'now',
      esc: v => String(v ?? ''), previewGrid: () => '', diffHtml: () => '', comparisonReady: () => true, checkObservedDays: inferer.checkObservedDays,
      cycleText: t => `${t.cycle_kind} ${t.cycle_length}`,
      importReview: { student: 'student', digest: 'd', source_kind: 'ics', compare: { student: 'student', state: 'none' }, fit: 0, candidate },
    });
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context); vm.runInContext(source('// Lessons seen only once', 'function previewGrid('), context);
    vm.runInContext(source('function importDraft(', 'function previewGrid('), context);
    const card = vm.runInContext('importCard()', context);
    expect(card).toContain('name="holiday:0" type="checkbox" style="width:auto" > 8 days, 2026-09-09 to 2026-10-28 · No lessons on Wednesdays · counted as a school day');
    expect(card).toContain('All 32 school days in the calendar land on the same cycle day.');
  });

  it('saves one holiday per date when a whole-weekday row is ticked', async () => {
    const app = setup({ active: null });
    Object.assign(app.context.importReview, { source_kind: 'ics', candidate, inference, observations, fit: 0 });
    Object.assign(app.context.form.values, { start_date: '2026-09-07', end_date: '2026-10-16', phase_date: '2026-09-07', phase: '1', 'holiday:0': 'on' });
    await app.run();
    const rows = app.calls.filter(c => c.kind === 'batch').flatMap(c => c.statements).filter(st => st.sql.startsWith('INSERT INTO app_timetable__exceptions'));
    expect(rows.flatMap(st => st.params).filter(p => /^2026-/.test(p))).toEqual(['2026-09-09', '2026-09-09', '2026-09-16', '2026-09-16', '2026-09-23', '2026-09-23', '2026-09-30', '2026-09-30', '2026-10-07', '2026-10-07', '2026-10-14', '2026-10-14']);
  });
});

describe('lessons seen only once on the review', () => {
  // A one-week timetable with a free Wednesday 10:30 bell until Drama appears there on the last Wednesday.
  const observations = [];
  const BELLS = [['08:30', '09:30'], ['09:30', '10:30'], ['10:30', '11:30']];
  for (let date = '2026-09-07'; date < '2026-10-17'; date = logic.addDays(date, 1)) {
    const day = logic.weekday(date);
    if (day > 4) continue;
    BELLS.forEach(([start_time, end_time], p) => {
      const subject = day === 2 && p === 2 ? (date === '2026-10-14' ? 'Drama' : null) : `S${day} P${p}`;
      if (subject) observations.push({ all_day: false, date, end_date: date, start_time, end_time, subject, room: '', teacher: '', notes: '' });
    });
  }
  const inference = inferer.inferTimetable({ observations, warnings: [], errors: [] });
  const real = inferer.candidateForFit(inference, observations);
  // The calendar's own "lesson" item, plus a "day" item standing for Monday's lessons (a day filled from its one date).
  const monday = real.lessons.filter(l => l.slot === 0);
  const candidate = { ...real, ics: { ...real.ics, seenOnce: [{ kind: 'day', ticked: true, text: 'Mon: from one day', lessons: monday }, ...real.ics.seenOnce] } };
  const saveWith = async values => {
    const app = setup({ active: null });
    Object.assign(app.context.importReview, { source_kind: 'ics', candidate, inference, observations, fit: 0 });
    Object.assign(app.context.form.values, { start_date: '2026-09-07', end_date: '2026-10-16', phase_date: '2026-09-07', phase: '1' }, values);
    return app;
  };
  const subjects = app => app.calls.filter(c => c.kind === 'batch').flatMap(c => c.statements).filter(st => st.sql.startsWith('INSERT INTO app_timetable__lessons')).flatMap(st => st.params).filter(p => /^(S\d P\d|Drama)$/.test(p));

  it('lists a lesson that may have just started, unticked, from the calendar itself', () => {
    expect(real.ics.seenOnce).toEqual([{ kind: 'lesson', ticked: false, text: 'Wed 10:30–11:30: Drama is in the calendar only on 2026-10-14, the last Wed. It may have just started; tick it to add it.',
      lessons: [{ slot: 2, period_key: '10:30-11:30', subject: 'Drama', room: '', teacher: '', notes: '', ref: 'Wed 10:30–11:30' }] }]);
    expect(real.lessons.some(l => l.subject === 'Drama')).toBe(false);
  });

  it('saves the ticked items: the filled day by default, the new lesson only when ticked', async () => {
    const defaults = await saveWith({ 'once:0': 'on' });
    await defaults.run();
    expect(defaults.context.error).toBe('');
    expect(subjects(defaults)).toContain('S0 P0');
    expect(subjects(defaults)).not.toContain('Drama');
    const swapped = await saveWith({ 'once:1': 'on' });
    await swapped.run();
    expect(subjects(swapped)).toContain('Drama');
    expect(subjects(swapped).filter(s => s.startsWith('S0'))).toEqual([]);
    expect(subjects(swapped)).toHaveLength(14 - 3 + 1);
  });

  it('remembers both boxes after a failed save', async () => {
    const app = await saveWith({ name: '   ', 'once:1': 'on' });
    await expect(app.run()).rejects.toThrow(/^Give the timetable a name/);
    expect(app.context.importReview.values).toMatchObject({ 'once:0': '', 'once:1': 'on' });
  });

  it('shows the boxes with their defaults, previews the chosen lessons, and redraws the preview when a box changes', async () => {
    const shown = [];
    const context = vm.createContext({
      ...logic, busy: false, importing: false, DB: '/db', me: { id: 'adult', role: 'adult' }, today: '2026-09-16', timetables: [],
      members: [{ id: 'student', name: 'Sam', role: 'child' }], adult: () => true, nameOf: () => 'Sam', crypto: { randomUUID: () => 'id' }, now: () => 'now',
      esc: v => String(v ?? ''), previewGrid: c => { shown.push(c.lessons.map(l => l.subject)); return 'grid'; }, diffHtml: (r, c) => `diff ${c.lessons.length}`, comparisonReady: () => true, checkObservedDays: inferer.checkObservedDays,
      cycleText: t => `${t.cycle_kind} ${t.cycle_length}`,
      importReview: { student: 'student', digest: 'd', source_kind: 'ics', compare: { student: 'student', state: 'none' }, fit: 0, candidate },
    });
    vm.runInContext(source('function importCard(', 'async function savePeriod('), context);
    vm.runInContext(source('function importDraft(', 'function previewGrid('), context);
    const card = vm.runInContext('importCard()', context);
    expect(card).toContain('<legend>Seen only once: check these</legend>');
    expect(card).toContain('name="once:0" type="checkbox" style="width:auto" checked> Mon: from one day');
    expect(card).toContain('name="once:1" type="checkbox" style="width:auto" > Wed 10:30–11:30: Drama');
    expect(card).toContain(`diff ${real.lessons.length}`);
    expect(shown.at(-1)).not.toContain('Drama');
    // A redraw after a failed save previews what was ticked.
    context.importReview.values = { 'once:1': 'on' };
    vm.runInContext('importCard()', context);
    expect(shown.at(-1)).toContain('Drama');
    context.importReview.values = undefined;
    // Ticking Drama and unticking Monday redraws the preview and the comparison from the form.
    const handlers = {}, nodes = { '#importPreview': { innerHTML: '' }, '#importDiff': { innerHTML: '' }, '#importCheck': { innerHTML: '' } };
    Object.assign(context, { root: { addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); }, querySelector: sel => nodes[sel] ?? null } });
    vm.runInContext(html.slice(html.indexOf("root.addEventListener('input'"), html.indexOf("root.addEventListener('submit'")), context);
    const form = { id: 'importReview', values: { student: 'student', name: 'School', start_date: '2026-09-07', end_date: '2026-10-16', phase_date: '2026-09-07', phase: '1', 'once:1': 'on' } };
    context.FormData = class { constructor(f) { return Object.entries(f.values); } };
    handlers.input[0]({ target: { name: 'once:1', type: 'checkbox', checked: true, form } });
    expect(shown.at(-1)).toContain('Drama');
    expect(shown.at(-1).filter(s => s.startsWith('S0'))).toEqual([]);
    expect(nodes['#importDiff'].innerHTML).toBe(`diff ${real.lessons.length - 3 + 1}`);
    // Monday's 18 calendar lessons are now missing from the timetable; Drama is in it on its date.
    expect(nodes['#importCheck'].innerHTML).toContain(`${observations.length - 18} of ${observations.length} calendar lessons`);
  });
});

describe('changing the cycle length on review', () => {
  it('redraws the preview and the comparison without a second argument to diffHtml', async () => {
    const handlers = {}, nodes = { '#importPreview': { innerHTML: '' }, '#importDiff': { innerHTML: '' } };
    const candidate = importer.buildCandidate(importer.parseTimetableText('Day,Week,Start,End,Subject\nMon,A,08:30,09:15,Maths'));
    const context = vm.createContext({
      ...logic, ...importer, DB: '/db', esc: v => String(v ?? ''), message: e => { throw e; }, previewGrid: c => `grid ${c.cycle_length}`,
      root: { addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); }, querySelector: sel => nodes[sel] ?? null },
      importReview: { student: 's', compare: { student: 's', state: 'none' }, candidate },
    });
    vm.runInContext(source('function diffHtml(', 'function importCard('), context);
    vm.runInContext(html.slice(html.indexOf("root.addEventListener('input'"), html.indexOf("root.addEventListener('submit'")), context);
    await Promise.all(handlers.change.map(fn => fn({ target: { name: 'cycle_length', value: '2', form: { elements: { namedItem: () => null } }, closest: sel => (sel === '#importReview' ? {} : null) } })));
    expect(context.importReview.candidate.cycle_length).toBe(2);
    expect(nodes['#importPreview'].innerHTML).toBe('grid 2');
    expect(nodes['#importDiff'].innerHTML).toContain('no active timetable');
  });
});
