import { describe, expect, it } from 'vitest';
import { overlappingPeriod, validateBellTimes, validateLessons, validatePeriods } from '../src/logic.js';
import {
  BATCH_LIMITS, IMPORT_LIMITS, buildCandidate, candidateRows, carryOver, diffCandidate, digestText,
  normalizeTime, parseDayLabel, parseDelimited, parseTimeRange, parseTimetableText, planImportBatches,
} from '../src/import.js';

const candidateOf = text => buildCandidate(parseTimetableText(text));
const csv = lines => lines.join('\n');

describe('delimited text', () => {
  it('handles a BOM, CRLF, quoted delimiters, escaped quotes and newlines in cells', () => {
    const { delimiter, rows } = parseDelimited('\uFEFFa,b\r\n"x, y","say ""hi""\nthere"\r\n\r\nlast,row');
    expect(delimiter).toBe(',');
    expect(rows).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['x, y', 'say "hi"\nthere'] },
      { line: 5, cells: ['last', 'row'] },
    ]);
  });

  it('detects tab and semicolon delimiters from the first line', () => {
    expect(parseDelimited('a\tb,c\n1\t2').delimiter).toBe('\t');
    expect(parseDelimited('a;b;c\n1;2;3').delimiter).toBe(';');
    expect(parseDelimited('"x;y",b\n1,2').delimiter).toBe(',');
  });

  it('names the row of an unclosed quote', () => {
    expect(() => parseDelimited('a,b\n"open,b')).toThrow(/Row 2/);
  });
});

describe('times and day labels', () => {
  it('normalises clock formats', () => {
    expect(normalizeTime('8:30')).toBe('08:30');
    expect(normalizeTime('08.30')).toBe('08:30');
    expect(normalizeTime('1:15 pm')).toBe('13:15');
    expect(normalizeTime('12:05am')).toBe('00:05');
    expect(normalizeTime('3 p.m.')).toBe('15:00');
    expect(normalizeTime('9')).toBeNull();
    expect(normalizeTime('24:00')).toBeNull();
  });

  it('finds a range past a false start and inherits a trailing meridiem', () => {
    expect(parseTimeRange('P1 - 08:30-09:15')).toEqual({ start_time: '08:30', end_time: '09:15', label: 'P1' });
    expect(parseTimeRange('1:00-1:50pm')).toMatchObject({ start_time: '13:00', end_time: '13:50' });
    expect(parseTimeRange('11:30–12:20pm')).toMatchObject({ start_time: '11:30', end_time: '12:20' });
    expect(parseTimeRange('Period 2 (09:20 to 10:05)')).toEqual({ start_time: '09:20', end_time: '10:05', label: 'Period 2' });
    expect(parseTimeRange('09:15-08:30')).toBeNull();
    expect(parseTimeRange('08:30:00-09:15:00')).toEqual({ start_time: '08:30', end_time: '09:15', label: '' });
    expect(parseTimeRange('10:10:00 - 10:55:00')).toMatchObject({ start_time: '10:10', end_time: '10:55' });
    expect(normalizeTime('13:05:59')).toBe('13:05');
  });

  it('reads weekdays with weeks, and rotation days', () => {
    expect(parseDayLabel('Monday')).toEqual({ weekday: 0, week: 0 });
    expect(parseDayLabel('Week B Tuesday')).toEqual({ weekday: 1, week: 1 });
    expect(parseDayLabel('Fri (2)')).toEqual({ weekday: 4, week: 1 });
    expect(parseDayLabel('Day 3')).toEqual({ rotationDay: 2 });
    expect(parseDayLabel('3')).toBeNull();
    expect(parseDayLabel('3', { allowBareNumber: true })).toEqual({ rotationDay: 2 });
    expect(parseDayLabel('Mon 14/09')).toBeNull();
  });
});

