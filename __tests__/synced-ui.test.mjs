// Build from a synced calendar in index.html: reading one member's rows from the hub context endpoint, listing the
// calendars and opening the shared import review. Runs the functions against mocks, without a DOM.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as logic from '../src/logic.js';
import * as importer from '../src/import.js';
import * as inferer from '../src/infer.js';
import * as syncedModule from '../src/synced.js';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const source = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'family.calendar.member:kid';
// Six weeks of the same Monday–Friday lessons from one feed, plus a family calendar on the same Google account.
const lessons = Array.from({ length: 30 }, (_, i) => {
  const date = logic.addDays('2026-09-21', Math.floor(i / 5) * 7 + (i % 5));
  return { id: `ical:u${i}:x`, connectionId: 'feed', familyMemberId: 'kid', title: ['Maths', 'English', 'Art', 'PE', 'Music'][i % 5], startAt: `${date}T08:30:00.000Z`,
    endAt: `${date}T09:30:00.000Z`, allDay: false, location: 'R1', description: null, calendarName: null, updatedAt: 'x' };
});
const ROWS = [...lessons, { ...lessons[0], id: 'google:a:1', connectionId: 'g', calendarName: 'Family <home>', title: 'Dentist' }];

function setup({ response = { [KEY]: ROWS }, ok = true, role = 'adult', members = [{ id: 'kid', name: 'Kit', role: 'child' }, { id: 'parent', name: 'Pat', role: 'adult' }] } = {}) {
  const context = vm.createContext({
    ...logic, ...importer, ...inferer, ...syncedModule, esc,
    CONTEXT: '/ctx', DB: '/db', householdZone: 'UTC', today: '2026-09-18', localToday: () => '2026-09-18',
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : ['2026-09-18T10:00:00.000Z'])); } }, busy: false, error: '', members, me: { id: role === 'adult' ? 'parent' : 'kid', role },
    timetables: [], importReview: null, synced: null, renders: 0,
    render: () => { context.renders++; },
    adult: () => role === 'adult', nameOf: id => members.find(m => m.id === id)?.name ?? 'Student',
    loadComparison: vi.fn(async () => {}), followTerm: vi.fn(() => ''), digestText: vi.fn(async text => `digest(${text})`),
    fetch: vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => response })),
    AbortSignal: { timeout: ms => ({ timeout: ms }) }, root: { querySelector: () => null },
  });
  vm.runInContext(source("// Build from a synced calendar: one member's", "// The replace diff needs"), context);
  vm.runInContext(source('// Students read their own calendars', 'function importCard(){'), context);
  return context;
}

