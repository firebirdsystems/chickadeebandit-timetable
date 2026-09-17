// Calendars in the shapes real school systems export, from their documentation, parsers built against real exports,
// and published sample files (see the plan's "Calendar formats seen" notes). Each is imported with the review's
// defaults and checked on dates after the export ends, where only a right timetable shows the right lessons.
import { describe, expect, it } from 'vitest';
import { parseIcs } from '../src/ics.js';
import { candidateForFit, checkObservedDays, inferTimetable } from '../src/infer.js';
import { candidateRows } from '../src/import.js';
import { addDays, anchorFromPhase, clipExceptions, mondayOf, projectSchoolDays, weekday } from '../src/logic.js';

const TODAY = '2026-09-16';
const range = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const compact = date => date.replaceAll('-', '');
const hhmm = time => time.replace(':', '');
const weekAB = (date, anchor) => (Math.round((new Date(mondayOf(date)) - new Date(anchor)) / 6048e5) % 2) * 7 + weekday(date);

// The school's days: slot for each date (null = no school), and that day's lessons as { start, end, subject, room, teacher }.
function school(start, end, slotOf, lessonsOf) {
  const days = new Map();
  for (const date of range(start, end)) {
    const slot = weekday(date) > 4 ? null : slotOf(date);
    if (slot !== null) days.set(date, { slot, lessons: lessonsOf(date, slot) });
  }
  return days;
}

// UTC stamp for a wall time in a zone (whole-hour and half-hour zones only need Intl here).
function utcStamp(date, time, zone) {
  const guess = Date.UTC(...date.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)), ...time.split(':').map(Number));
  const parts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms).map(p => [p.type, p.value]));
  const wall = ms => { const p = parts(ms); return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)); };
  let ms = guess - (wall(guess) - guess);
  ms -= wall(ms) - guess;
  return new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
}

const wrap = (lines, head = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...head, ...lines, 'END:VCALENDAR'].join('\r\n');

function importCalendar(text, zone) {
  const parsed = parseIcs(text, { timezone: zone, from: addDays(TODAY, -120), to: addDays(TODAY, 366) });
  const inference = inferTimetable(parsed);
  const c = candidateForFit(inference, parsed.observations, 0);
  if (c.errors.length) return { c, parsed };
  const { term, phase, holidays } = c.ics;
  const closed = clipExceptions(holidays.filter(h => h.ticked).flatMap(h => (h.dates ?? [h.start_date]).map(date => ({ kind: 'no_school', start_date: date, end_date: h.dates ? date : h.end_date }))), term.start, term.end);
  const anchor_date = anchorFromPhase(phase.date, c.cycle_kind, c.cycle_length, phase.phase - 1, closed);
  return { c, parsed, closed, t: { id: 't', name: 'School', cycle_kind: c.cycle_kind, cycle_length: c.cycle_length, start_date: term.start, end_date: term.end, anchor_date, override_consumes_cycle_day: 0 } };
}

// Dates in [from, to] where the saved timetable shows different subjects at different times from the school.
function wrongDates({ c, t, closed }, days, from, to, daysOff = []) {
  const extended = { ...t, end_date: to };
  const exceptions = clipExceptions([...closed, ...daysOff.map(date => ({ kind: 'no_school', start_date: date, end_date: date }))], t.start_date, to);
  const saved = new Map(projectSchoolDays(extended, exceptions).map(r => [r.day_date, r.slot]));
  const shown = slot => c.lessons.filter(l => l.slot === slot).map(l => `${l.period_key} ${l.subject}`).sort().join(', ');
  const wrong = [];
  for (const [date, { lessons }] of days) {
    if (date < from || date > to) continue;
    const real = lessons.map(l => `${l.start}-${l.end} ${l.subject}`).sort().join(', ');
    if (!saved.has(date) || shown(saved.get(date)) !== real) wrong.push(date);
  }
  return wrong;
}