describe('long format', () => {
  it('matches headers in any order and maps weeks to slots', () => {
    const c = candidateOf(csv([
      'Subject,Room,End,Start,Week,Day,Teacher',
      'Maths,Rm 12,09:15,08:30,A,Mon,Mr Okafor',
      'Art,Studio,09:15,08:30,2,Wed,',
    ]));
    expect(c.errors).toEqual([]);
    expect(c).toMatchObject({ shape: 'long', cycle_kind: 'weekly', cycle_length: 2 });
    expect(c.lessons).toEqual([
      expect.objectContaining({ slot: 0, subject: 'Maths', room: 'Rm 12', teacher: 'Mr Okafor' }),
      expect.objectContaining({ slot: 9, subject: 'Art', room: 'Studio' }),
    ]);
  });

  it('prefers an exact Subject column over an earlier Lesson or Class column', () => {
    const c = candidateOf('Day,Lesson,Class,Start,End,Subject,Room\nMon,1,7B,08:30,09:15,Maths,Rm 1');
    expect(c.lessons).toMatchObject([{ subject: 'Maths', room: 'Rm 1' }]);
    expect(candidateOf('Day,Start,End,Class\nMon,08:30,09:15,Biology').lessons).toMatchObject([{ subject: 'Biology' }]);
  });

  it('accepts a single time column or times inside the period column', () => {
    expect(candidateOf('Day,Time,Subject\nMon,8:30-9:15,Maths').periods).toMatchObject([{ start_time: '08:30', end_time: '09:15' }]);
    const c = candidateOf('Day,Period,Subject\nTue,Period 1 08:30-09:15,Maths');
    expect(c.periods).toMatchObject([{ label: 'Period 1', start_time: '08:30' }]);
  });

  it('refuses period names without bell times, weekend lessons and bad weeks, by row', () => {
    expect(candidateOf('Day,Period,Subject\nMon,P1,Maths').errors[0]).toMatch(/^Row 2: .*bell times/);
    expect(candidateOf('Day,Start,End,Subject\nSat,08:30,09:15,Maths').errors[0]).toMatch(/^Row 2: weekend/);
    expect(candidateOf('Day,Week,Start,End,Subject\nMon,E,08:30,09:15,Maths').errors[0]).toMatch(/^Row 2: week "E"/);
    expect(candidateOf('Day,Start,End,Subject\nMon,09:15,08:30,Maths').errors[0]).toMatch(/^Row 2: times/);
  });

  it('reads spreadsheet times with seconds in separate columns', () => {
    const c = candidateOf('Day,Start,End,Subject\nMon,08:30:00,09:15:00,Maths\nMon,10:10:00,10:55:00,Art');
    expect(c.errors).toEqual([]);
    expect(c.warnings).toEqual(['4 school days have no lessons in this import.']);
    expect(c.periods.map(p => p.key)).toEqual(['08:30-09:15', '10:10-10:55']);
  });

  it('gives separate start and end columns a shared am/pm, and warns about likely afternoon times', () => {
    expect(candidateOf('Day,Start,End,Subject\nMon,1:00,1:50 PM,Maths').periods).toMatchObject([{ start_time: '13:00', end_time: '13:50' }]);
    const bare = candidateOf('Day,Start,End,Subject\nMon,08:30,09:15,Maths\nMon,1:20,2:05,Art\nMon,12:30,1:15,Lunch club');
    expect(bare.errors).toEqual([]);
    expect(bare.periods.map(p => p.key)).toEqual(['08:30-09:15', '12:30-13:15', '13:20-14:05']);
    expect(bare.warnings).toContain('Times from 1:00 to 6:59 without am/pm were read as afternoon. Check the bell times below.');
    const early = candidateOf('Day,Start,End,Subject\nMon,1:00 AM,1:45 AM,Night class');
    expect(early.warnings).toContain('Lessons at 01:00-01:45 start before 07:00. If these are afternoon times, add pm and preview again.');
  });

  it('skips rows without a subject with a warning', () => {
    const c = candidateOf('Day,Start,End,Subject\nMon,08:30,09:15,\nMon,09:20,10:05,Maths');
    expect(c.errors).toEqual([]);
    expect(c.warnings[0]).toMatch(/Row 2: no subject/);
    expect(c.lessons).toHaveLength(1);
  });

  it('reads Day N and all-numeric day columns as a rotation', () => {
    expect(candidateOf('Day,Start,End,Subject\nDay 1,08:30,09:15,A\nDay 6,08:30,09:15,B')).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 6 });
    expect(candidateOf('Day,Start,End,Subject\n1,08:30,09:15,A\n4,08:30,09:15,B')).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 4 });
    const withBreak = candidateOf('Day,Start,End,Subject\n1,08:30,09:15,A\n,09:15,09:30,\n2,09:30,10:15,B');
    expect(withBreak.errors).toEqual([]);
    expect(withBreak).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 2 });
    expect(candidateOf('Day,Start,End,Subject\nMon,08:30,09:15,A\nDay 2,08:30,09:15,B').errors[0]).toMatch(/not both/);
  });
});