describe('reading synced calendars', () => {
  it('asks the context endpoint for one member over the sync horizon and lists their calendars', async () => {
    const app = setup();
    await app.loadSynced('kid');
    expect(app.fetch).toHaveBeenCalledWith('/ctx?keys=family.calendar.member%3Akid&days=56', { cache: 'no-store', signal: { timeout: 20000 } });
    expect(app.synced.fetchedAt).toBe('2026-09-18T10:00:00.000Z');
    expect(app.synced.state).toBe('ready');
    expect(app.synced.sources.map(s => [s.key, s.count])).toEqual([['feed|', 30], ['g|Family <home>', 1]]);
    const out = app.syncedHtml();
    expect(out).toContain('<strong>Calendar feed</strong> · 30 events, 2026-09-21 to 2026-10-30');
    expect(out).toContain('<strong>Family &lt;home&gt;</strong> · 1 event');
    expect(out.match(/checked/g)).toHaveLength(1);
  });

  it('shows the hub failure, a refused key and an error response distinctly', async () => {
    const failed = setup({ response: { [KEY]: [], $errors: [KEY] } });
    await failed.loadSynced('kid');
    expect(failed.synced).toEqual({ member: 'kid', state: 'error', error: 'Could not read synced calendars just now. Try again.' });
    const refused = setup({ response: {} });
    await refused.loadSynced('kid');
    expect(refused.synced.error).toMatch(/^Timetable cannot read synced calendars yet\. Reload the app/);
    const broken = setup({ ok: false, response: { error: 'Daily app data read limit exceeded' } });
    await broken.loadSynced('kid');
    expect(broken.synced.error).toBe('Daily app data read limit exceeded');
    expect(broken.syncedHtml()).toContain('role="alert"');
  });

  it('reports a fetch that times out or fails, instead of staying on loading', async () => {
    const slow = setup();
    slow.fetch = vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); });
    await slow.loadSynced('kid');
    expect(slow.synced).toEqual({ member: 'kid', state: 'error', error: 'Reading synced calendars took too long. Try again.' });
    slow.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await slow.loadSynced('kid');
    expect(slow.synced.error).toBe('Could not read synced calendars. Check the connection and try again.');
  });

  it('reports a body cut short as a failed read, not as refused access', async () => {
    const app = setup();
    app.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); } }));
    await app.loadSynced('kid');
    expect(app.synced.error).toBe('Reading synced calendars took too long. Try again.');
    app.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new TypeError('network error'); } }));
    await app.loadSynced('kid');
    expect(app.synced.error).toBe('Could not read synced calendars. Check the connection and try again.');
    app.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    await app.loadSynced('kid');
    expect(app.synced.error).toBe('Could not read synced calendars (502).');
  });

  it('keeps the member choice locked for a student after a load', async () => {
    const app = setup({ role: 'child' });
    const list = { innerHTML: '' }, find = { disabled: false }, select = { disabled: true };
    const form = { querySelector: q => (q === '#syncedSources' ? list : find), elements: { namedItem: () => select } };
    app.root = { querySelector: q => (q === '#importSynced' ? form : null) };
    await app.loadSynced('kid');
    expect([find.disabled, select.disabled]).toEqual([false, true]);
  });

  it('redraws only the synced form, locking the member choice while loading', async () => {
    const app = setup();
    const list = { innerHTML: '' }, find = { disabled: false }, select = { disabled: false };
    const form = { querySelector: q => (q === '#syncedSources' ? list : find), elements: { namedItem: () => select } };
    app.root = { querySelector: q => (q === '#importSynced' ? form : null) };
    let release;
    app.fetch = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const load = app.loadSynced('kid');
    expect([list.innerHTML, find.disabled, select.disabled]).toEqual(['<p class="small muted">Reading synced calendars…</p>', true, true]);
    release({ ok: true, status: 200, json: async () => ({ [KEY]: ROWS }) });
    await load;
    expect(list.innerHTML).toContain('Kit’s calendars');
    expect([find.disabled, select.disabled, app.renders]).toEqual([false, false, 0]);
  });

  it('says how to get events when the member has none', async () => {
    const app = setup({ response: { [KEY]: [] } });
    await app.loadSynced('kid');
    expect(app.syncedHtml()).toBe('<p class="small muted">No synced events for Kit in the next 8 weeks. Connect the school calendar in Calendar and sync it, then try again.</p>');
  });

  it('drops a load that finishes after another member was chosen', async () => {
    const app = setup();
    let release;
    app.fetch = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const first = app.loadSynced('kid');
    app.synced = { member: 'parent', state: 'ready', rows: [], sources: [] };
    release({ ok: true, status: 200, json: async () => ({ [KEY]: ROWS }) });
    await first;
    expect(app.synced).toEqual({ member: 'parent', state: 'ready', rows: [], sources: [] });
  });

  it('numbers unnamed calendars from the same provider', () => {
    const app = setup();
    const sources = [{ name: '', provider: 'ical' }, { name: '', provider: 'ical' }, { name: '', provider: 'google' }, { name: 'School', provider: 'google' }];
    app.sources = sources;
    expect(vm.runInContext('sources.map(s => sourceName(s, sources))', app)).toEqual(['Calendar feed 1', 'Calendar feed 2', 'Google calendar', 'School']);
  });

  it('lets a student read only their own calendars', () => {
    const app = setup({ role: 'child' });
    const card = app.syncedCard();
    expect(card).toContain('<select name="calendar_member" disabled><option value="kid" selected>Kit</option></select>');
  });
});

describe('restoring form drafts', () => {
  it('restores a radio group by ticking the chosen radio, never through the group value', () => {
    // Radios in a group untick each other, as in a browser; the redraw ticked 'c', the calendar previewed last.
    let ticked = 'c';
    const boxes = ['a', 'b', 'c'].map(value => ({ name: 'source', type: 'radio', value, get checked() { return ticked === value; }, set checked(on) { if (on) ticked = value; else if (ticked === value) ticked = null; } }));
    const group = { set value(v) { ticked = v; } };
    const form = { id: 'importSynced', dataset: {}, querySelectorAll: () => boxes, elements: { namedItem: name => (name === 'source' ? group : null) } };
    const context = vm.createContext({ root: { querySelectorAll: () => [form] }, formKey: f => f.id });
    vm.runInContext(source('function restoreForms(', 'function renderContent('), context);
    // Drafts as formDrafts records them: every radio that differs from its default, the ticked one and the unticked one.
    vm.runInContext('restoreForms(new Map([["importSynced", [{ name: "source", type: "radio", value: "a", checked: true }, { name: "source", type: "radio", value: "c", checked: false }]]]))', context);
    expect(boxes.map(b => b.checked)).toEqual([true, false, false]);
  });
});