const BELLS = [['08:55', '10:15'], ['10:35', '11:55'], ['12:00', '13:20'], ['14:00', '15:20']];
const SUBJECTS = ['English', 'Mathematics', 'Science', 'History', 'Geography', 'PDHPE', 'Music', 'Visual Arts', 'Commerce', 'Information & Software Technology'];
// A Week A/B timetable with four lessons a day, every subject in its usual room with its usual teacher.
const lessonsAB = (date, slot) => BELLS.map(([start, end], p) => {
  const k = (slot * 3 + p * 7) % SUBJECTS.length;
  return { start, end, name: SUBJECTS[k], subject: `10${SUBJECTS[k].slice(0, 3).toUpperCase()}1: ${SUBJECTS[k]} Yr10`, room: `${200 + k}`, teacher: `Teacher ${k + 1}` };
});

describe('Sentral (Australia): one event per lesson in UTC, no cycle labels, about one term', () => {
  // Term 3 2026 in NSW: 20 July to 25 September; term 4 from 12 October.
  const term3 = school('2026-07-20', '2026-12-17', date => (date >= '2026-09-26' && date <= '2026-10-11' ? null : weekAB(date, '2026-07-20')), lessonsAB);
  const export_ = (to, extra = () => []) => wrap([...term3].filter(([date]) => date <= to).flatMap(([date, { lessons }], d) => lessons.flatMap((l, p) => [
    'BEGIN:VEVENT', `DTSTART:${utcStamp(date, l.start, 'Australia/Sydney')}`, `DTSTAMP:20260915T030250Z`, `DTEND:${utcStamp(date, l.end, 'Australia/Sydney')}`,
    `UID:${(d * 10 + p).toString(16).padStart(40, '0')}@sentral.local`, `DESCRIPTION:Teacher: ${l.teacher}\\nPeriod: ${p + 1}`,
    `SUMMARY:${l.subject.replace('&', '&amp;')}`, `LOCATION:Room: ${l.room}`, 'END:VEVENT', ...extra(date, p)])),
  ['PRODID:-//Sentral//Sentral Timetable//EN', 'PRODID:-//Sabre//Sabre VObject 4.5.4//EN', 'VERSION:2.0']);

  it('places lessons on their Sydney dates, reads the room and teacher, and shows term 4 right', () => {
    const saved = importCalendar(export_('2026-09-25'), 'Australia/Sydney');
    expect(saved.c.errors).toEqual([]);
    expect(saved.parsed.warnings).toEqual([]);
    expect(saved.c).toMatchObject({ cycle_kind: 'weekly', cycle_length: 2 });
    expect(saved.c.lessons.find(l => l.subject === '10INF1: Information & Software Technology Yr10')).toMatchObject({ room: '209', teacher: 'Teacher 10' });
    expect(wrongDates(saved, term3, '2026-10-12', '2026-12-17')).toEqual([]);
  });

  it('keeps a lesson listed twice for two supervising teachers as one lesson', () => {
    const doubled = (date, p) => (weekday(date) === 3 && p === 3 ? ['BEGIN:VEVENT', `DTSTART:${utcStamp(date, BELLS[3][0], 'Australia/Sydney')}`, `DTEND:${utcStamp(date, BELLS[3][1], 'Australia/Sydney')}`,
      `UID:sport${date}@sentral.local`, 'DESCRIPTION:Teacher: Second Teacher', `SUMMARY:${lessonsAB(date, weekAB(date, '2026-07-20'))[3].subject.replace('&', '&amp;')}`, 'LOCATION:Room: 212', 'END:VEVENT'] : []);
    const saved = importCalendar(export_('2026-09-25', doubled), 'Australia/Sydney');
    expect(saved.c.errors).toEqual([]);
    expect(wrongDates(saved, term3, '2026-10-12', '2026-12-17')).toEqual([]);
  });

  it('keeps a weekday with its own bell times, as the real export this is modelled on has', () => {
    // Wednesdays start later and run shorter lessons.
    const WED = [['08:55', '10:34'], ['10:54', '12:07'], ['12:12', '13:26'], ['14:06', '15:20']];
    const ownBells = school('2026-07-20', '2026-12-17', date => (date >= '2026-09-26' && date <= '2026-10-11' ? null : weekAB(date, '2026-07-20')), (date, slot) => lessonsAB(date, slot).map((l, p) => (weekday(date) === 2 ? { ...l, start: WED[p][0], end: WED[p][1] } : l)));
    const text = wrap([...ownBells].filter(([date]) => date <= '2026-09-25').flatMap(([date, { lessons }]) => lessons.flatMap((l, p) => ['BEGIN:VEVENT', `UID:${compact(date)}${p}@sentral.local`,
      `DTSTART:${utcStamp(date, l.start, 'Australia/Sydney')}`, `DTEND:${utcStamp(date, l.end, 'Australia/Sydney')}`, `SUMMARY:${l.subject.replace('&', '&amp;')}`, 'END:VEVENT'])));
    const saved = importCalendar(text, 'Australia/Sydney');
    expect(saved.c.errors).toEqual([]);
    expect(saved.c.warnings).toEqual([]);
    expect(saved.c.periods.map(p => p.key)).toEqual(['08:55-10:15', '08:55-10:34', '10:35-11:55', '10:54-12:07', '12:00-13:20', '12:12-13:26', '14:00-15:20', '14:06-15:20']);
    expect(saved.c.lessons.filter(l => l.slot === 2).map(l => l.period_key)).toEqual(['08:55-10:34', '10:54-12:07', '12:12-13:26', '14:06-15:20']);
    expect(wrongDates(saved, ownBells, '2026-10-12', '2026-12-17')).toEqual([]);
  });
});