describe('grid paste', () => {
  it('reads days across and times down, splitting subject, room and teacher', () => {
    const grid = [
      'Time\tWeek A Mon\tWeek A Tue\tMon B',
      'Period 1 08:30-09:15\tMaths Rm 12\t"English\nMrs Patel\nRm 4"\t',
      '09:20-10:05\tScience - Lab 2\t\tPE',
    ].join('\n');
    const c = candidateOf(grid);
    expect(c.errors).toEqual([]);
    expect(c).toMatchObject({ shape: 'grid', cycle_kind: 'weekly', cycle_length: 2 });
    expect(c.periods.map(p => p.label)).toEqual(['Period 1', 'Period 2']);
    expect(c.lessons).toEqual([
      expect.objectContaining({ slot: 0, subject: 'Maths', room: 'Rm 12', period_key: '08:30-09:15' }),
      expect.objectContaining({ slot: 0, subject: 'Science', room: 'Lab 2' }),
      expect.objectContaining({ slot: 1, subject: 'English', room: 'Rm 4', teacher: 'Mrs Patel' }),
      expect.objectContaining({ slot: 7, subject: 'PE', period_key: '09:20-10:05' }),
    ]);
  });

  it('skips an empty Lunch row, refuses a cell with no subject by row', () => {
    const c = candidateOf('Time\tMon\tTue\n08:30-09:15\tMaths\tArt\nLunch\t\t\n12:30-13:15\tPE\tMusic');
    expect(c.errors).toEqual([]);
    expect(c.warnings).toContain('Row 3: "Lunch" has no times or lessons, skipped.');
    expect(c.lessons).toHaveLength(4);
    expect(candidateOf('Time\tMon\n08:30-09:15\tMr Smith, Rm 4').errors[0]).toBe('Row 2: a lesson has a room or teacher but no subject.');
    const noRoom = candidateOf('Time\tMon\n08:30-09:15\t"Ma\n9X/Ma2\nMr J Okafor"');
    expect(noRoom.lessons).toMatchObject([{ subject: 'Ma', room: '', teacher: 'Mr J Okafor', notes: '9X/Ma2' }]);
    const subjects = candidateOf('Time\tMon\tTue\tWed\tThu\n08:30-09:15\tGym\tHall\tLab Safety\tChemistry, Lab 3');
    expect(subjects.errors).toEqual([]);
    expect(subjects.lessons.map(l => [l.subject, l.room])).toEqual([['Gym', ''], ['Hall', ''], ['Lab Safety', ''], ['Chemistry', 'Lab 3']]);
  });

  it('counts declared but empty columns toward the cycle, keeping the minimum the lessons need', () => {
    const rotation = candidateOf('Time\tDay 1\tDay 2\tDay 3\n08:30-09:15\tMaths\tArt\t');
    expect(rotation).toMatchObject({ cycle_kind: 'day_rotation', cycle_length: 3, min_cycle_length: 2 });
    const weeks = candidateOf('Time\tMon A\tMon B\n08:30-09:15\tMaths\t');
    expect(weeks).toMatchObject({ cycle_kind: 'weekly', cycle_length: 2, min_cycle_length: 1 });
  });

  it('names a header that is not a day and a row without times', () => {
    expect(candidateOf('Time\tMon\tNotes\n08:30-09:15\tMaths\tx').errors[0]).toMatch(/column heading/);
    expect(candidateOf('Time\tMon\nPeriod 1\tMaths').errors[0]).toMatch(/Row 2: "Period 1".*bell times/);
  });

  it('refuses unrecognised layouts, empty input and oversized input', () => {
    expect(candidateOf('a,b\n1,2').errors[0]).toMatch(/recognise the layout/);
    expect(candidateOf('   ').errors[0]).toMatch(/Paste a timetable/);
    expect(candidateOf('x'.repeat(IMPORT_LIMITS.bytes + 1)).errors[0]).toMatch(/2 MB/);
    expect(candidateOf(`Day,Start,End,Subject\n${'Mon,08:30,09:15,A\n'.repeat(IMPORT_LIMITS.rows)}`).errors[0]).toMatch(/rows/);
  });
});

