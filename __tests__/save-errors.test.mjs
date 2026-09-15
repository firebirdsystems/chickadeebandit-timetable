import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as logic from '../src/logic.js';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const source = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
const term = {
  id: 'tt', member_id: 'student', name: 'School', revision: 1,
  cycle_kind: 'weekly', cycle_length: 2, anchor_date: '2026-09-14',
  start_date: '2026-09-14', end_date: '2026-12-20', status: 'active',
};

// Model the form controls replaced by renderContent, without adding a DOM dependency.
function termForm(values = {}) {
  const fields = Object.entries({
    start_date: term.start_date, end_date: term.end_date,
    anchor_date: term.anchor_date, exceptions: '', ...values,
  }).map(([name, value]) => ({ name, value }));
  fields.push({ name: 'consumes', value: 'on', type: 'checkbox', checked: false });
  fields.namedItem = name => fields.find(field => field.name === name);
  return { id: 'term', elements: fields };
}

function setup(values) {
  let form = termForm(values);
  const batch = vi.fn(async () => { throw new Error('Stale state claim'); });
  const refresh = vi.fn(async () => { context.error = ''; });
  const context = vm.createContext({
    ...logic, selected: { ...term }, me: { id: 'adult' }, T: 'app_timetable__',
    busy: false, error: '', confirm: () => true, canEdit: () => true,
    now: () => '2026-09-15T12:00:00Z', crypto: { randomUUID: () => 'exception-id' },
    root: { querySelectorAll: () => [form] },
    renderContent: () => { form = termForm(); }, batch, refresh,
    FormData: class {
      constructor(form) {
        this.entries = form.elements.filter(f => f.type !== 'checkbox' || f.checked).map(f => [f.name, f.value]);
      }
      get(name) { return this.entries.find(([key]) => key === name)?.[1] ?? null; }
      [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
    },
  });
  for (const [start, end] of [
    ['function updateGuard(', 'function insertRows('],
    ['function insertRows(', 'function addMinutes('],
    ['function readExceptions(', 'function openCell('],
    ['function render(preserveForms=', 'function renderContent('],
  ]) vm.runInContext(source(start, end), context);
  return { context, batch, refresh, form: () => form, run: code => vm.runInContext(code, context) };
}

describe('save error recovery', () => {
  it('retains exception text and checkbox state after a validation error', async () => {
    const text = 'no_school | 2026-12-24 | 2026-12-25 | Christmas';
    const app = setup({ exceptions: text });
    app.form().elements.namedItem('consumes').checked = true;
    app.context.form = app.form();
    await app.run('(async()=>{try{await saveTerm(form)}catch(e){message(e)}})()');
    expect(app.context.error).toMatch(/inside the term/);
    expect(app.form().elements.namedItem('exceptions').value).toBe(text);
    expect(app.form().elements.namedItem('consumes').checked).toBe(true);
    expect(app.batch).not.toHaveBeenCalled();
  });

  it('retains edited dates and exceptions when the transaction fails', async () => {
    const text = 'no_school | 2026-12-24 | 2026-12-25 | Christmas';
    const app = setup({ end_date: '2026-12-31', exceptions: text });
    app.context.form = app.form();
    await app.run('saveTerm(form)');
    expect(app.batch).toHaveBeenCalledOnce();
    expect(app.context.error).toBe('Stale state claim');
    expect(app.form().elements.namedItem('end_date').value).toBe('2026-12-31');
    expect(app.form().elements.namedItem('exceptions').value).toBe(text);
    expect(app.refresh).not.toHaveBeenCalled();
  });

  it('renders loaded values when not preserving drafts', () => {
    const app = setup({ exceptions: 'unsaved' });
    app.run('render()');
    expect(app.form().elements.namedItem('exceptions').value).toBe('');
  });

  it('keeps an archive failure visible without refreshing', async () => {
    const app = setup();
    await app.run('archive()');
    expect(app.context.error).toMatch(/Someone changed this timetable/);
    expect(app.context.selected.status).toBe('active');
    expect(app.context.busy).toBe(false);
    expect(app.refresh).not.toHaveBeenCalled();
  });

  it('refreshes once after a successful archive', async () => {
    const app = setup();
    app.batch.mockResolvedValue({});
    await app.run('archive()');
    expect(app.refresh).toHaveBeenCalledExactlyOnceWith('tt');
  });
});