describe('Blackbaud (US independent schools): day labels as all-day events ending on their start day, TZID with no VTIMEZONE', () => {
  const BB = [['08:14', '08:54'], ['08:58', '09:38'], ['09:42', '10:22'], ['10:26', '11:06'], ['13:11', '13:51'], ['13:55', '14:35']];
  const COURSES = ['World History - 1 (1)', 'Geometry Honors - 2 (2)', 'Language Arts - 3 (3)', 'Creative Writing - 4 (4)', 'Earth Science - 8 (8)', 'French A - 9 (9)', 'Jazz Ensemble 678 - MF 7 (7)'];
  const offs = new Set(['2026-09-07', '2026-10-12', ...range('2026-11-25', '2026-11-27')]);
  const days = school('2026-08-24', '2026-12-18', date => (offs.has(date) ? null : weekAB(date, '2026-08-24')), (date, slot) => BB.map(([start, end], p) => ({ start, end, subject: COURSES[(p + (slot === 9 || slot === 10 ? 3 : 0)) % COURSES.length] })));
  const label = (date, slot) => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][slot % 7] + (slot % 7 === 2 || slot % 7 === 3 ? (slot < 7 ? ' A' : ' B') : '') + ' (BRMS)';
  const text = to => wrap([...days].filter(([date]) => date <= to).flatMap(([date, { slot, lessons }]) => [
    'BEGIN:VEVENT', `SUMMARY:${label(date, slot)}`, `DTSTART;VALUE=DATE:${compact(date)}`, `DTEND;VALUE=DATE:${compact(date)}`, 'DTSTAMP:20260823T175159', `UID:label-${date}`, 'CATEGORIES:podium,events', 'CLASS:PUBLIC', 'STATUS:CONFIRMED', 'END:VEVENT',
    ...lessons.flatMap((l, p) => ['BEGIN:VEVENT', `SUMMARY:${l.subject}`, `DTSTART;TZID=America/New_York:${compact(date)}T${hhmm(l.start)}00`, `DTEND;TZID=America/New_York:${compact(date)}T${hhmm(l.end)}00`, 'DTSTAMP:20260823T175159', `UID:${date}-${p}`, 'CATEGORIES:podium,events', 'STATUS:CONFIRMED', 'END:VEVENT'])]),
  ['PRODID:-//Blackbaud Inc//Calendar//EN', 'CALSCALE:GREGORIAN']);

  it('reads the day labels as days, not skipped dates, and shows later weeks right', () => {
    const saved = importCalendar(text('2026-10-23'), 'America/New_York');
    expect(saved.parsed.warnings).toEqual([]);
    expect(saved.parsed.observations.filter(o => o.all_day).length).toBe([...days.keys()].filter(d => d <= '2026-10-23').length);
    expect(saved.c.errors).toEqual([]);
    expect(saved.c).toMatchObject({ cycle_kind: 'weekly', cycle_length: 2 });
    expect(wrongDates(saved, days, '2026-10-26', '2026-12-18', [...offs])).toEqual([]);
  });
});