describe('candidate periods and lessons', () => {
  it('splits a double lesson across the periods it spans, including a break between them', () => {
    const c = candidateOf(csv([
      'Day,Start,End,Subject',
      'Mon,08:30,09:15,Maths',
      'Mon,09:20,10:05,English',
      'Tue,08:30,10:05,Science',
    ]));
    expect(c.errors).toEqual([]);
    expect(c.periods.map(p => p.key)).toEqual(['08:30-09:15', '09:20-10:05']);
    expect(c.lessons.filter(l => l.slot === 1)).toMatchObject([
      { subject: 'Science', period_key: '08:30-09:15' },
      { subject: 'Science', period_key: '09:20-10:05' },
    ]);
  });

  it('refuses bell times that overlap without lining up', () => {
    const c = candidateOf('Day,Start,End,Subject\nMon,08:30,09:15,A\nTue,09:00,09:45,B');
    expect(c.errors[0]).toMatch(/08:30-09:15 and 09:00-09:45 overlap/);
    const outer = candidateOf('Day,Start,End,Subject\nMon,08:30,09:15,A\nMon,09:20,10:05,B\nTue,08:30,09:50,C');
    expect(outer.errors.join()).toMatch(/does not line up|overlap/);
  });

  it('refuses a long lesson that covers one period plus extra time, or stops short of its last period', () => {
    expect(candidateOf('Day,Start,End,Subject\nMon,08:30,09:15,A\nTue,08:30,10:00,B').errors[0]).toMatch(/08:30-10:00 does not line up/);
    expect(candidateOf('Day,Start,End,Subject\nMon,08:30,09:15,A\nMon,09:20,10:05,B\nTue,08:00,10:05,C').errors[0]).toMatch(/08:00-10:05 does not line up/);
  });

  it('dedupes identical rows and refuses different lessons in one cell', () => {
    expect(candidateOf('Day,Start,End,Subject\nMon,08:30,09:15,A\nMon,08:30,09:15,A').lessons).toHaveLength(1);
    expect(candidateOf('Day,Start,End,Subject\nMon,08:30,09:15,A\nMon,08:30,09:15,B').errors[0]).toMatch(/Rows 2 and 3/);
  });

  it('caps bell periods and reports the error count beyond the first 20', () => {
    const rows = Array.from({ length: 17 }, (_, i) => `Mon,${String(7 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'},${String(7 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '55' : '25'},S${i}`);
    expect(candidateOf(csv(['Day,Start,End,Subject', ...rows])).errors[0]).toMatch(/17 different bell periods/);
    const bad = Array.from({ length: 25 }, () => 'Sun,08:30,09:15,A');
    const c = candidateOf(csv(['Day,Start,End,Subject', ...bad]));
    expect(c.errors).toHaveLength(20);
    expect(c.errorCount).toBe(25);
  });

  it('keeps a label only when every row agrees, and warns about empty school days', () => {
    const c = candidateOf('Day,Period,Subject\nMon,Reg 08:30-08:40,Registration\nTue,Form 08:30-08:40,Registration');
    expect(c.periods[0].label).toBe('Period 1');
    expect(c.warnings).toContain('3 school days have no lessons in this import.');
  });

  it('produces rows that pass the editor validators', () => {
    const c = candidateOf('Day,Week,Start,End,Subject\nMon,A,08:30,09:15,Maths\nMon,B,08:30,10:05,Science\nTue,A,09:20,10:05,Art');
    let n = 0;
    const t = { id: 'tt', cycle_kind: c.cycle_kind, cycle_length: c.cycle_length };
    const rows = candidateRows(c, t, 'adult', () => `id${n++}`);
    expect(() => validateLessons(rows.lessons, rows.periods, t)).not.toThrow();
    expect(rows.lessons.every(l => rows.periods.some(p => p.id === l.period_id))).toBe(true);
    expect(rows.lessons[0]).toMatchObject({ timetable_id: 'tt', color: '', notes: '', created_by: 'adult' });
  });

  it('checks overlap per saved period or whole import, but still loads older overlapping periods', () => {
    const p = (id, start_time, end_time, sort_order) => ({ id, start_time, end_time, sort_order });
    const legacy = [p('a', '08:30', '09:15', 0), p('b', '09:00', '09:45', 1), p('c', '09:30', '10:15', 2)];
    expect(() => validatePeriods(legacy)).not.toThrow();
    expect(() => validateBellTimes(legacy)).toThrow(/overlap/);
    expect(() => validateBellTimes([p('a', '08:30', '09:15', 0), p('b', '09:15', '10:00', 1)])).not.toThrow();
    expect(overlappingPeriod(p('b', '09:00', '09:45', 1), legacy)).toMatchObject({ id: 'a' });
    expect(overlappingPeriod(p('d', '10:15', '11:00', 3), legacy)).toBeNull();
  });

  it('refuses text longer than the editor allows, by row', () => {
    const long = 'x'.repeat(IMPORT_LIMITS.text + 1);
    expect(candidateOf(`Day,Start,End,Subject,Room\nMon,08:30,09:15,Maths,${long}`).errors[0]).toBe('Row 2: room is longer than 80 characters.');
    expect(candidateOf(`Day,Start,End,Subject\nMon,08:30,09:15,${'x'.repeat(IMPORT_LIMITS.text)}`).errors).toEqual([]);
  });
});

