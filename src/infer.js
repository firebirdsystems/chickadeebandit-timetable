// Cycle inference for dated lessons (plan §5.1): observations → cycles that fit → a candidate timetable.
// Pure functions; the review screen always shows the evidence and lets the member choose.
import { buildCandidate, spanningPeriods } from './import.js';
import { addDays, anchorFromPhase, clipExceptions, columnSlots, dayNumber, mod, mondayOf, projectSchoolDays, weekday } from './logic.js';

// A cycle fits when most lessons repeat in the same slot and bell time, and repeats nearly always agree.
// Weekly "Week" labels may disagree on a few dates; a longer cycle must explain clearly more than a shorter
// one it restates, since splitting groups never explains fewer lessons.
// Clean mid-year subject changes count as explained, up to a quarter of repeated lessons; a whole timetable
// flipping at a break is a restart or a time shift, not a change of subjects.
export const FIT = { repeated: 0.8, agree: 0.9, markers: 0.05, gain: 0.02, minGain: 3, changes: 0.25, newTimetable: 0.4 };
const MARKER_DAY = /^(?:(?:timetable|cycle|rotation|school)\s+)?day\s*(\d{1,2})$/i;
const MARKER_WEEK = /^(?:(?:timetable|cycle)\s+)?week\s*([a-d]|[1-4])$/i;
const MAX_LISTED = 50;
const SCHOOL_WORDS = /\b(?:school|college|academy|campus|high|middle|elementary|primary|secondary|grammar|lyc[ée]e|gymnasium)\b/i;

const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const time = o => `${o.start_time}–${o.end_time}`;

/** "Day 3", "Week B", "Timetable Week 2" → { rotationDay } or { week }; anything else → null. */
export function markerOf(title) {
  const text = String(title ?? '').trim().replace(/[.!:]+$/, '');
  const day = text.match(MARKER_DAY);
  if (day) return Number(day[1]) >= 1 && Number(day[1]) <= 10 ? { rotationDay: Number(day[1]) - 1 } : null;
  const week = text.match(MARKER_WEEK);
  if (week) return { week: /\d/.test(week[1]) ? Number(week[1]) - 1 : week[1].toLowerCase().charCodeAt(0) - 97 };
  return null;
}