describe('Exchange and SIMS through Office 365: weekly rules in a Windows zone, with exceptions and moved lessons', () => {
  const VTZ = ['BEGIN:VTIMEZONE', 'TZID:GMT Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:16010101T010000', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT', 'END:VTIMEZONE'];
  const halfTerm = range('2026-10-26', '2026-10-30');
  const days = school('2026-09-07', '2027-02-12', date => (halfTerm.includes(date) || (date >= '2026-12-21' && date <= '2027-01-01') ? null : weekAB(date, '2026-09-07')), lessonsAB);
  // One rule per lesson of the fortnight, repeating every two weeks, with the holidays as EXDATEs.
  const series = (zoneName, until) => [...days].filter(([date]) => date < '2026-09-21').flatMap(([date, { lessons }]) => lessons.flatMap((l, p) => {
    const skipped = [...halfTerm, ...range('2026-12-21', '2027-01-01')].filter(d => weekday(d) === weekday(date) && weekAB(d, '2026-09-07') === weekAB(date, '2026-09-07'));
    return ['BEGIN:VEVENT', `UID:${date}-${p}@sims`, `SUMMARY:${l.subject}`, `LOCATION:${l.room}`, `DTSTART;TZID=${zoneName}:${compact(date)}T${hhmm(l.start)}00`, `DTEND;TZID=${zoneName}:${compact(date)}T${hhmm(l.end)}00`,
      `RRULE:FREQ=WEEKLY;UNTIL=${compact(until)}T235900Z;INTERVAL=2;BYDAY=${['MO', 'TU', 'WE', 'TH', 'FR'][weekday(date)]};WKST=SU`,
      ...(skipped.length ? [`EXDATE;TZID=${zoneName}:${skipped.map(d => `${compact(d)}T${hhmm(l.start)}00`).join(',')}`] : []),
      'X-MICROSOFT-CDO-BUSYSTATUS:BUSY', 'X-MICROSOFT-CDO-ALLDAYEVENT:FALSE', 'END:VEVENT'];
  }));

  it('expands the rules through the clock change and half term, and a moved lesson does not change the timetable', () => {
    const moved = ['BEGIN:VEVENT', 'UID:2026-09-08-1@sims', 'RECURRENCE-ID;TZID=GMT Standard Time:20261006T103500', `SUMMARY:${lessonsAB('2026-09-08', 1)[1].subject}`, 'LOCATION:Library',
      'DTSTART;TZID=GMT Standard Time:20261006T103500', 'DTEND;TZID=GMT Standard Time:20261006T115500', 'END:VEVENT'];
    const saved = importCalendar(wrap([...series('GMT Standard Time', '2026-12-18'), ...moved], ['PRODID:Microsoft Exchange Server 2010', ...VTZ]), 'Europe/London');
    expect(saved.parsed.warnings).toEqual([]);
    expect(saved.c.errors).toEqual([]);
    expect(saved.c).toMatchObject({ cycle_kind: 'weekly', cycle_length: 2 });
    expect(saved.c.ics.holidays.find(h => h.start_date === '2026-10-26')).toMatchObject({ end_date: '2026-10-30' });
    expect(wrongDates(saved, days, '2027-01-04', '2027-02-12', [])).toEqual([]);
  });

  it('reads an unnamed "Customized Time Zone" as the household zone when its offsets match, and warns when they do not', () => {
    const custom = VTZ.map(line => line.replace('TZID:GMT Standard Time', 'TZID:Customized Time Zone'));
    const text = wrap(series('Customized Time Zone', '2026-12-18'), ['PRODID:Microsoft Exchange Server 2010', ...custom]);
    const london = importCalendar(text, 'Europe/London');
    expect(london.parsed.warnings).toEqual([]);
    expect(wrongDates(london, days, '2027-01-04', '2027-02-12', [])).toEqual([]);
    expect(parseIcs(text, { timezone: 'Europe/Berlin', from: '2026-09-01', to: '2026-12-31' }).warnings).toEqual(['Unrecognised time zone "Customized Time Zone": those times were read as local times. Check the bell times below.']);
    // A display name with its UTC offset, and no VTIMEZONE block.
    const named = wrap(series('"(UTC-05:00) Eastern Time (US & Canada)"', '2026-12-18'));
    expect(parseIcs(named, { timezone: 'America/New_York', from: '2026-09-01', to: '2026-12-31' }).warnings).toEqual([]);
    expect(parseIcs(named, { timezone: 'Europe/London', from: '2026-09-01', to: '2026-12-31' }).warnings).toEqual(['Unrecognised time zone "(UTC-05:00) Eastern Time (US & Canada)": those times were read as local times. Check the bell times below.']);
  });
});

describe('Pronote (France): dated lessons in UTC, details as "Clé : valeur" lines, holidays as all-day events', () => {
  const toussaint = range('2026-10-19', '2026-10-30'), noel = range('2026-12-21', '2027-01-01');
  const PARIS = [['08:00', '09:00'], ['09:00', '10:00'], ['10:15', '11:15'], ['11:15', '12:15'], ['13:30', '14:30']];
  const MATIERES = ['MATHEMATIQUES', 'FRANCAIS', 'HISTOIRE-GEOGRAPHIE', 'ANGLAIS LV1', 'SCIENCES VIE & TERRE', 'EDUCATION PHYSIQUE & SPORTIVE', 'PHYSIQUE-CHIMIE'];
  const days = school('2026-09-01', '2027-02-05', date => (toussaint.includes(date) || noel.includes(date) || weekday(date) === 2 ? null : weekAB(date, '2026-08-31')), (date, slot) => PARIS.map(([start, end], p) => {
    const k = (Math.floor(slot / 7) * 4 + weekday(date) + p * 3) % MATIERES.length;
    return { start, end, subject: MATIERES[k], room: `B${10 + k}`, teacher: `M. PROF${k}` };
  }));
  const text = to => wrap([
    ...[...days].filter(([date]) => date <= to).flatMap(([date, { lessons }]) => lessons.flatMap((l, p) => ['BEGIN:VEVENT', `UID:Cours-${compact(date)}-${p}@index-education.net`, `CATEGORIES:${date === '2026-09-15' && p === 0 ? 'Cours,Remplacement' : 'Cours'}`,
      `DTSTART:${utcStamp(date, l.start, 'Europe/Paris')}`, `DTEND:${utcStamp(date, l.end, 'Europe/Paris')}`, `SUMMARY:${l.subject.replace('&', '&amp;')} - ${l.teacher}`,
      `DESCRIPTION:Matière : ${l.subject}\\nProfesseur(s) : ${l.teacher}\\nSalle(s) : ${l.room}\\nGroupe(s) : 5EME B`, 'END:VEVENT'])),
    'BEGIN:VEVENT', 'UID:vacances-toussaint@index-education.net', 'DTSTART;VALUE=DATE:20261017', 'DTEND;VALUE=DATE:20261102', 'SUMMARY:Vacances de la Toussaint', 'END:VEVENT',
  ], ['PRODID:-//Index Education//PRONOTE//FR']);

  it('reads the room and teacher from the description, ticks the named holiday, and shows later weeks right', () => {
    const saved = importCalendar(text('2026-12-18'), 'Europe/Paris');
    expect(saved.c.errors).toEqual([]);
    expect(saved.c).toMatchObject({ cycle_kind: 'weekly', cycle_length: 2 });
    expect(saved.c.lessons.find(l => l.slot === 0 && l.period_key === '08:00-09:00')).toMatchObject({ room: 'B10', teacher: 'M. PROF0' });
    expect(wrongDates(saved, days, '2027-01-04', '2027-02-05', [])).toEqual([]);
  });
});

describe('WebUntis (Europe): a window from one week back to twelve weeks ahead, cancelled lessons simply missing', () => {
  const BERLIN = [['07:55', '08:40'], ['08:45', '09:30'], ['09:50', '10:35'], ['10:40', '11:25'], ['11:45', '12:30'], ['12:35', '13:20']];
  const FAECHER = ['Deutsch', 'Mathematik', 'Englisch', 'Biologie', 'Geschichte', 'Sport', 'Kunst', 'Physik'];
  const herbst = range('2026-10-12', '2026-10-23');
  const days = school('2026-09-07', '2027-03-26', date => (herbst.includes(date) || (date >= '2026-12-21' && date <= '2027-01-01') ? null : weekday(date)), (date, slot) => BERLIN.map(([start, end], p) => ({ start, end, subject: FAECHER[(slot * 2 + p) % FAECHER.length] })));
  // Exported on 2026-09-16: 2026-09-09 to 2026-12-09, with three lessons cancelled and absent.
  const cancelled = new Set(['2026-09-24|2', '2026-11-05|0', '2026-11-05|1']);
  const text = wrap([...days].filter(([date]) => date >= '2026-09-09' && date <= '2026-12-09').flatMap(([date, { lessons }]) => lessons.flatMap((l, p) => (cancelled.has(`${date}|${p}`) ? [] : [
    'BEGIN:VEVENT', `UID:${compact(date)}${p}@webuntis`, `DTSTART;TZID=Europe/Berlin:${compact(date)}T${hhmm(l.start)}00`, `DTEND;TZID=Europe/Berlin:${compact(date)}T${hhmm(l.end)}00`, `SUMMARY:${l.subject}`, 'END:VEVENT']))));

  it('uses a calendar that is mostly in the future, and shows the rest of the year right', () => {
    const saved = importCalendar(text, 'Europe/Berlin');
    expect(saved.c.errors).toEqual([]);
    expect(saved.c).toMatchObject({ cycle_kind: 'weekly', cycle_length: 1 });
    expect(saved.c.ics.term).toEqual({ start: '2026-09-09', end: '2026-12-09' });
    expect(wrongDates(saved, days, '2026-12-10', '2027-03-26', range('2026-12-21', '2027-01-01'))).toEqual([]);
  });
});

describe('Somtoday (Netherlands): "room - lesson group - teacher" summaries', () => {
  const UREN = [['08:30', '09:20'], ['09:20', '10:10'], ['10:30', '11:20'], ['11:20', '12:10']];
  const GROEPEN = ['3havo-wi', '3havo-ne', '3havo-en', '3havo-gs', '3havo-bi'];
  const days = school('2026-09-07', '2026-12-18', date => (range('2026-10-19', '2026-10-23').includes(date) ? null : weekday(date)), (date, slot) => UREN.map(([start, end], p) => ({ start, end, subject: GROEPEN[(slot + p) % GROEPEN.length] })));
  // Rooms change from week to week; the lesson does not.
  const text = wrap([...days].filter(([date]) => date <= '2026-11-27').flatMap(([date, { lessons }]) => lessons.flatMap((l, p) => ['BEGIN:VEVENT', `UID:${compact(date)}-${p}@somtoday.nl`,
    `DTSTART:${utcStamp(date, l.start, 'Europe/Amsterdam')}`, `DTEND:${utcStamp(date, l.end, 'Europe/Amsterdam')}`, `SUMMARY:B${200 + (dayOfYear(date) % 3)} - ${l.subject} - ${l.subject.slice(-2).toUpperCase()}J`, 'END:VEVENT'])));
  function dayOfYear(date) { return Math.floor((new Date(date) - new Date('2026-01-01')) / 864e5); }

  it('reads the lesson group as the subject, so room changes are not subject changes', () => {
    const saved = importCalendar(text, 'Europe/Amsterdam');
    expect(saved.c.errors).toEqual([]);
    expect(saved.c.ics.subjectChanges.items).toEqual([]);
    expect(saved.c.lessons.find(l => l.slot === 0 && l.period_key === '08:30-09:20')).toMatchObject({ subject: '3havo-wi', teacher: 'WIJ' });
    expect(wrongDates(saved, days, '2026-11-30', '2026-12-18')).toEqual([]);
  });
});

describe('Canvas LMS: deadlines, not lessons', () => {
  it('skips events that start and end at the same moment, and reads a duplicated VALUE parameter', () => {
    const parsed = parseIcs(wrap(['BEGIN:VEVENT', 'UID:event-assignment-1', 'SUMMARY:Essay [ENG-101]', 'DTSTART:20260920T030000Z', 'DTEND:20260920T030000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:event-assignment-2', 'SUMMARY:Project [CSE-6363]', 'DTSTART;VALUE=DATE;VALUE=DATE:20260914', 'END:VEVENT'], ['METHOD:PUBLISH']), { timezone: 'America/Chicago', from: '2026-09-01', to: '2026-12-31' });
    expect(parsed.warnings).toEqual(['1 event starts and ends at the same time (such as a deadline) and was skipped.']);
    expect(parsed.observations).toEqual([expect.objectContaining({ all_day: true, date: '2026-09-14', subject: 'Project [CSE-6363]' })]);
  });
});

describe('format details behind the vendor calendars', () => {
  const one = (lines, head = [], zone = 'Europe/London') => parseIcs(wrap(['BEGIN:VEVENT', 'DTSTART;TZID=X:20260915T090000', 'DTEND;TZID=X:20260915T100000', ...lines, 'END:VEVENT'], head), { timezone: zone, from: '2026-09-01', to: '2026-09-30' });
  const vtimezone = (id, standard, daylight) => ['BEGIN:VTIMEZONE', `TZID:${id}`, 'BEGIN:STANDARD', 'DTSTART:16010101T020000', `TZOFFSETTO:${standard}`, 'END:STANDARD',
    ...(daylight ? ['BEGIN:DAYLIGHT', 'DTSTART:16010101T010000', `TZOFFSETTO:${daylight}`, 'END:DAYLIGHT'] : []), 'END:VTIMEZONE'];

  it('decodes HTML entities in the location, and splits "room - group - teacher" only for Somtoday, preferring its LOCATION', () => {
    const at = (lines, head) => one(lines, [...vtimezone('X', '+0000', '+0100'), ...(head ?? [])]).observations[0];
    expect(at(['UID:1@school', 'SUMMARY:Art', 'LOCATION:Art &amp; Design Studio'])).toMatchObject({ room: 'Art & Design Studio' });
    expect(at(['UID:2@school', 'SUMMARY:Room 1 - Maths - Teacher'])).not.toMatchObject({ subject: 'Maths' });
    expect(at(['UID:3@somtoday.nl', 'SUMMARY:B204 - 3havo-wi - JAN', 'LOCATION:B301'])).toMatchObject({ subject: '3havo-wi', room: 'B301', teacher: 'JAN' });
  });

  it('matches a custom zone by both its standard and its summer offsets, west of UTC too', () => {
    expect(one([], vtimezone('X', '+0000', '+0100')).warnings).toEqual([]);
    // No summer time, as in Iceland: not London.
    expect(one([], vtimezone('X', '+0000')).warnings).toEqual(['Unrecognised time zone "X": those times were read as local times. Check the bell times below.']);
    expect(one([], vtimezone('X', '-0500', '-0400'), 'America/New_York').warnings).toEqual([]);
    expect(one([], vtimezone('X', '-0500', '-0400')).warnings).toEqual(['Unrecognised time zone "X": those times were read as local times. Check the bell times below.']);
  });
});

describe('lessons on a day with its own bell times, next to other days\' periods inside them', () => {
  const lesson = (date, start_time, end_time, subject) => ({ all_day: false, date, end_date: date, start_time, end_time, subject, room: '', teacher: '', notes: '' });
  // Mondays: a 08:30–10:00 double from the last Monday only, then 10:15–11:00. Tuesdays: 08:30–10:00 every week.
  // Wednesdays: their own 09:00–09:45 bell.
  const observations = [];
  for (let date = '2026-09-07'; date <= '2026-10-16'; date = addDays(date, 1)) {
    const day = weekday(date);
    if (day === 0) { if (date === '2026-10-12') observations.push(lesson(date, '08:30', '10:00', 'Drama')); observations.push(lesson(date, '10:15', '11:00', 'Maths')); }
    if (day === 1) observations.push(lesson(date, '08:30', '10:00', 'Science'), lesson(date, '10:15', '11:00', 'English'));
    if (day === 2) observations.push(lesson(date, '09:00', '09:45', 'Art'), lesson(date, '10:15', '11:00', 'French'));
    if (day === 3 || day === 4) observations.push(lesson(date, '10:15', '11:00', `Day ${day}`));
  }
  const inference = inferTimetable({ observations, warnings: [], errors: [] });
  const c = candidateForFit(inference, observations);

  it('offers a lesson seen once in its own period only, and it saves', () => {
    expect(c.errors).toEqual([]);
    expect(c.ics.seenOnce.map(o => o.lessons.map(l => [l.slot, l.period_key, l.subject]))).toEqual([[[0, '08:30-10:00', 'Drama']]]);
    const ticked = { ...c, lessons: [...c.lessons, ...c.ics.seenOnce[0].lessons] };
    let n = 0;
    expect(() => candidateRows(ticked, { id: 't', cycle_kind: 'weekly', cycle_length: 1 }, 'm', () => `id${n++}`)).not.toThrow();
  });

  it('checks a lesson against the calendar by its own day\'s periods, and still misses an empty period inside a double', () => {
    const t = { id: 't', name: 'T', cycle_kind: 'weekly', cycle_length: 1, start_date: '2026-09-07', end_date: '2026-10-16', anchor_date: '2026-09-07', override_consumes_cycle_day: 0 };
    const check = checkObservedDays(t, [], c.ics.assignments, { candidate: c, observed: observations.filter(o => o.subject !== 'Drama') });
    expect(check).toMatchObject({ lessons: check.lessons, matching: check.lessons, mismatched: [] });
    // A triple lesson over three periods, with the middle period's lesson missing from the timetable: not shown.
    const periods = [['08:30', '09:00'], ['09:00', '09:30'], ['09:30', '10:00']].map(([start_time, end_time]) => ({ key: `${start_time}-${end_time}`, start_time, end_time }));
    const ends = { periods, lessons: [{ slot: 0, period_key: '08:30-09:00', subject: 'Maths' }, { slot: 0, period_key: '09:30-10:00', subject: 'Maths' }] };
    const observed = [lesson('2026-09-07', '08:30', '10:00', 'Maths')];
    expect(checkObservedDays(t, [], [{ date: '2026-09-07', slot: 0 }], { candidate: ends, observed }).matching).toBe(0);
    expect(checkObservedDays(t, [], [{ date: '2026-09-07', slot: 0 }], { candidate: { periods, lessons: [...ends.lessons, { slot: 0, period_key: '09:00-09:30', subject: 'Maths' }] }, observed }).matching).toBe(1);
  });
});
