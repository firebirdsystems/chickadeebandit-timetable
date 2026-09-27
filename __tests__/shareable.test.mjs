import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const item = manifest.shareable?.timetable;

/**
 * A share link is an anonymous read that skips row policies, so the declared columns and the calendar query are the
 * whole public surface. The share panel tells the adult what stays in the household; these hold the manifest to that
 * sentence.
 */
describe('shareable.timetable', () => {
  it('anchors on the timetables table by id, titled by name', () => {
    expect(item.table).toBe('timetables');
    expect(item.id_column ?? 'id').toBe('id');
    expect(item.title_column).toBe('name');
  });

  it('projects the term dates and nothing else', () => {
    expect(item.columns).toEqual([
      { column: 'start_date', label: 'From', format: 'date' },
      { column: 'end_date', label: 'Until', format: 'date' },
    ]);
    expect(item.aggregates).toBeUndefined();
    expect(item.feed).toBeUndefined();
    expect(item.feeds).toBeUndefined();
  });

  // A draft is half-built and an archived timetable has been replaced; neither should be readable from outside.
  it('resolves only while the timetable is active, on a plaintext column', () => {
    expect(item.visible_where).toEqual({ column: 'status', values: ['active'] });
    expect(manifest.db_plaintext_columns).toContain('status');
  });

  // Timetables are owner_only with an adult bypass: the owner is the student, and adults mint. owner_column would
  // let only the child mint.
  it('lets adults mint, with no owner gate', () => {
    expect(item.owner_column).toBeUndefined();
    expect(item.mint_roles).toBeUndefined();
  });

  // The page and feed are for a grandparent or another family: the schedule, not who the child is, who teaches
  // them, or what the household wrote down.
  it('never names the child, the teachers, notes or the author', () => {
    const json = JSON.stringify(item);
    for (const col of ['member_id', 'created_by', 'teacher', 'notes', 'color', 'source_digest']) {
      expect(json).not.toContain(col);
    }
  });

  it('serves each lesson on each school day as a calendar event', () => {
    const { source } = item.calendar;
    expect(source.kind).toBe('sql');
    expect(source.query).toBe(
      "SELECT l.id || ':' || s.day_date AS uid, l.subject AS title, s.day_date AS start_date, "
      + 'p.start_time AS start_time, p.end_time AS end_time, l.room AS location '
      + 'FROM app_timetable__school_days s '
      + 'JOIN app_timetable__lessons l ON l.timetable_id = s.timetable_id AND l.slot = s.slot '
      + 'JOIN app_timetable__periods p ON p.id = l.period_id AND p.timetable_id = s.timetable_id '
      + 'WHERE s.timetable_id = :item_id AND s.day_date BETWEEN :range_start AND :range_end '
      + 'ORDER BY s.day_date, p.start_time LIMIT 2000',
    );
    expect(Object.keys(item.calendar)).toEqual(['source']);
  });

  it('selects only calendar aliases', () => {
    const { query } = item.calendar.source;
    const outputs = [...query.slice(0, query.indexOf(' FROM ')).matchAll(/ AS (\w+)/g)].map((m) => m[1]);
    expect(outputs).toEqual(['uid', 'title', 'start_date', 'start_time', 'end_time', 'location']);
  });

  // The hub binds :item_id to the link's timetable and the range tokens to the feed window. Both are SQL comparisons,
  // so the compared columns must be plaintext: timetable_id and day_date by suffix, slot by declaration.
  it('scopes the feed to the shared timetable and the window, on plaintext columns', () => {
    const { query } = item.calendar.source;
    expect(query).toMatch(/s\.timetable_id = :item_id/);
    expect(query).toMatch(/s\.day_date BETWEEN :range_start AND :range_end/);
    expect(query).not.toMatch(/:today|:me\b|;|--|\/\*/);
    expect(manifest.db_plaintext_columns).toContain('slot');
  });

  it('offers the longer calendar expiries and the calendar link in the panel', () => {
    expect(page).toMatch(/expiryChoices:\s*SHARE_CALENDAR_EXPIRY_CHOICES/);
    expect(page).toMatch(/calendarUrl:\s*\(link\)\s*=>\s*share\.calendarUrl\(link\)/);
  });

  it('is read-only and is the item type the page mints', () => {
    expect(item.submit).toBeUndefined();
    expect(item.files).toBeUndefined();
    expect(Object.keys(manifest.shareable)).toEqual(['timetable']);
    expect(page).toMatch(/itemType:\s*"timetable"/);
  });

  // The button is gated on canShareTimetable, both when drawn and when clicked (see logic.test.mjs).
  it('opens the panel only through the share gate', () => {
    expect(page).toMatch(/const mayShare=t=>canShareTimetable\(t,\{enabled:share\.enabled,adult:isAdult\(HUB_MEMBER\)\}\);/);
    expect(page).toMatch(/mayShare\(selected\)\?`<button data-share-timetable=/);
    expect(page).toMatch(/if\(mayShare\(t\)\)shareUi\.open\(/);
  });

  it('tells the sharer what the link shows and what stays in the household', () => {
    const scope = page.match(/scopeHtml:\s*\(\)\s*=>\s*"([^"]+)"/)?.[1] ?? '';
    const sentences = scope.split('. ');
    const shown = sentences.find((s) => s.startsWith('The page shows')) ?? '';
    for (const phrase of ['name', 'dates', 'subject', 'time', 'room']) expect(shown).toContain(phrase);
    const kept = sentences.find((s) => s.includes('stay in the household')) ?? '';
    for (const phrase of ['child', 'teachers', 'notes']) expect(kept).toContain(phrase);
  });
});