describe('previewing a synced calendar', () => {
  it('opens the shared review with the inferred timetable, marked as a calendar import for the calendar owner', async () => {
    const app = setup();
    await app.loadSynced('kid');
    await app.previewSynced({ source: 'feed|' });
    const r = app.importReview;
    expect([r.source_kind, r.digest, r.student, r.fit, r.today]).toEqual(['calendar', 'digest(calendar:feed|)', 'kid', 0, '2026-09-18']);
    expect(r.candidate.errors).toEqual([]);
    expect([r.candidate.cycle_kind, r.candidate.cycle_length, r.candidate.lessons.length]).toEqual(['weekly', 1, 5]);
    expect(r.candidate.warnings[0]).toMatch(/only the next 8 weeks \(2026-09-19 to 2026-11-12\)/);
    expect(r.observations).toHaveLength(30);
    expect(app.loadComparison).toHaveBeenCalled();
  });

  it('places the window at the time the rows were read, not when Preview is pressed', async () => {
    const app = setup();
    await app.loadSynced('kid');
    const later = '2026-09-25T10:00:00.000Z';
    app.Date = class extends Date { constructor(...a) { super(...(a.length ? a : [later])); } };
    app.localToday = vi.fn((at = new app.Date()) => at.toISOString().slice(0, 10));
    await app.previewSynced({ source: 'feed|' });
    expect(app.localToday).toHaveBeenCalledWith(new Date('2026-09-18T10:00:00.000Z'));
    expect(app.importReview.today).toBe('2026-09-18');
    expect(app.importReview.candidate.warnings[0]).toMatch(/\(2026-09-19 to 2026-11-12\)/);
  });

  it('passes the read time as now, so a household date behind the UTC date starts the window after the UTC date', async () => {
    const app = setup();
    app.householdZone = 'America/Los_Angeles';
    app.Date = class extends Date { constructor(...a) { super(...(a.length ? a : ['2026-09-19T03:00:00.000Z'])); } };
    app.localToday = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(at);
    await app.loadSynced('kid');
    await app.previewSynced({ source: 'feed|' });
    expect(app.importReview.today).toBe('2026-09-18');
    expect(app.importReview.candidate.warnings[0]).toMatch(/\(2026-09-20 to 2026-11-12\)/);
  });

  it('remembers the chosen calendar for Back to edit', async () => {
    const app = setup();
    await app.loadSynced('kid');
    await app.previewSynced({ source: 'g|Family <home>' });
    expect(app.syncedHtml()).toMatch(/value="g\|Family &lt;home&gt;" style="width:auto" checked>/);
    expect(app.syncedHtml().match(/checked/g)).toHaveLength(1);
  });

  it('defaults an adult\'s calendar to the first child, since a parent\'s calendar often holds the school feed', async () => {
    const app = setup({ response: { 'family.calendar.member:parent': ROWS }, members: [{ id: 'parent', name: 'Pat', role: 'adult' }, { id: 'kid', name: 'Kit', role: 'child' }] });
    await app.loadSynced('parent');
    await app.previewSynced({ source: 'feed|' });
    expect(app.importReview.student).toBe('kid');
    const adultsOnly = setup({ response: { 'family.calendar.member:parent': ROWS }, members: [{ id: 'parent', name: 'Pat', role: 'adult' }] });
    await adultsOnly.loadSynced('parent');
    await adultsOnly.previewSynced({ source: 'feed|' });
    expect(adultsOnly.importReview.student).toBe('parent');
  });

  it('defaults to the calendar owner even when another member is listed first', async () => {
    const app = setup({ members: [{ id: 'parent', name: 'Pat', role: 'adult' }, { id: 'kid', name: 'Kit', role: 'child' }] });
    await app.loadSynced('kid');
    await app.previewSynced({ source: 'feed|' });
    expect(app.importReview.student).toBe('kid');
  });

  it('defaults to the first student when the calendar belongs to a guest, and to the reader when not an adult', async () => {
    const guest = setup({ response: { 'family.calendar.member:g1': ROWS }, members: [{ id: 'g1', name: 'Gran', role: 'guest' }, { id: 'kid', name: 'Kit', role: 'child' }] });
    await guest.loadSynced('g1');
    await guest.previewSynced({ source: 'feed|' });
    expect(guest.importReview.student).toBe('kid');
    const child = setup({ role: 'child' });
    await child.loadSynced('kid');
    await child.previewSynced({ source: 'feed|' });
    expect(child.importReview.student).toBe('kid');
  });

  it('refuses before the calendars are read or without a choice, and opens a review listing the errors', async () => {
    const app = setup();
    await expect(app.previewSynced({ source: 'feed|' })).rejects.toThrow('Find the synced calendars first.');
    await app.loadSynced('kid');
    await expect(app.previewSynced({})).rejects.toThrow('Choose a calendar.');
    app.householdZone = null;
    await app.previewSynced({ source: 'feed|' });
    expect(app.importReview.candidate.errors[0]).toMatch(/no time zone set/);
    expect(app.importReview.digest).toBe('');
  });
});