describe('replace diff', () => {
  const current = {
    timetable: { cycle_kind: 'weekly', cycle_length: 1 },
    periods: [{ id: 'p1', start_time: '08:30', end_time: '09:15' }, { id: 'p2', start_time: '09:20', end_time: '10:05' }],
    lessons: [
      { slot: 0, period_id: 'p1', subject: 'Maths', room: 'Rm 1', teacher: '' },
      { slot: 0, period_id: 'p2', subject: 'Art', room: '', teacher: '' },
      { slot: 1, period_id: 'p1', subject: 'PE', room: '', teacher: '' },
    ],
  };

  it('lists added, removed and changed lessons by slot and time', () => {
    const c = candidateOf('Day,Start,End,Subject,Room\nMon,08:30,09:15,Maths,Rm 2\nMon,09:20,10:05,Art,\nWed,10:10,10:55,Music,');
    const d = diffCandidate(c, current);
    expect(d.cycleChanged).toBe(false);
    expect(d.addedTimes).toEqual(['10:10-10:55']);
    expect(d.removedTimes).toEqual([]);
    expect(d.lessons).toEqual([
      { slot: 0, time: '08:30-09:15', change: 'changed', before: 'Maths · Rm 1', after: 'Maths · Rm 2' },
      { slot: 1, time: '08:30-09:15', change: 'removed', before: 'PE', after: '' },
      { slot: 2, time: '10:10-10:55', change: 'added', before: '', after: 'Music' },
    ]);
  });

  it('reports a cycle change and an identical import as no lesson changes', () => {
    const same = candidateOf('Day,Start,End,Subject,Room\nMon,08:30,09:15,Maths,Rm 1\nMon,09:20,10:05,Art,\nTue,08:30,09:15,PE,');
    expect(diffCandidate(same, current)).toEqual({ cycleChanged: false, kindChanged: false, lessonCounts: { before: 3, after: 3 }, addedTimes: [], removedTimes: [], lessons: [] });
    const twoWeek = candidateOf('Day,Week,Start,End,Subject,Room\nMon,A,08:30,09:15,Maths,Rm 1\nMon,B,09:20,10:05,Art,');
    expect(diffCandidate(twoWeek, current)).toMatchObject({ cycleChanged: true, kindChanged: false });
    expect(diffCandidate(twoWeek, current).lessons.length).toBeGreaterThan(0);
  });

  it('does not pair week slots with rotation days when the cycle kind changes', () => {
    const rotation = candidateOf('Day,Start,End,Subject\nDay 1,08:30,09:15,Maths\nDay 2,08:30,09:15,Art');
    expect(diffCandidate(rotation, current)).toMatchObject({ cycleChanged: true, kindChanged: true, lessons: [], lessonCounts: { before: 3, after: 2 } });
  });
});

