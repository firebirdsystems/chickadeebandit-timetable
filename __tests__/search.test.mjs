// Lesson search: the per-app search convention (searchableFields) and the id set the grid highlights.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { matchingLessonIds, searchableFields } from '../src/logic.js';

// The hub's searchMatch lives in /hub-sdk.js, which is not in this repo. This mirrors its contract closely enough for
// these tests: every whitespace token must appear in some field, case- and accent-insensitively.
const norm = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const searchMatch = (q, fields) => norm(q).split(/\s+/).filter(Boolean).every(tok => fields.some(f => f != null && norm(f).includes(tok)));

const lesson = (id, subject, extra = {}) => ({ id, subject, room: '', teacher: '', notes: '', ...extra });
const lessons = [
  lesson('a', 'Maths', { room: 'Rm 12', teacher: 'Mr Smith' }),
  lesson('b', 'English', { room: 'Rm 4', teacher: 'Ms Jones', notes: 'bring the Macbeth copy' }),
  lesson('c', 'PE', { room: 'Gym', teacher: 'Mr Smith' }),
  lesson('d', 'Français', { room: 'Rm 12' }),
];

describe('searchableFields', () => {
  it('finds a lesson by subject, room, teacher and notes', () => {
    expect(searchableFields(lessons[1])).toEqual(['English', 'Rm 4', 'Ms Jones', 'bring the Macbeth copy']);
  });
});

describe('matchingLessonIds', () => {
  const ids = q => matchingLessonIds(lessons, q, searchMatch);

  it('is null with no query, so nothing is dimmed', () => {
    expect(ids('')).toBeNull();
    expect(ids('   ')).toBeNull();
    expect(ids(undefined)).toBeNull();
  });

  it('matches across fields, every word required', () => {
    expect([...ids('smith')]).toEqual(['a', 'c']);
    expect([...ids('rm 12')]).toEqual(['a', 'd']);
    expect([...ids('smith gym')]).toEqual(['c']);
    expect([...ids('macbeth')]).toEqual(['b']);
    expect([...ids('francais')]).toEqual(['d']);
  });

  it('is an empty set, not null, when a query matches nothing', () => {
    expect(ids('chemistry')).toEqual(new Set());
  });
});

describe('the lessons grid', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('function applyLessonSearch('), html.indexOf("root.addEventListener('click'"));

  const cell = id => {
    const classes = new Set();
    return { dataset: { search: id }, classes, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  };
  const setup = query => {
    const cells = [cell('a'), cell('b'), cell(''), cell('c')];
    const count = { textContent: 'stale' };
    const context = vm.createContext({
      lessons, lessonQuery: query, searchMatch, matchingLessonIds,
      root: { querySelectorAll: () => cells, querySelector: () => count },
    });
    vm.runInContext(source, context);
    vm.runInContext('applyLessonSearch()', context);
    return { cells: cells.map(c => [...c.classes].join(' ')), count: count.textContent };
  };

  it('highlights matches and dims every other cell, empty and covered ones included', () => {
    expect(setup('smith')).toEqual({ cells: ['match', 'dim', 'dim', 'match'], count: '2 lessons match' });
    expect(setup('jones').count).toBe('1 lesson matches');
  });

  it('says when nothing matches, and clears both classes and the count when the query is emptied', () => {
    expect(setup(' chemistry ')).toEqual({ cells: ['dim', 'dim', 'dim', 'dim'], count: 'No lessons match “chemistry”' });
    expect(setup('')).toEqual({ cells: ['', '', '', ''], count: '' });
  });
});