/** Most common value (by normalised text), keeping the first spelling seen. */
function tally(values) {
  const counts = new Map();
  for (const value of values) {
    const key = norm(value);
    const entry = counts.get(key) ?? counts.set(key, { value, count: 0 }).get(key);
    entry.count++;
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

// Items grouped by key, in first-seen order.
function tallyGroups(items, keyOf) {
  const groups = new Map();
  for (const item of items) (groups.get(keyOf(item)) ?? groups.set(keyOf(item), []).get(keyOf(item))).push(item);
  return groups;
}

// How many items share each key.
function tallyBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return counts;
}

// A calendar entry as the candidate's lessons: one per period it fills on its day, never another day's periods.
function lessonsOf(candidate, entries) {
  const periodOf = new Map(candidate.periods.map(p => [p.key, p]));
  const usage = new Map();
  for (const l of candidate.lessons) usage.set(l.period_key, (usage.get(l.period_key) ?? 0) + 1);
  return entries.flatMap(e => {
    const others = candidate.lessons.filter(l => l.slot === e.slot && l.ref !== e.ref).map(l => periodOf.get(l.period_key));
    return (spanningPeriods(e, candidate.periods, others, key => usage.get(key) ?? 0) ?? [])
      .map(p => ({ slot: e.slot, period_key: p.key, subject: e.subject, room: e.room, teacher: e.teacher, notes: e.notes, ref: e.ref }));
  });
}

// Date → slot for one cycle. Markers are authoritative; between them, weeks follow the calendar. An unlabelled
// rotation counts the dates with lessons, and after each run of weekdays without lessons it may also count some
// of those weekdays (an exam day, a part-time student's day off) when that lines the lessons up better.
// With `restart`, Week 1 begins again after every break of a week or more (a model this app cannot save).
function positionsFor(data, kind, length, { restart = false } = {}) {
  const cacheKey = `${kind}|${length}`;
  if (!restart && data.positions.has(cacheKey)) return data.positions.get(cacheKey);
  const result = placeDates(data, kind, length, restart);
  if (!restart) data.positions.set(cacheKey, result);
  return result;
}

function placeDates(data, kind, length, restart) {
  const slots = new Map();
  let markerMismatches = 0;
  const mismatchDates = [];
  if (kind === 'weekly') {
    const marked = data.weekMarkers[0];
    const refMonday = dayNumber(mondayOf(marked?.date ?? data.lessonDates[0]));
    const refWeek = marked?.week ?? 0;
    const restarts = restart ? data.lessonDates.filter((d, i) => i && dayNumber(mondayOf(d)) - dayNumber(mondayOf(data.lessonDates[i - 1])) > 7).map(d => dayNumber(mondayOf(d))) : [];
    const weekOf = date => {
      const monday = dayNumber(mondayOf(date));
      const base = restarts.filter(r => r <= monday).at(-1);
      return base === undefined ? mod(refWeek + (monday - refMonday) / 7, length) : mod((monday - base) / 7, length);
    };
    // A labelled week takes its label; the count of labels that disagree with calendar weeks decides the fit.
    const labelled = new Map(data.weekMarkers.map(m => [dayNumber(mondayOf(m.date)), m.week]));
    for (const date of data.lessonDates) slots.set(date, (labelled.get(dayNumber(mondayOf(date))) ?? weekOf(date)) * 7 + weekday(date));
    for (const m of data.weekMarkers) if (weekOf(m.date) !== m.week) markerMismatches++;
    return { slots, markerMismatches };
  }
  const seq = data.rotationDates;
  const pos = new Array(seq.length);
  const counted = new Set();
  // Which weekdays the school counts when a student has no lessons decides every later position, and early
  // stretches have nothing to line up with. So the pass is repeated assuming different sets of the weekdays that
  // are often without lessons are counted, keeping the set that lines up the most lessons.
  // Starting from what a first pass learned and from all of them, one weekday is switched at a time while that helps.
  const tried = new Map();
  const run = set => {
    const id = [...set].sort().join();
    if (!tried.has(id)) {
      const trial = { set, pos: new Array(seq.length), counted: new Set() };
      Object.assign(trial, alignRotation(data, length, trial.pos, trial.counted, new Map([...set].map(wd => [wd, true]))));
      tried.set(id, trial);
    }
    return tried.get(id);
  };
  const learned = alignRotation(data, length, [], new Set()).usual;
  let best = null;
  for (const start of [new Set([...learned].filter(([, on]) => on).map(([wd]) => wd)), new Set(data.gapWeekdays)]) {
    let current = run(start);
    for (let better = true; better;) {
      better = false;
      for (const wd of data.gapWeekdays) {
        const next = new Set(current.set);
        if (next.has(wd)) next.delete(wd); else next.add(wd);
        const trial = run(next);
        if (trial.agree > current.agree) { current = trial; better = true; }
      }
    }
    if (!best || current.agree > best.agree) best = current;
  }
  best.pos.forEach((p, i) => { pos[i] = p; });
  best.counted.forEach(date => counted.add(date));
  markerMismatches = best.mismatches;
  mismatchDates.push(...best.mismatchDates);
  seq.forEach((date, i) => slots.set(date, pos[i]));
  return { slots, markerMismatches, mismatchDates, counted };
}

const weekdaysBetween = (a, b) => {
  const out = [];
  for (let date = addDays(a, 1); date < b; date = addDays(date, 1)) if (weekday(date) <= 4) out.push(date);
  return out;
};

/**
 * Positions for a rotation, stretch by stretch. A stretch is a run of school dates (lesson dates and "Day N" label
 * dates) with no weekday between them. After a gap of g weekdays, a stretch may count 0..g of them (capped below the
 * cycle length): the saved timetable can only skip or count those exact days, so every choice is one it can represent.
 *
 * A "Day N" label fixes its date: the count before its stretch is the one that reaches it, and a label no count can
 * reach (a repeated or skipped day) is a mismatch that the positions follow. Before the first label, positions count
 * back one school date at a time. Other gaps take a count only when it lines up strictly more lessons with those
 * placed so far (labelled dates are placed first) than any other count, and only counts that can still reach the next
 * label are considered. A count is judged over this stretch and, when that is shorter than the number of counts to
 * choose from, the stretches after it (each of their gaps taking the count that suits its own stretch best, or its
 * default on a tie, or the one its label needs) until there are enough days or the calendar ends (where a count needs
 * every lesson in the window to line up). When no count is strictly best the gap keeps its default. A gap's default
 * counts its usually counted weekdays when it is a single day or its weekdays are all usually counted, and otherwise
 * counts nothing. Counted days are taken from the usually counted weekdays first, so the review marks the likely days.
 * Returns `agree` (lessons matching the most common subject of a slot and bell seen at least twice), `mismatches`
 * (labels no count reaches) and `usual`: the weekdays whose decided single-day gaps were counted at least 80% of the
 * time (3 or more decisions).
 */
function alignRotation(data, length, pos, counted, usual = new Map()) {
  const decisions = new Map();
  const seq = data.rotationDates;
  const label = date => data.markers.get(date)?.rotationDay;
  // table: slot → bell → { counts: subject → n, top: highest n }
  const table = new Map();
  const agreeing = (date, slot) => {
    const bells = table.get(slot);
    if (!bells) return 0;
    let sum = 0;
    for (const { bell, subject } of data.keysByDate.get(date) ?? []) {
      const entry = bells.get(bell);
      if (entry && entry.counts.get(subject) === entry.top) sum++;
    }
    return sum;
  };
  const record = (date, slot) => {
    const bells = table.get(slot) ?? table.set(slot, new Map()).get(slot);
    for (const { bell, subject } of data.keysByDate.get(date) ?? []) {
      const entry = bells.get(bell) ?? bells.set(bell, { counts: new Map(), top: 0 }).get(bell);
      const next = (entry.counts.get(subject) ?? 0) + 1;
      entry.counts.set(subject, next);
      entry.top = Math.max(entry.top, next);
    }
  };
  for (const date of seq) if (label(date) !== undefined) record(date, label(date));
  const stretches = [];
  for (let i = 0; i < seq.length;) {
    let j = i;
    while (j + 1 < seq.length && !weekdaysBetween(seq[j], seq[j + 1]).length) j++;
    const k = seq.slice(i, j + 1).findIndex(date => label(date) !== undefined);
    stretches.push({ i, j, gap: i ? weekdaysBetween(seq[i - 1], seq[i]) : [], labelAt: k < 0 ? null : i + k });
    i = j + 1;
  }
  // The first labelled stretch from each stretch on, and the weekdays that may be counted before reaching it.
  const nextLabelled = new Array(stretches.length + 1).fill(-1);
  for (let n = stretches.length - 1; n >= 0; n--) nextLabelled[n] = stretches[n].labelAt !== null ? n : nextLabelled[n + 1];
  const room = new Array(stretches.length + 1).fill(0);
  for (let n = stretches.length - 1; n >= 0; n--) room[n] = room[n + 1] + Math.min(stretches[n].gap.length, length - 1);
  const firstLabelled = nextLabelled[0];
  const stretchScore = (m, first) => {
    let sum = 0;
    for (let k = stretches[m].i; k <= stretches[m].j; k++) if (label(seq[k]) === undefined) sum += agreeing(seq[k], mod(first + k - stretches[m].i, length));
    return sum;
  };
  // The count a labelled stretch needs when its first date would otherwise be at `first`.
  const needed = (m, first) => mod(label(seq[stretches[m].labelAt]) - (first + stretches[m].labelAt - stretches[m].i), length);
  const usualIn = gap => gap.filter(date => usual.get(weekday(date))).length;
  const fallback = gap => Math.min(gap.length === 1 || usualIn(gap) === gap.length ? usualIn(gap) : 0, length - 1);
  let mismatches = 0;
  const mismatchDates = [];
  stretches.forEach(({ i, j, gap, labelAt }, n) => {
    if (firstLabelled >= 0 && n < firstLabelled) return;
    let start = 0;
    if (n === firstLabelled) start = mod(label(seq[labelAt]) - (labelAt - i), length);
    else if (n > 0) {
      const base = pos[i - 1] + 1;
      const options = Math.min(gap.length, length - 1) + 1;
      let shift = fallback(gap);
      if (labelAt !== null) {
        shift = needed(n, base);
        if (shift >= options) { mismatches++; mismatchDates.push(seq[labelAt]); }
      } else {
        let last = n, days = j - i + 1;
        while (days < options && last + 1 < stretches.length) days += stretches[++last].j - stretches[last].i + 1;
        // A count that leaves the next label out of reach of the gaps before it is not considered.
        const target = nextLabelled[n];
        const reachable = s => {
          if (target < 0) return true;
          let steps = 0;
          for (let m = n; m < target; m++) steps += stretches[m].j - stretches[m].i + 1;
          return needed(target, base + s + steps) <= room[n + 1] - room[target + 1];
        };
        const allowed = Array.from({ length: options }, (_, s) => reachable(s));
        const scores = Array.from({ length: options }, (_, s) => {
          if (!allowed[s] && allowed.some(Boolean)) return -1;
          let sum = stretchScore(n, base + s), next = base + s;
          for (let m = n + 1; m <= last; m++) {
            next += stretches[m - 1].j - stretches[m - 1].i + 1;
            const inner = stretches[m].gap;
            let take, most;
            if (stretches[m].labelAt !== null) { take = needed(m, next); most = stretchScore(m, next + take); }
            else {
              take = fallback(inner); most = stretchScore(m, next + take);
              for (let t = 0; t <= Math.min(inner.length, length - 1); t++) {
                const score = stretchScore(m, next + t);
                if (score > most) [take, most] = [t, score];
              }
            }
            next += take;
            sum += most;
          }
          return sum;
        });
        const best = scores.indexOf(Math.max(...scores));
        // Near the end of the calendar, with fewer days than counts to choose from, a count is taken only when every
        // lesson in the window lines up: one changed lesson on a short last stretch must not re-align the whole year.
        let lessons = 0;
        for (let m = n; m <= last; m++) for (let k = stretches[m].i; k <= stretches[m].j; k++) lessons += data.keysByDate.get(seq[k])?.length ?? 0;
        if (scores.every((score, s) => s === best || score < scores[best]) && (days >= options || scores[best] === lessons)) {
          shift = best;
          if (gap.length === 1) (decisions.get(weekday(gap[0])) ?? decisions.set(weekday(gap[0]), []).get(weekday(gap[0]))).push(best === 1);
        } else if (!allowed[shift] && allowed.some(Boolean)) shift = allowed.indexOf(true);
      }
      [...gap].sort((a, b) => (usual.get(weekday(b)) ? 1 : 0) - (usual.get(weekday(a)) ? 1 : 0) || a.localeCompare(b)).slice(0, shift).forEach(date => counted.add(date));
      start = base + shift;
    }
    for (let k = i; k <= j; k++) {
      const expected = mod(k === i ? start : pos[k - 1] + 1, length), marked = label(seq[k]);
      if (marked !== undefined && marked !== expected && k !== labelAt) { mismatches++; mismatchDates.push(seq[k]); }
      pos[k] = marked ?? expected;
      if (marked === undefined) record(seq[k], pos[k]);
    }
  });
  if (firstLabelled > 0) for (let k = stretches[firstLabelled].i - 1; k >= 0; k--) pos[k] = mod(pos[k + 1] - 1, length);
  let agree = 0;
  for (const bells of table.values()) for (const entry of bells.values()) if (entry.top >= 2) agree += entry.top;
  return { agree, mismatches, mismatchDates, usual: new Map([...decisions].map(([wd, list]) => [wd, list.length >= 3 && list.filter(Boolean).length >= 0.8 * list.length])) };
}

function groupsFor(data, slots) {
  const groups = new Map();
  for (const o of data.timed) {
    const key = `${slots.get(o.date)}|${o.start_time}-${o.end_time}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(o);
  }
  return groups;
}

// A subject seen on 2+ dates entirely before or after the most common one is a change of timetable (a new semester).
function changesOver(list, top) {
  const spans = new Map();
  for (const o of list) {
    const key = norm(o.subject), span = spans.get(key);
    if (!span) spans.set(key, { first: o.date, last: o.date });
    else { if (o.date < span.first) span.first = o.date; if (o.date > span.last) span.last = o.date; }
  }
  const kept = spans.get(norm(top.value));
  return others => others.count >= 2 && (span => span.last < kept.first || span.first > kept.last)(spans.get(norm(others.value)));
}

/**
 * Each slot-and-bell group's subjects: the most common (`top`) and, when the group changes subject cleanly (subjects
 * seen only before or only after the most common one), the `series` of subjects in date order, whose last carries on.
 * A later subject that was on the slot before at another bell has moved, not changed, when the subject it replaces moves
 * by the same amount of time from then on (clocks changing in one zone and not the other shift every lesson alike, a
 * swap moves them opposite ways), or, when that subject is not seen again, when its old bell is no longer used. A subject that is the new one in at least three changed
 * groups, half of all changes, and runs under four weeks (mock exams) is an event: those groups keep their top subject.
 */
function groupChanges(data, slots) {
  const daysOn = new Map();
  for (const [date, keys] of data.keysByDate) (daysOn.get(slots.get(date)) ?? daysOn.set(slots.get(date), []).get(slots.get(date))).push({ date, keys });
  const minutes = bell => Number(bell.slice(0, 2)) * 60 + Number(bell.slice(3, 5));
  const commonBell = (slot, name, keep) => tally((daysOn.get(slot) ?? []).filter(d => keep(d.date)).flatMap(d => d.keys.filter(k => k.subject === name).map(k => k.bell)))[0]?.value ?? null;
  const moved = (slot, bell, previous, next) => {
    const from = next.seen[0];
    const was = commonBell(slot, next.name, date => date < from);
    if (!was || was === bell) return false;
    const goes = commonBell(slot, previous.name, date => date >= from);
    if (goes) return minutes(goes) - minutes(bell) === minutes(bell) - minutes(was);
    return !(daysOn.get(slot) ?? []).some(d => d.date >= from && d.keys.some(k => k.bell === was));
  };
  const groups = [];
  for (const list of groupsFor(data, slots).values()) {
    const slot = slots.get(list[0].date);
    const subjects = new Set(list.map(o => o.date)).size >= 2 ? tally(list.map(o => o.subject)) : [];
    const top = subjects[0];
    if (!top || top.count < 2) { groups.push({ list, slot, subjects, top: null }); continue; }
    const bySubject = new Map();
    for (const o of list) (bySubject.get(norm(o.subject)) ?? bySubject.set(norm(o.subject), []).get(norm(o.subject))).push(o);
    const entry = x => ({ ...x, name: norm(x.value), obs: bySubject.get(norm(x.value)), seen: bySubject.get(norm(x.value)).map(o => o.date).sort() });
    let series = [top, ...subjects.slice(1).filter(changesOver(list, top))].map(entry).sort((a, b) => a.seen[0].localeCompare(b.seen[0]));
    const bell = `${list[0].start_time}-${list[0].end_time}`;
    if (series.some((x, k) => k && moved(slot, bell, series[k - 1], x))) series = [entry(top)];
    groups.push({ list, slot, subjects, top, bySubject, entry, series });
  }
  const changedGroups = groups.filter(g => g.series?.length > 1);
  const latest = new Map();
  for (const g of changedGroups) latest.set(g.series.at(-1).name, (latest.get(g.series.at(-1).name) ?? 0) + 1);
  const spanOf = name => { const d = data.timed.filter(o => norm(o.subject) === name).map(o => o.date).sort(); return dayNumber(d.at(-1)) - dayNumber(d[0]); };
  const events = new Set([...latest].filter(([name, count]) => count >= 3 && count * 2 >= changedGroups.length && spanOf(name) < 28).map(([name]) => name));
  for (const g of changedGroups) if (events.has(g.series.at(-1).name)) g.series = [g.entry(g.top)];
  return groups;
}

// How many groups change subject, and the date each group's latest subject starts.
function changeStats(data, fit) {
  const { slots } = positionsFor(data, fit.cycle_kind, fit.cycle_length);
  const groups = groupChanges(data, slots).filter(g => g.top);
  const changed = groups.filter(g => g.series.length > 1);
  return { groups: groups.length, changed: changed.length, dates: changed.map(g => g.series.at(-1).seen[0]).sort() };
}

function score(data, kind, length, options) {
  const { slots, markerMismatches } = positionsFor(data, kind, length, options);
  let repeated = 0, agree = 0, changes = 0;
  for (const list of groupsFor(data, slots).values()) {
    if (new Set(list.map(o => o.date)).size < 2) continue;
    repeated += list.length;
    const [top, ...others] = tally(list.map(o => o.subject));
    if (top.count < 2) continue;
    const isChange = changesOver(list, top);
    agree += top.count;
    changes += others.filter(isChange).reduce((sum, o) => sum + o.count, 0);
  }
  if (changes <= repeated * FIT.changes) agree += changes;
  const total = data.timed.length;
  const markerCount = kind === 'weekly' ? data.weekMarkers.length : data.dayMarkerCount;
  // "Day N" labels decide each date's position, so a repeated or skipped day costs nothing; week labels
  // that disagree with the calendar mean the school's weeks do not run on through holidays.
  const lessonsFit = repeated / total >= FIT.repeated && repeated > 0 && agree / repeated >= FIT.agree;
  const fits = lessonsFit && (kind !== 'weekly' || markerMismatches <= markerCount * FIT.markers);
  return { cycle_kind: kind, cycle_length: length, total, repeated, agree, markerMismatches, lessonsFit, fits };
}

/**
 * Finds the cycles that explain the observed lessons. Returns every fitting cycle, the one explaining
 * the most lessons first (ties: weekly, then shorter; see below for equal top fits), dropping restatements: a multiple of a shorter fitting cycle of the same kind, and a
 * rotation of 5 or 10 days when the equivalent weekly cycle fits and no day markers say otherwise.
 */
export function inferTimetable(parsed, { nested = false } = {}) {
  const errors = [...parsed.errors], warnings = [...parsed.warnings];
  const result = { errors, warnings, fits: [], best: null, data: null };
  if (errors.length) return result;
  const observations = parsed.observations;
  const untitled = observations.filter(o => !o.all_day && !o.subject).length;
  if (untitled) warnings.push(`${untitled} ${untitled === 1 ? 'event has' : 'events have'} no title and ${untitled === 1 ? 'was' : 'were'} not used.`);
  const timed = observations.filter(o => !o.all_day && o.subject && weekday(o.date) <= 4);
  const weekend = observations.filter(o => !o.all_day && o.subject && weekday(o.date) > 4).length;
  if (weekend) warnings.push(`${weekend} ${weekend === 1 ? 'event falls' : 'events fall'} on a weekend and ${weekend === 1 ? 'was' : 'were'} not used.`);
  if (!timed.length) { errors.push('No timed lessons found. A school timetable calendar has events with start and end times.'); return result; }

  const markers = new Map();
  let markerConflicts = 0;
  for (const o of observations) {
    if (!o.all_day) continue;
    const marker = markerOf(o.subject);
    if (!marker) continue;
    // A "Week B" label may span the school week; a "Day N" label names one day.
    const span = dayNumber(o.end_date) - dayNumber(o.date);
    if (span > (marker.week === undefined ? 0 : 6)) continue;
    for (let date = o.date; date <= o.end_date; date = addDays(date, 1)) {
      if (weekday(date) > 4) continue;
      const prior = markers.get(date);
      if (prior && (prior.week !== marker.week || prior.rotationDay !== marker.rotationDay)) markerConflicts++;
      else markers.set(date, marker);
    }
  }
  if (markerConflicts) warnings.push(`${markerConflicts} ${markerConflicts === 1 ? 'date has' : 'dates have'} two different "Day"/"Week" labels; the first was used.`);
  const entries = [...markers].map(([date, m]) => ({ date, ...m })).sort((a, b) => a.date.localeCompare(b.date));
  const dayMarks = entries.filter(m => m.rotationDay !== undefined), weekMarks = entries.filter(m => m.week !== undefined);
  if (dayMarks.length && weekMarks.length) warnings.push('The calendar has both "Day N" and "Week" labels; only the more frequent kind was used.');
  const markerKind = dayMarks.length > weekMarks.length ? 'day_rotation' : weekMarks.length ? 'weekly' : null;
  if (markerKind === 'day_rotation') for (const m of weekMarks) markers.delete(m.date);
  if (markerKind === 'weekly') for (const m of dayMarks) markers.delete(m.date);

  const lessonDates = [...new Set(timed.map(o => o.date))].sort();
  const lessonDays = new Set(lessonDates);
  const weekStarts = [...new Set(lessonDates.map(mondayOf))];
  // Weekdays without lessons in at least half the weeks (at least 3): a part-time pattern the rotation may count.
  const gapWeekdays = [0, 1, 2, 3, 4].filter(wd => {
    const missing = weekStarts.map(monday => addDays(monday, wd)).filter(date => date > lessonDates[0] && date < lessonDates.at(-1) && !lessonDays.has(date)).length;
    return missing >= 3 && missing >= weekStarts.length / 2;
  });
  const data = {
    timed, markers, lessonDates, gapWeekdays,
    keysByDate: timed.reduce((map, o) => (map.get(o.date) ?? map.set(o.date, []).get(o.date)).push({ bell: `${o.start_time}-${o.end_time}`, subject: norm(o.subject) }) && map, new Map()),
    positions: new Map(),
    weekMarkers: markerKind === 'weekly' ? weekMarks : [],
    dayMarkerCount: markerKind === 'day_rotation' ? dayMarks.length : 0,
    rotationDates: [...new Set([...lessonDates, ...(markerKind === 'day_rotation' ? dayMarks.map(m => m.date) : [])])].sort(),
  };
  result.data = data;

  // Labels fix the cycle length: the highest "Day N" or "Week" seen.
  const attempts = [];
  const weekTop = Math.max(0, ...data.weekMarkers.map(m => m.week + 1)), dayTop = Math.max(0, ...dayMarks.map(m => m.rotationDay + 1));
  if (markerKind !== 'day_rotation') for (let length = Math.max(1, weekTop); length <= (weekTop || 4); length++) attempts.push(score(data, 'weekly', length));
  if (markerKind !== 'weekly') for (let length = Math.max(2, dayTop); length <= (dayTop ? Math.max(2, dayTop) : 10); length++) attempts.push(score(data, 'day_rotation', length));
  const fitting = attempts.filter(a => a.fits);
  const clearlyMore = (a, b) => a.agree >= b.agree + Math.max(FIT.minGain, FIT.gain * a.total);
  result.fits = fitting.filter(a => !fitting.some(b => b !== a && b.cycle_length < a.cycle_length && b.cycle_kind === a.cycle_kind && a.cycle_length % b.cycle_length === 0 && !clearlyMore(a, b))
    && !(a.cycle_kind === 'day_rotation' && !markerKind && a.cycle_length % 5 === 0 && fitting.some(b => b.cycle_kind === 'weekly' && b.cycle_length === a.cycle_length / 5 && !clearlyMore(a, b))))
    .sort((a, b) => b.agree - a.agree || (a.cycle_kind === b.cycle_kind ? 0 : a.cycle_kind === 'weekly' ? -1 : 1) || a.cycle_length - b.cycle_length);
  // Cycles that explain equally many lessons are ranked by how many the saved timetable shows on their dates with
  // the review's default days off: a cycle that fits only by reading lessons as changes, or by re-aligning at every
  // gap, shows fewer.
  const tied = result.fits.filter(f => f.agree === result.fits[0]?.agree);
  if (tied.length > 1) {
    for (const f of tied.slice(0, 6)) f.shown = shownLessons(result, observations, result.fits.indexOf(f));
    const ranked = [...tied].sort((a, b) => (b.shown ?? -1) - (a.shown ?? -1));
    result.fits.splice(0, tied.length, ...ranked);
  }
  result.best = [...attempts].sort((a, b) => b.agree - a.agree)[0] ?? null;
  // Week A/B that starts again after holidays fits as a rotation of 5 × weeks school days; say so on review.
  if (!markerKind && result.fits[0]?.cycle_kind === 'day_rotation') {
    result.restartWeeks = [2, 3, 4].find(weeks => {
      if (result.fits[0].cycle_length !== weeks * 5) return false;
      const restarting = score(data, 'weekly', weeks, { restart: true });
      const weekly = attempts.find(a => a.cycle_kind === 'weekly' && a.cycle_length === weeks);
      return restarting.fits && (!weekly?.fits || clearlyMore(restarting, weekly));
    }) ?? null;
  }
  // A new timetable partway through (a new school year inside the import window, a new semester for everyone): when
  // many slots change subject, the cycle is worked out again from a break or the date the changes cluster on, and the
  // earliest such date with four weeks of lessons that no longer changes much is used. With too few weeks after the
  // change, the whole calendar's cycle is kept, the newer subjects are used, and the term starts at the change.
  if (!nested) {
    const base = result.fits[0] ?? result.best;
    const stats = base && changeStats(data, base);
    const many = st => st.changed >= Math.max(4, FIT.newTimetable * st.groups);
    if (stats && many(stats)) {
      const middle = stats.dates[Math.floor(stats.dates.length / 2)];
      const breaks = lessonDates.filter((date, i) => i && weekdaysBetween(lessonDates[i - 1], date).length >= 10);
      // When no cycle fits the whole calendar, the change dates come from a cycle that does not fit either, so every
      // Monday from the first of them to their middle is tried too (at most 16).
      const mondays = [];
      if (!result.fits.length) for (let monday = mondayOf(stats.dates[0]); monday <= middle && mondays.length < 16; monday = addDays(monday, 7)) mondays.push(lessonDates.find(date => date >= monday));
      for (const from of [...new Set([...breaks, ...mondays, middle].filter(Boolean))].sort()) {
        if (from <= lessonDates[0] || new Set(lessonDates.filter(date => date >= from).map(mondayOf)).size < 4) continue;
        const later = inferTimetable({ ...parsed, observations: observations.filter(o => (o.all_day ? o.end_date : o.date) >= from) }, { nested: true });
        if (!later.fits.length || many(changeStats(later.data, later.fits[0]))) continue;
        later.changedFrom = from;
        later.warnings.push(`The timetable changed on ${from}: lessons before then follow a different timetable, so only lessons from ${from} are used.`);
        return later;
      }
      if (result.fits.length) {
        result.changedFrom = breaks.filter(date => date <= middle).at(-1) ?? middle;
        warnings.push(`Many lessons change subject from about ${result.changedFrom}. The newer subjects are used and the term starts there; import again once the calendar has four or more weeks of the new timetable, to check the cycle.`);
      }
    }
  }
  const span = `${lessonDates[0]} to ${lessonDates.at(-1)}`;
  if (!result.fits.length) {
    const weeks = new Set(lessonDates.map(mondayOf)).size;
    const labelled = attempts.find(a => a.cycle_kind === 'weekly' && a.lessonsFit && !a.fits);
    const restarting = !markerKind && [2, 3, 4].find(length => score(data, 'weekly', length, { restart: true }).fits);
    const best = result.best;
    const pct = best ? Math.round((100 * best.agree) / best.total) : 0;
    if (weeks < 4) errors.push(`The calendar has lessons in only ${weeks} ${weeks === 1 ? 'week' : 'weeks'} (${span}), not enough to see the timetable repeat. Export at least four weeks, ideally a whole term.`);
    else if (labelled || restarting) errors.push(`The school's ${labelled ? '"Week" labels start' : `${restarting}-week cycle starts`} again from Week A after holidays. This app's weekly cycles carry on through holidays, so this calendar cannot be imported as it is. Import one part of the term at a time, or enter the timetable by hand.`);
    else errors.push(`No repeating weekly or rotating cycle matches these lessons (${span}); the closest explains ${pct}% of them. Lessons may change too often to import, or the calendar mixes in other events.`);
  }
  return result;
}

const WEEKDAY_NAMES = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays'];

/**
 * Weekdays inside the observed range with no lessons, as runs labelled by an all-day event on them. A run is
 * split where the cycle counts some of its days as school days (`counted`, from a rotation's alignment). A
 * weekday that is on its own without lessons in at least 80% of the weeks is a pattern, not a
 * closure: for a weekly cycle it is not suggested at all, and for a rotation it becomes one row with its
 * `dates` when the alignment treats them all alike.
 */
export function suggestedHolidays(inference, observations, { kind = null, counted = new Set() } = {}) {
  const data = inference.data;
  if (!data) return [];
  const school = new Set(data.rotationDates);
  const labelFor = (start, end) => observations.find(o => o.all_day && !markerOf(o.subject) && o.subject && o.date <= end && start <= o.end_date)?.subject ?? '';
  const first = data.rotationDates[0], last = data.rotationDates.at(-1);
  const gap = date => date >= first && date <= last && weekday(date) <= 4 && !school.has(date);
  // An isolated gap: no lessons that day, lessons (or a weekend) either side.
  const isolated = date => gap(date) && !(weekday(date) > 0 && gap(addDays(date, -1))) && !(weekday(date) < 4 && gap(addDays(date, 1)));
  const weeks = [...new Set(data.rotationDates.map(mondayOf))];
  const recurring = new Map();
  for (let wd = 0; wd < 5; wd++) {
    const inRange = weeks.map(monday => addDays(monday, wd)).filter(date => date >= first && date <= last);
    const missing = inRange.filter(isolated);
    if (missing.length && missing.length >= 0.8 * inRange.length) for (const date of missing) recurring.set(date, wd);
  }
  const runs = [];
  let run = null;
  for (let date = first; date <= last; date = addDays(date, 1)) {
    if (weekday(date) > 4) continue;
    if (!gap(date) || recurring.has(date)) { run = null; continue; }
    const isCounted = counted.has(date);
    if (run && run.counted === isCounted) { run.end_date = date; run.days++; } else runs.push(run = { start_date: date, end_date: date, days: 1, counted: isCounted });
  }
  // Ticked by default: for a rotation every day it does not count; for a weekly cycle (whose weeks run on through
  // holidays either way) the days the calendar itself names, such as "Half Term".
  const rows = runs.map(r => { const named = labelFor(r.start_date, r.end_date).slice(0, 80); return { ...r, label: named || 'No lessons', ticked: kind === 'weekly' ? !!named : !r.counted }; });
  if (kind !== 'weekly') {
    for (let wd = 0; wd < 5; wd++) {
      const dates = [...recurring].filter(([, d]) => d === wd).map(([date]) => date).sort();
      if (!dates.length) continue;
      const alike = new Set(dates.map(date => counted.has(date))).size === 1;
      if (alike) rows.push({ start_date: dates[0], end_date: dates.at(-1), days: dates.length, dates, counted: counted.has(dates[0]), label: `No lessons on ${WEEKDAY_NAMES[wd]}`, ticked: !counted.has(dates[0]) });
      else rows.push(...dates.map(date => ({ start_date: date, end_date: date, days: 1, counted: counted.has(date), label: labelFor(date, date).slice(0, 80) || 'No lessons', ticked: !counted.has(date) })));
    }
  }
  return rows.sort((a, b) => a.start_date.localeCompare(b.start_date));
}

/**
 * The candidate timetable for one fitting cycle: each slot and bell time takes the subject seen most
 * (at least twice), with its most common room and teacher. Everything else is listed, not guessed.
 */
export function candidateForFit(inference, observations, index = 0) {
  const fit = inference.fits[index];
  if (inference.errors.length || !fit) {
    const errors = inference.errors.length ? inference.errors : ['Choose a cycle.'];
    return { shape: 'ics', cycle_kind: null, cycle_length: 0, periods: [], lessons: [], errors, errorCount: errors.length, warnings: inference.warnings };
  }
  const { cycle_kind: kind, cycle_length: length } = fit;
  const data = inference.data;
  const placed = positionsFor(data, kind, length);
  const { counted } = placed;
  // A restarting Week A/B numbers its days from a Monday, so Day 1 is the Monday of the calendar's first week.
  // The positions are cached for the inference, so the shift is applied to a copy.
  const restart = kind === 'day_rotation' && inference.restartWeeks && length === inference.restartWeeks * 5;
  const shift = restart ? weekday(data.rotationDates[0]) : 0;
  const slots = shift ? new Map([...placed.slots].map(([date, slot]) => [date, mod(slot + shift, length)])) : placed.slots;
  const labels = new Map(columnSlots({ cycle_kind: kind, cycle_length: length }).map(s => [s.slot, s.label]));
  const entries = [], unmatched = [], variations = [];
  let changed = 0;
  // Feeds often append the school to every location ("204, Lincoln High School"); a school name shared by all is dropped.
  const places = [...new Set(data.timed.map(o => o.room).filter(Boolean))];
  const shared = places.length > 1 && places.every(p => p.includes(', ')) && new Set(places.map(p => p.slice(p.lastIndexOf(', ')))).size === 1
    ? places[0].slice(places[0].lastIndexOf(', ')) : '';
  const suffix = SCHOOL_WORDS.test(shared) ? shared : '';
  const stripShared = room => (suffix && room.endsWith(suffix) ? room.slice(0, -suffix.length) : room);
  // The lesson dates on each slot, and the subjects each date has at each bell.
  const slotDates = new Map();
  for (const date of data.lessonDates) (slotDates.get(slots.get(date)) ?? slotDates.set(slots.get(date), []).get(slots.get(date))).push(date);
  const subjectChanges = [], singles = [];
  const lastLesson = data.lessonDates.at(-1);
  for (const g of groupChanges(data, slots)) {
    const { list, slot, subjects, top, bySubject } = g;
    const where = `${labels.get(slot)} ${time(list[0])}`;
    if (!top) {
      unmatched.push(...list);
      if (new Set(list.map(o => o.date)).size === 1 && new Set(list.map(o => norm(o.subject))).size === 1) singles.push({ o: list[0], slot, where });
      continue;
    }
    const series = g.series;
    const current = series.at(-1);
    const names = new Set(series.map(x => x.name));
    const notes = [];
    for (const other of subjects.slice(1)) {
      if (names.has(norm(other.value))) continue;
      const theirs = bySubject.get(norm(other.value));
      if (other.count === top.count && series.length === 1) {
        notes.push({ text: `${where}: ${top.value} and ${other.value} are seen equally often; ${top.value} is used.`, lessons: theirs.length });
        names.add(norm(other.value));
      } else unmatched.push(...theirs);
    }
    if (series.length > 1) {
      subjectChanges.push(`${where}: ${series.map((x, k) => (k ? `then ${x.value} from ${x.seen[0]}` : `${x.value} until ${x.seen.at(-1)}`)).join(', ')}; ${current.value} is used.`);
      for (const x of series.slice(0, -1)) changed += x.obs.length;
    }
    const onSlot = slotDates.get(slot) ?? [];
    // How many of the slot's dates have this lesson, counting dates where the same subject covers this bell as part
    // of a longer lesson. An event seen on under a quarter of them (a parents' evening) is not a lesson; it is left out
    // after the bell schedule is settled. A lesson on every one of its slot's dates since it started, or seen three or
    // more times and measured from when it started, began partway through and is kept.
    const [bellStart, bellEnd] = [list[0].start_time, list[0].end_time];
    const support = onSlot.filter(date => (data.keysByDate.get(date) ?? []).some(k => names.has(k.subject) && k.bell.slice(0, 5) <= bellStart && k.bell.slice(6) >= bellEnd)).length;
    const sinceStart = onSlot.filter(date => date >= series[0].seen[0]).length;
    const continuing = support >= 2 && support === sinceStart;
    const rare = support * 4 < onSlot.length && !continuing && (support < 3 || support * 4 < sinceStart);
    // A subject that stops (the student dropped it, or a free period replaced it) is left out once its slot has gone
    // on without it, at any time of day, for at least three dates over three weeks and a fifth of the slot's dates.
    // (A subject still on the slot at another time has moved or swapped, which the change series above describes.)
    const lastSeen = current.seen.at(-1);
    const laterDates = onSlot.filter(date => date > lastSeen);
    const seenLater = laterDates.some(date => (data.keysByDate.get(date) ?? []).some(k => names.has(k.subject)));
    const stops = !rare && !seenLater && laterDates.length >= Math.max(3, 0.2 * onSlot.length) && dayNumber(lastLesson) - dayNumber(laterDates[0]) >= 21;
    const chosen = current.obs;
    // A value missing from one occurrence is not a change; two different values are.
    const pick = (field, report = true) => {
      const counts = tally(chosen.map(o => o[field] ?? '').filter(Boolean));
      if (report && counts.length > 1) variations.push(`${where}: ${current.value} ${field} varies (${counts.map(c => `${c.value} ×${c.count}`).join(', ')}).`);
      return counts[0]?.value ?? '';
    };
    entries.push({ kind, slot, ref: where, start_time: list[0].start_time, end_time: list[0].end_time, label: '',
      subject: current.value, room: stripShared(pick('room')), teacher: pick('teacher'), notes: pick('notes', false), seen: chosen, rare,
      stops: stops && { text: `${where}: ${current.value} is not in the calendar after ${lastSeen} (${laterDates.length} later days without it), so it is left out.`, lastSeen } });
    for (const note of notes) { variations.push(note.text); changed += note.lessons; }
  }
  // Bell times. Across the calendar, the times seen most often win; a time that clashes with them is left out, unless
  // it spans two or more of them exactly (a double lesson). Some days run their own bell times (a late-start
  // Wednesday), so each day of the cycle settles its own the same way, with the calendar's times counting double:
  // a day keeps its own times only where they clearly outnumber the usual ones there, so an early dismissal on one
  // date, or lessons shifted by a clock change on half of them, keep the usual times.
  const keyOf = e => `${e.start_time}-${e.end_time}`;
  const bell = key => ({ key, start: key.slice(0, 5), end: key.slice(6) });
  const overlap = (a, b) => a.start < b.end && b.start < a.end;
  const settle = counts => {
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => bell(key));
    const accepted = [];
    for (const i of ranked) if (!accepted.some(a => overlap(a, i))) accepted.push(i);
    const covers = i => {
      const parts = accepted.filter(a => a.start >= i.start && a.end <= i.end).sort((a, b) => a.start.localeCompare(b.start));
      return parts.length >= 2 && parts[0].start === i.start && parts.at(-1).end === i.end && !accepted.some(a => overlap(a, i) && !parts.includes(a));
    };
    return new Set(ranked.filter(i => accepted.includes(i) || covers(i)).map(i => i.key));
  };
  const overall = new Map();
  for (const e of entries) overall.set(keyOf(e), (overall.get(keyOf(e)) ?? 0) + e.seen.length);
  const usual = settle(overall);
  const keep = new Set();
  for (const [slot, list] of tallyGroups(entries, e => e.slot)) {
    const here = new Map();
    for (const e of list) here.set(keyOf(e), (here.get(keyOf(e)) ?? 0) + e.seen.length * (usual.has(keyOf(e)) ? 2 : 1));
    for (const key of settle(here)) keep.add(`${slot}|${key}`);
  }
  const kept = e => keep.has(`${e.slot}|${keyOf(e)}`);
  const clashing = entries.filter(e => !kept(e));
  for (const e of clashing) unmatched.push(...e.seen);
  const clashDays = new Set(clashing.flatMap(e => e.seen.map(o => o.date))).size;
  const extra = clashing.length ? [`Lessons at other bell times on ${clashDays} ${clashDays === 1 ? 'day' : 'days'} (such as an early dismissal) do not fit that day's usual bell times and are left out.`] : [];
  // Lessons on the settled bells that stopped: several stopping together (exam leave, a trip, a strike at the end of
  // the calendar) are a disruption, not dropped subjects, so they are kept with a warning.
  const stopped = entries.filter(e => e.stops && kept(e) && !e.rare);
  const lastSeens = stopped.map(e => e.stops.lastSeen).sort();
  const disrupted = stopped.length >= 3 && dayNumber(lastSeens.at(-1)) - dayNumber(lastSeens[0]) <= 14;
  const pausedFrom = disrupted ? addDays(lastSeens[0], 1) : null;
  if (!disrupted) for (const e of stopped) subjectChanges.push(e.stops.text);
  if (disrupted) extra.push(`${stopped.length} lessons are missing from about ${pausedFrom} to the end of the calendar, as in exams or a trip, so they are kept. If the student has stopped them, clear them after importing.`);
  // An event on fewer than a quarter of its slot's dates (a parents' evening, a trip) is not a lesson.
  const lessonsKept = entries.filter(e => kept(e) && !e.rare && (disrupted || !e.stops));
  for (const e of entries) if (e.rare && kept(e)) unmatched.push(...e.seen);
  // Lessons seen once. A slot whose only date in the calendar is a normal school day (at least two lessons, half a usual
  // day's, all on the usual bells) is filled from that date and listed to check: a short calendar, not an event. A
  // lesson seen once, on its slot's last date, at a bell the slot had nothing at before, may have just started; it
  // is listed, and left out unless ticked, since a one-off saved as a lesson repeats all term.
  const keptBells = new Set(lessonsKept.map(e => `${e.start_time}-${e.end_time}`));
  const perSlot = [...tallyBy(lessonsKept, e => e.slot).values()].sort((a, b) => a - b);
  const usualDay = perSlot.length ? perSlot[Math.floor(perSlot.length / 2)] : 0;
  const filled = new Set(lessonsKept.map(e => e.slot));
  const onceEntry = x => ({ kind, slot: x.slot, ref: `${x.where}`, start_time: x.o.start_time, end_time: x.o.end_time, label: '', subject: x.o.subject,
    room: stripShared(x.o.room ?? ''), teacher: x.o.teacher ?? '', notes: x.o.notes ?? '', seen: [x.o] });
  const seenOnce = [], onceObs = new Set();
  const bySlot = new Map();
  for (const x of singles) (bySlot.get(x.slot) ?? bySlot.set(x.slot, []).get(x.slot)).push(x);
  for (const [slot, xs] of [...bySlot].sort((a, b) => a[0] - b[0])) {
    const onSlot = slotDates.get(slot) ?? [];
    const onBells = xs.filter(x => keptBells.has(`${x.o.start_time}-${x.o.end_time}`));
    if (onSlot.length === 1 && !filled.has(slot)) {
      if (onBells.length < 2 || onBells.length * 2 < usualDay) continue;
      // Events that overlap on the day (a trip over lessons) are not a school day's timetable.
      if (onBells.some((x, k) => onBells.slice(k + 1).some(y => x.o.start_time < y.o.end_time && y.o.start_time < x.o.end_time))) continue;
      seenOnce.push({ kind: 'day', ticked: true, entries: onBells.map(onceEntry),
        text: `${labels.get(slot)}: in the calendar only on ${onSlot[0]}, so its ${onBells.length} lessons are taken from that day.` });
    } else {
      for (const x of onBells) {
        if (x.o.date !== onSlot.at(-1) || lessonsKept.some(e => e.slot === slot && e.start_time < x.o.end_time && x.o.start_time < e.end_time)) continue;
        seenOnce.push({ kind: 'lesson', ticked: false, entries: [onceEntry(x)],
          text: `${x.where}: ${x.o.subject} is in the calendar only on ${x.o.date}, the last ${labels.get(slot)}. It may have just started; tick it to add it.` });
      }
    }
  }
  for (const item of seenOnce) for (const e of item.entries) onceObs.add(e.seen[0]);
  if (onceObs.size) unmatched.splice(0, unmatched.length, ...unmatched.filter(o => !onceObs.has(o)));
  lessonsKept.push(...seenOnce.filter(item => item.ticked).flatMap(item => item.entries));
  const declared = [{ kind, slot: kind === 'weekly' ? (length - 1) * 7 : length - 1 }];
  if (restart) {
    extra.push(`The lessons follow a ${inference.restartWeeks}-week cycle that starts again after holidays, so this is set up as a ${length}-day rotation that skips the days off: Day 1 is Monday ${mondayOf(data.rotationDates[0])} and Day 6 the Monday after. With the days off below ticked, the weeks stay in step for these dates only. A new term may start again from Week A: when it does, set its first day as the known date (day 1).`);
  }
  // Days with no lessons kept, named: a day in the calendar only once or twice cannot show which of its events repeat.
  const used = new Set(lessonsKept.map(e => e.slot));
  const empty = columnSlots({ cycle_kind: kind, cycle_length: length }).filter(c => !used.has(c.slot) && (slotDates.get(c.slot)?.length || !(kind === 'weekly' && data.gapWeekdays.includes(c.slot % 7))));
  if (empty.length) {
    const named = empty.slice(0, 3).map(c => (slotDates.get(c.slot)?.length ? `${c.label} (in the calendar on ${slotDates.get(c.slot).join(', ')})` : `${c.label} (not in the calendar)`)).join('; ');
    extra.push(`${empty.length === 1 ? 'This day has' : `${empty.length} days have`} no lessons: ${named}${empty.length > 3 ? '; …' : ''}. A day seen only once or twice cannot show which events repeat, so its events are listed as left out. Add its lessons after importing, or import a longer calendar.`);
  }
  const assignments = [...slots].map(([date, slot]) => ({ date, slot })).sort((a, b) => a.date.localeCompare(b.date));
  // The suggested term: from the calendar's first lesson (or the date its timetable changed) to its last, at most a
  // year, keeping the latest dates since the timetable is for the future.
  const last = data.lessonDates.at(-1);
  const term = { start: [data.lessonDates[0], inference.changedFrom, addDays(last, -365)].filter(Boolean).sort().at(-1), end: last };
  // Where "Day N" labels repeat or skip a day, no single count fits every date; the known date is then the last school
  // day in the calendar (not itself one of those dates), so the timetable is right from there on.
  const inTerm = assignments.filter(a => a.date >= term.start);
  const latest = kind === 'day_rotation' && placed.mismatchDates?.length > 0;
  const start = (latest ? inTerm.filter(a => !placed.mismatchDates.includes(a.date)).at(-1) : inTerm[0]) ?? inTerm[0] ?? assignments[0];
  const phase = { date: start.date, phase: (kind === 'weekly' ? Math.floor(start.slot / 7) : start.slot) + 1, ...(latest ? { latest } : {}) };
  if (latest) extra.push(`The calendar's "Day N" labels repeat or skip a day on ${placed.mismatchDates.slice(0, 3).join(', ')}${placed.mismatchDates.length > 3 ? ' and more' : ''}, which one rotation cannot follow. The known date is the calendar's last school day that follows the labels, so the timetable is right from then on; earlier dates may show a different day. Add a day override for each repeated or skipped day to keep them right too.`);
  const candidate = buildCandidate({ shape: 'ics', entries: lessonsKept, errors: [], warnings: [...inference.warnings, ...extra], declared });
  unmatched.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
  return {
    ...candidate,
    ics: {
      fit, fits: inference.fits, phase, labelMismatches: latest ? placed.mismatchDates : [], assignments, observed: data.timed, labelled: data.markers.size > 0,
      coverage: { first: data.lessonDates[0], last: data.lessonDates.at(-1), days: data.lessonDates.length, lessons: data.timed.length }, term,
      holidays: suggestedHolidays(inference, observations, { kind, counted }),
      unmatched: { count: unmatched.length, items: unmatched.slice(0, MAX_LISTED).map(o => `${o.date} ${time(o)} ${o.subject}`) },
      variations: { count: variations.length, items: variations.slice(0, MAX_LISTED), lessons: changed },
      subjectChanges: { count: subjectChanges.length, items: subjectChanges.slice(0, MAX_LISTED) },
      seenOnce: seenOnce.map(item => ({ kind: item.kind, ticked: item.ticked, text: item.text, lessons: lessonsOf(candidate, item.entries) })),
    },
  };
}

// Lessons a fit's candidate shows on their calendar dates, saved as the review defaults (rotation days off ticked
// unless counted, from the calendar's first lesson date and number, over at most a year).
function shownLessons(inference, observations, index) {
  const c = candidateForFit(inference, observations, index);
  if (c.errors.length) return -1;
  const closed = c.ics.holidays.filter(h => h.ticked).flatMap(h => (h.dates ?? [h.start_date]).map(date => ({ kind: 'no_school', start_date: date, end_date: h.dates ? date : h.end_date })));
  const t = { id: 'fit', name: 'fit', cycle_kind: c.cycle_kind, cycle_length: c.cycle_length, start_date: c.ics.term.start, end_date: c.ics.term.end, override_consumes_cycle_day: 0,
    anchor_date: '' };
  t.anchor_date = anchorFromPhase(c.ics.phase.date, c.cycle_kind, c.cycle_length, c.ics.phase.phase - 1, clipExceptions(closed, t.start_date, t.end_date));
  const days = clipExceptions(closed, t.start_date, t.end_date);
  return checkObservedDays(t, days, c.ics.assignments, { candidate: c, observed: c.ics.observed }).matching;
}

/**
 * Observed school days whose cycle slot the timetable would show differently (wrong day, or a day off), and,
 * given the candidate and the calendar's lessons, how many of those lessons the timetable shows on their date.
 */
export function checkObservedDays(t, exceptions, assignments, { candidate, observed } = {}) {
  const slots = new Map(projectSchoolDays(t, exceptions).map(r => [r.day_date, r.slot]));
  const checked = assignments.filter(a => a.date >= t.start_date && a.date <= t.end_date);
  const result = { checked: checked.length, mismatched: checked.filter(a => slots.get(a.date) !== a.slot).map(a => a.date) };
  if (!candidate) return result;
  // A calendar lesson is shown when the timetable's lessons on that day inside its times run from its start to its end
  // with its subject, and no period inside it is left empty. Periods overlapping those lessons are other days' bells.
  const periodOf = new Map(candidate.periods.map(p => [p.key, p]));
  const onSlot = new Map();
  for (const l of candidate.lessons) if (periodOf.has(l.period_key)) (onSlot.get(l.slot) ?? onSlot.set(l.slot, []).get(l.slot)).push({ lesson: l, period: periodOf.get(l.period_key) });
  const within = (p, o) => p.start_time >= o.start_time && p.end_time <= o.end_time;
  const overlapping = (a, b) => a.start_time < b.end_time && b.start_time < a.end_time;
  let lessons = 0, matching = 0;
  for (const o of observed) {
    if (o.date < t.start_date || o.date > t.end_date) continue;
    lessons++;
    const slot = slots.get(o.date);
    const filled = (onSlot.get(slot) ?? []).filter(x => within(x.period, o)).sort((a, b) => a.period.start_time.localeCompare(b.period.start_time));
    const empty = candidate.periods.some(p => within(p, o) && !filled.some(x => overlapping(x.period, p)));
    if (filled.length && filled[0].period.start_time === o.start_time && filled.at(-1).period.end_time === o.end_time && !empty
      && filled.every(x => norm(x.lesson.subject) === norm(o.subject))) matching++;
  }
  return { ...result, lessons, matching };
}