describe('carrying over from a replaced timetable', () => {
  const current = {
    timetable: { cycle_kind: 'weekly' },
    periods: [{ id: 'old-p', start_time: '08:30', end_time: '09:15' }],
    lessons: [
      { slot: 0, period_id: 'old-p', subject: 'Maths', color: '#aa0000', notes: 'Bring calculator' },
      { slot: 1, period_id: 'old-p', subject: 'Art', color: '', notes: 'Apron' },
    ],
  };
  const rows = (kind = 'weekly') => ({ cycle_kind: kind,
    periods: [{ id: 'new-p', start_time: '08:30', end_time: '09:15' }],
    lessons: [
      { slot: 0, period_id: 'new-p', subject: 'Maths', color: '', notes: '' },
      { slot: 2, period_id: 'new-p', subject: 'Maths', color: '', notes: '' },
      { slot: 1, period_id: 'new-p', subject: 'Music', color: '', notes: '' },
    ] });

  it('keeps colours by subject and notes only on an unchanged lesson', () => {
    expect(carryOver(rows(), current).lessons.map(l => [l.color, l.notes])).toEqual([
      ['#aa0000', 'Bring calculator'], ['#aa0000', ''], ['', ''],
    ]);
  });

  it('does not match notes across cycle kinds, and never overwrites imported notes', () => {
    expect(carryOver(rows('day_rotation'), current).lessons[0]).toMatchObject({ color: '#aa0000', notes: '' });
    const own = rows();
    own.lessons[0].notes = '9X/Ma2';
    expect(carryOver(own, current).lessons[0].notes).toBe('9X/Ma2');
  });
});

describe('import batches', () => {
  // Largest supported import: 16 periods × 4 weeks × 5 days, every text field at the editor's max length.
  const largest = () => {
    const draft = { id: 'draft-id', revision: 0 };
    const periods = Array.from({ length: IMPORT_LIMITS.periods }, (_, i) => ({
      id: `period-${i}`.padEnd(36, 'x'), timetable_id: draft.id, label: 'P'.repeat(80),
      start_time: `${String(i + 6).padStart(2, '0')}:00`, end_time: `${String(i + 6).padStart(2, '0')}:50`, sort_order: i, created_by: 'member',
    }));
    const lessons = [];
    for (let week = 0; week < 4; week++) for (let day = 0; day < 5; day++) for (const p of periods) {
      lessons.push({ id: `lesson-${lessons.length}`.padEnd(36, 'x'), timetable_id: draft.id, slot: week * 7 + day, period_id: p.id,
        subject: 'S'.repeat(80), room: 'R'.repeat(80), teacher: 'T'.repeat(80), color: '#607cae', notes: '', created_by: 'member' });
    }
    return { draft, periods, lessons };
  };

  it('fits the largest import within statement, parameter and byte limits', () => {
    const { draft, periods, lessons } = largest();
    const { batches, revision } = planImportBatches(draft, periods, lessons, [], { prefix: 'app_timetable__', now: 'now' });
    expect(batches.length).toBeGreaterThan(1);
    expect(revision).toBe(batches.length);
    batches.forEach((batch, i) => {
      expect(batch.length).toBeLessThanOrEqual(BATCH_LIMITS.statements);
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(BATCH_LIMITS.bytes);
      expect(batch[0]).toEqual({
        sql: "UPDATE app_timetable__timetables SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'draft'",
        params: ['now', 'draft-id', i], requireChanges: true,
      });
      for (const s of batch) expect(s.params.length).toBeLessThanOrEqual(BATCH_LIMITS.params);
    });
    const inserted = batches.flatMap(b => b.slice(1));
    const ids = inserted.flatMap(s => {
      const width = s.sql.slice(s.sql.indexOf('(') + 1, s.sql.indexOf(')')).split(',').length;
      return s.params.filter((_, i) => i % width === 0);
    });
    expect(ids).toEqual([...periods.map(p => p.id), ...lessons.map(l => l.id)]);
    const lastPeriod = inserted.findLastIndex(s => s.sql.includes('__periods'));
    expect(inserted.findIndex(s => s.sql.includes('__lessons'))).toBe(lastPeriod + 1);
  });

  it('starts a new guarded batch when the byte budget is reached', () => {
    const { draft, periods, lessons } = largest();
    const small = planImportBatches(draft, periods, lessons, [], { prefix: 'app_timetable__', now: 'now', limits: { ...BATCH_LIMITS, bytes: 8_000 } });
    for (const batch of small.batches) expect(JSON.stringify(batch).length).toBeLessThanOrEqual(8_000);
    expect(small.batches.length).toBeGreaterThan(planImportBatches(draft, periods, lessons, [], { prefix: 'app_timetable__', now: 'now' }).batches.length);
  });

  it('measures UTF-8 bytes, not characters, for non-Latin text', () => {
    const { draft, periods, lessons } = largest();
    const wide = lessons.map(l => ({ ...l, subject: '数'.repeat(80), room: '室'.repeat(80), teacher: '師'.repeat(80) }));
    const { batches } = planImportBatches(draft, periods, wide, [], { prefix: 'app_timetable__', now: 'now' });
    for (const batch of batches) expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(BATCH_LIMITS.bytes);
  });

  it('inserts kept exceptions after periods and lessons', () => {
    const p = { id: 'p', timetable_id: 'd', label: 'P', start_time: '08:00', end_time: '08:50', sort_order: 0, created_by: 'm' };
    const l = { id: 'l', timetable_id: 'd', slot: 0, period_id: 'p', subject: 'S', room: '', teacher: '', color: '', notes: '', created_by: 'm' };
    const x = { id: 'x', timetable_id: 'd', start_date: '2026-10-19', end_date: '2026-10-23', kind: 'no_school', override_slot: null, label: 'Half term', created_by: 'm' };
    const { batches } = planImportBatches({ id: 'd', revision: 0 }, [p], [l], [x], { prefix: 'x_', now: 'n' });
    expect(batches[0].slice(1).map(s => s.sql.split(' (')[0])).toEqual(['INSERT INTO x_periods', 'INSERT INTO x_lessons', 'INSERT INTO x_exceptions']);
    expect(batches[0][3].params).toEqual(['x', 'd', '2026-10-19', '2026-10-23', 'no_school', null, 'Half term', 'm']);
  });

  it('continues from a draft revision other than zero', () => {
    const { batches, revision } = planImportBatches({ id: 'd', revision: 3 }, [{ id: 'p', timetable_id: 'd', label: 'P', start_time: '08:00', end_time: '08:50', sort_order: 0, created_by: 'm' }], [], [], { prefix: 'x_', now: 'n' });
    expect(batches[0][0].params).toEqual(['n', 'd', 3]);
    expect(revision).toBe(4);
  });
});

it('digests text as hex SHA-256', async () => {
  expect(await digestText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
