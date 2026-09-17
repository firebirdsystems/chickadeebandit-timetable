import { describe, expect, it } from 'vitest';
import { decodeImportFile, ICS_LIMITS, parseIcs, resolveZone, zonedToUtc } from '../src/ics.js';

const cal = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.map(e => `BEGIN:VEVENT\r\n${e.join('\r\n')}\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`;
const read = (text, opts = {}) => parseIcs(text, { timezone: 'Europe/London', from: '2026-09-01', to: '2027-08-31', ...opts });
const brief = o => `${o.date} ${o.start_time}-${o.end_time} ${o.subject}`;

describe('ICS lines and fields', () => {
  it('unfolds lines, unescapes text, reads quoted params and ignores alarm properties', () => {
    const { observations, errors, warnings } = read(cal([
      'UID:1', 'BEGIN:VALARM', 'DESCRIPTION:Teacher: Wrong', 'SUMMARY:Alarm', 'LOCATION:Nowhere', 'END:VALARM',
      'DTSTART;TZID="Europe/London":20260914T083000', 'DTEND;TZID="Europe/London":20260914T092000',
      'SUMMARY:Science\\, Year 8', 'LOCATION:Lab\\; 2', 'DESCRIPTION:Bring goggles\\nTeacher: Dr S Hu',
      ' ghes',
    ]));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(observations).toEqual([{ all_day: false, date: '2026-09-14', end_date: '2026-09-14', start_time: '08:30', end_time: '09:20',
      subject: 'Science, Year 8', room: 'Lab; 2', teacher: 'Dr S Hughes', notes: '' }]);
  });

  it('moves a class group after the subject into notes', () => {
    const at = summary => read(cal(['DTSTART:20260914T083000', 'DTEND:20260914T092000', `SUMMARY:${summary}`])).observations[0];
    expect(at('Maths: 9X/Ma1')).toMatchObject({ subject: 'Maths', notes: '9X/Ma1' });
    expect(at('Maths - 9X/Ma1')).toMatchObject({ subject: 'Maths', notes: '9X/Ma1' });
    expect(at('Design: Food/Textiles')).toMatchObject({ subject: 'Design', notes: 'Food/Textiles' });
    expect(at('Maths: Algebra')).toMatchObject({ subject: 'Maths: Algebra', notes: '' });
  });

  it('refuses what is not a readable calendar', () => {
    expect(read('Day,Start\nMon,08:30').errors).toEqual(['This is not a calendar (.ics) file.']);
    expect(read('BEGIN:VCALENDAR\nEND:VCALENDAR').errors).toEqual(['The calendar has no events.']);
    expect(read(cal(['DTSTART:20260914T083000', 'DTEND:20260914T092000', `SUMMARY:${'x'.repeat(ICS_LIMITS.bytes)}`])).errors[0]).toMatch(/larger than 2 MB/);
    const many = Array.from({ length: ICS_LIMITS.events + 1 }, () => ['DTSTART:20260914T083000', 'DURATION:PT1H', 'SUMMARY:x']);
    expect(read(cal(...many)).errors[0]).toMatch(/more than 5,000 events/);
  });
});

describe('ICS times and zones', () => {
  it('converts zoned and UTC times into the household zone, and keeps floating times', () => {
    const text = cal(
      ['DTSTART;TZID=Europe/London:20260914T083000', 'DTEND;TZID=Europe/London:20260914T092000', 'SUMMARY:Zoned'],
      ['DTSTART:20260914T123000Z', 'DTEND:20260914T131500Z', 'SUMMARY:Utc'],
      ['DTSTART:20260914T100000', 'DTEND:20260914T104500', 'SUMMARY:Floating'],
    );
    expect(read(text, { timezone: 'America/New_York' }).observations.map(brief)).toEqual([
      '2026-09-14 03:30-04:20 Zoned', '2026-09-14 08:30-09:15 Utc', '2026-09-14 10:00-10:45 Floating',
    ]);
  });

  it('keeps a zoned weekly lesson at the same wall time across a clock change', () => {
    const text = cal(['DTSTART;TZID=Europe/London:20261019T083000', 'DTEND;TZID=Europe/London:20261019T092000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:Maths']);
    expect(read(text).observations.map(brief)).toEqual(['2026-10-19 08:30-09:20 Maths', '2026-10-26 08:30-09:20 Maths']);
    // Seen from UTC, the same lessons move an hour when British Summer Time ends.
    expect(read(text, { timezone: 'UTC' }).observations.map(brief)).toEqual(['2026-10-19 07:30-08:20 Maths', '2026-10-26 08:30-09:20 Maths']);
  });

  it('resolves Windows and path-style zone names, and reads an unknown zone as local time with a warning', () => {
    expect(resolveZone('AUS Eastern Standard Time')).toBe('Australia/Sydney');
    expect(resolveZone('/citadel.org/20250101_1/Europe/London')).toBe('Europe/London');
    expect(resolveZone('Mars/Olympus')).toBeNull();
    const parsed = read(cal(['DTSTART;TZID=School Time:20260914T083000', 'DTEND;TZID=School Time:20260914T092000', 'SUMMARY:Maths']), { timezone: 'Asia/Tokyo' });
    expect(parsed.observations.map(brief)).toEqual(['2026-09-14 08:30-09:20 Maths']);
    expect(parsed.warnings).toEqual(['Unrecognised time zone "School Time": those times were read as local times. Check the bell times below.']);
  });

  it('moves a wall time that a clock change skips forward, and takes the first of a repeated one', () => {
    expect(new Date(zonedToUtc('2026-10-25', '01:30:00', 'Europe/London')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(new Date(zonedToUtc('2026-11-01', '01:30:00', 'America/New_York')).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(new Date(zonedToUtc('2027-03-28', '01:30:00', 'Europe/London')).toISOString()).toBe('2027-03-28T01:30:00.000Z');
    expect(new Date(zonedToUtc('2026-07-01', '08:30:00', 'Europe/London')).toISOString()).toBe('2026-07-01T07:30:00.000Z');
  });

  it('reads DURATION, all-day spans and skips events with no end or past midnight', () => {
    const parsed = read(cal(
      ['DTSTART:20260914T083000', 'DURATION:PT1H5M', 'SUMMARY:Double'],
      ['DTSTART;VALUE=DATE:20261026', 'DTEND;VALUE=DATE:20261031', 'SUMMARY:Half term'],
      ['DTSTART;VALUE=DATE:20260915', 'SUMMARY:Day 2'],
      ['DTSTART:20260914T220000', 'DTEND:20260915T010000', 'SUMMARY:Sleepover'],
      ['DTSTART:20260914T230000', 'DTEND:20260915T000000', 'SUMMARY:Late'],
      ['DTSTART:20260914T090000', 'SUMMARY:No end'],
    ));
    expect(parsed.observations.map(o => `${brief(o)} ${o.end_date}`)).toEqual([
      '2026-09-14 08:30-09:35 Double 2026-09-14', '2026-09-14 23:00-23:59 Late 2026-09-14',
      '2026-09-15 - Day 2 2026-09-15', '2026-10-26 - Half term 2026-10-30',
    ]);
    expect(parsed.warnings).toEqual(['1 event has no end time and was skipped.', '1 event runs past midnight and was skipped.']);
  });
});

describe('ICS recurrence', () => {
  const lesson = (...extra) => ['UID:m', 'DTSTART;TZID=Europe/London:20260907T083000', 'DTEND;TZID=Europe/London:20260907T092000', 'SUMMARY:Maths', ...extra];

  it('expands fortnightly lessons on several days until a date, skipping excluded dates', () => {
    const parsed = read(cal(lesson('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261007', 'EXDATE;TZID=Europe/London:20260921T083000,20260923T083000')));
    expect(parsed.observations.map(o => o.date)).toEqual(['2026-09-07', '2026-09-09', '2026-10-05', '2026-10-07']);
  });

  it('counts COUNT from the first lesson, including excluded dates, and supports weekday DAILY rules', () => {
    expect(read(cal(lesson('RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;VALUE=DATE:20260914'))).observations.map(o => o.date)).toEqual(['2026-09-07', '2026-09-21']);
    expect(read(cal(lesson('RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20260914T235959Z'))).observations.map(o => o.date))
      .toEqual(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14']);
  });

  it('uses WKST to decide which weeks a fortnightly Sunday rule falls in', () => {
    const sunday = wkst => read(cal(['DTSTART:20260906T090000', 'DURATION:PT1H', 'SUMMARY:Club', `RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=SU,MO;WKST=${wkst}`])).observations.map(o => o.date);
    expect(sunday('MO')).toEqual(['2026-09-06', '2026-09-14', '2026-09-20', '2026-09-28']);
    expect(sunday('SU')).toEqual(['2026-09-06', '2026-09-07', '2026-09-20', '2026-09-21']);
  });

  it('applies moved and cancelled occurrences, and warns about ones that match no date', () => {
    const parsed = read(cal(
      lesson('RRULE:FREQ=WEEKLY;COUNT=3'),
      ['UID:m', 'RECURRENCE-ID;TZID=Europe/London:20260914T083000', 'DTSTART;TZID=Europe/London:20260914T101500', 'DTEND;TZID=Europe/London:20260914T110500', 'SUMMARY:Maths', 'LOCATION:Library'],
      ['UID:m', 'RECURRENCE-ID;TZID=Europe/London:20260921T083000', 'DTSTART;TZID=Europe/London:20260921T083000', 'DURATION:PT50M', 'STATUS:CANCELLED', 'SUMMARY:Maths'],
      ['UID:m', 'RECURRENCE-ID;TZID=Europe/London:20261005T083000', 'DTSTART;TZID=Europe/London:20261005T083000', 'DURATION:PT50M', 'SUMMARY:Maths'],
    ));
    expect(parsed.observations.map(o => `${brief(o)} ${o.room}`)).toEqual(['2026-09-07 08:30-09:20 Maths ', '2026-09-14 10:15-11:05 Maths Library']);
    expect(parsed.warnings).toEqual(['1 changed occurrence does not match any date of its repeating event and was ignored.']);
  });

  it('uses only the first occurrence of rules it cannot read, and says so', () => {
    const parsed = read(cal(lesson('RRULE:FREQ=MONTHLY;BYDAY=1MO')));
    expect(parsed.observations.map(o => o.date)).toEqual(['2026-09-07']);
    expect(parsed.warnings).toEqual(['1 repeating event uses a repeat rule this import does not read (only daily and weekly repeats); only the first occurrence was used.']);
    expect(read(cal(lesson('RRULE:FREQ=WEEKLY;UNTIL=2026-09-28'))).warnings[0]).toMatch(/^1 repeating event uses a repeat rule this import does not read/);
    const extra = read(cal(lesson('RRULE:FREQ=WEEKLY;COUNT=1', 'RDATE;TZID=Europe/London:20261201T083000')));
    expect(extra.warnings).toEqual(['1 event lists extra dates (RDATE or EXRULE) that were ignored.']);
  });

  it('stops a rule at the window and the per-rule cap, counting what fell outside', () => {
    const outside = read(cal(lesson('RRULE:FREQ=WEEKLY')), { from: '2026-09-10', to: '2026-09-30' });
    expect(outside.observations.map(o => o.date)).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
    expect(outside.warnings).toEqual(['1 event has dates outside 2026-09-10 to 2026-09-30; those dates were ignored.']);
    const capped = read(cal(lesson('RRULE:FREQ=DAILY')), { from: '2026-09-01', to: '2028-12-31' });
    expect(capped.observations).toHaveLength(ICS_LIMITS.perRule);
    expect(capped.warnings).toEqual([`1 repeating event has more than ${ICS_LIMITS.perRule} occurrences; only the first ${ICS_LIMITS.perRule} were read.`]);
  });

  it('refuses a calendar that expands past the total occurrence limit', () => {
    const rules = Array.from({ length: 41 }, (_, i) => lesson(`RRULE:FREQ=DAILY`).map(l => (l === 'UID:m' ? `UID:${i}` : l)));
    expect(read(cal(...rules), { to: '2028-12-31' }).errors[0]).toMatch(/more than 20,000 events/);
  });
});

describe('ICS review fixes', () => {
  const lesson = (...extra) => ['UID:m', 'DTSTART;TZID=Europe/London:20260907T083000', 'DTEND;TZID=Europe/London:20260907T092000', 'SUMMARY:Maths', ...extra];

  it('refuses zoned or UTC times without a usable household zone, and resolves a Windows household zone', () => {
    const utc = cal(['DTSTART:20260914T123000Z', 'DTEND:20260914T131500Z', 'SUMMARY:Utc']);
    expect(read(utc, { timezone: undefined }).errors).toEqual(["The household has no time zone set, so the calendar's times cannot be placed. Set it in household settings and import again."]);
    expect(read(utc, { timezone: 'Nowhere/Zone' }).errors).toEqual(['The household time zone "Nowhere/Zone" is not recognised, so the calendar\'s times cannot be placed. Fix it in household settings and import again.']);
    expect(read(utc, { timezone: 'GMT Standard Time' }).observations.map(brief)).toEqual(['2026-09-14 13:30-14:15 Utc']);
    expect(read(cal(['DTSTART:20260914T083000', 'DTEND:20260914T092000', 'SUMMARY:Floating']), { timezone: undefined }).observations.map(brief)).toEqual(['2026-09-14 08:30-09:20 Floating']);
  });

  it("warns when the calendar's own zone differs from the household's", () => {
    const text = `BEGIN:VCALENDAR\r\nX-WR-TIMEZONE:America/New_York\r\nBEGIN:VEVENT\r\nDTSTART:20260914T123000Z\r\nDTEND:20260914T131500Z\r\nSUMMARY:Utc\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    expect(read(text).warnings).toEqual(['This calendar was made for America/New_York time, but the household time zone is Europe/London; lesson times are shown in household time. If the household zone is wrong, change it in household settings and import again.']);
    expect(read(text, { timezone: 'America/New_York' }).warnings).toEqual([]);
  });

  it('starts long-running rules at the window instead of their first date, and refuses runaway expansion', () => {
    const ancient = Array.from({ length: 50 }, (_, i) => ['DTSTART:16010101T090000Z', 'DURATION:PT1H', `UID:${i}`, 'SUMMARY:Old', 'RRULE:FREQ=DAILY;UNTIL=20260902T000000Z']);
    const parsed = read(cal(...ancient));
    expect(parsed.errors).toEqual([]);
    expect(parsed.observations).toHaveLength(50);
    expect(parsed.warnings).toEqual(['50 events have dates outside 2026-09-01 to 2027-08-31; those dates were ignored.']);
    const counted = Array.from({ length: 30 }, (_, i) => ['DTSTART:16010101T090000Z', 'DURATION:PT1H', `UID:${i}`, 'SUMMARY:Old', 'RRULE:FREQ=DAILY;COUNT=999999']);
    expect(read(cal(...counted)).errors).toEqual(["The calendar's repeating events go back too far to read. Export only this school year."]);
  // Walking to the 3M-day cap takes about 4.5s on a laptop, too close to the 5s default.
  }, 20_000);

  it('applies a changed occurrence whose original date is before the window or excluded', () => {
    const parsed = read(cal(
      lesson('RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;TZID=Europe/London:20260921T083000'),
      ['UID:m', 'RECURRENCE-ID;TZID=Europe/London:20260907T083000', 'DTSTART;TZID=Europe/London:20260915T100000', 'DURATION:PT50M', 'SUMMARY:Maths'],
      ['UID:m', 'RECURRENCE-ID;TZID=Europe/London:20260921T083000', 'DTSTART;TZID=Europe/London:20260921T100000', 'DURATION:PT50M', 'SUMMARY:Maths'],
    ), { from: '2026-09-10' });
    expect(parsed.observations.map(brief)).toEqual(['2026-09-14 08:30-09:20 Maths', '2026-09-15 10:00-10:50 Maths', '2026-09-21 10:00-10:50 Maths', '2026-09-28 08:30-09:20 Maths']);
    expect(parsed.warnings).toEqual(['1 event has dates outside 2026-09-10 to 2027-08-31; those dates were ignored.']);
  });

  it('excludes by wall time for a floating EXDATE on a zoned lesson, and by date on an all-day series', () => {
    const zonedLesson = read(cal(['DTSTART;TZID=America/New_York:20260914T083000', 'DURATION:PT50M', 'SUMMARY:Maths', 'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE:20260921T083000']), { timezone: 'America/New_York' });
    expect(zonedLesson.observations.map(o => o.date)).toEqual(['2026-09-14', '2026-09-28']);
    const allDay = read(cal(['DTSTART;VALUE=DATE:20260914', 'SUMMARY:Day', 'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE:20260920T230000Z']), { timezone: 'Europe/London' });
    expect(allDay.observations.map(o => o.date)).toEqual(['2026-09-14', '2026-09-28']);
  });

  it('drops a first date the rule does not name', () => {
    expect(read(cal(lesson('RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=2'))).observations.map(o => o.date)).toEqual(['2026-09-09', '2026-09-16']);
  });

  it("reads Exchange's Microsoft UTC zone, quoted or not, lowercase rules and a trailing BYDAY comma", () => {
    const at = tzid => read(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=${tzid}:20260914T223000\r\nDURATION:PT1H\r\nSUMMARY:Late\r\nEND:VEVENT\r\nEND:VCALENDAR`, { timezone: 'Australia/Sydney' });
    expect(at('tzone://Microsoft/Utc').observations.map(brief)).toEqual(['2026-09-15 08:30-09:30 Late']);
    expect(at('"tzone://Microsoft/Utc"').observations.map(brief)).toEqual(['2026-09-15 08:30-09:30 Late']);
    expect(read(cal(lesson('rrule:freq=weekly;byday=mo,;count=2'))).observations.map(o => o.date)).toEqual(['2026-09-07', '2026-09-14']);
  });

  it('compares UNTIL in the same terms as the lessons', () => {
    const floatingUntil = read(cal(['DTSTART;TZID=America/New_York:20260914T083000', 'DURATION:PT50M', 'SUMMARY:M', 'RRULE:FREQ=WEEKLY;UNTIL=20260928T083000']), { timezone: 'America/New_York' });
    expect(floatingUntil.observations.map(o => o.date)).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
    const zonedUntil = read(cal(['DTSTART;TZID=America/New_York:20260914T083000', 'DURATION:PT50M', 'SUMMARY:M', 'RRULE:FREQ=WEEKLY;UNTIL=20260928T122959Z']), { timezone: 'America/New_York' });
    expect(zonedUntil.observations.map(o => o.date)).toEqual(['2026-09-14', '2026-09-21']);
    const allDay = read(cal(['DTSTART;VALUE=DATE:20260914', 'SUMMARY:D', 'RRULE:FREQ=DAILY;UNTIL=20260927T140000Z']), { timezone: 'Australia/Sydney' });
    expect(allDay.observations.at(-1).date).toBe('2026-09-28');
  });

  it('places the window by household date', () => {
    const parsed = read(cal(['DTSTART:20260831T223000Z', 'DURATION:PT1H', 'SUMMARY:Early', 'RRULE:FREQ=DAILY;COUNT=2']), { timezone: 'Australia/Sydney', from: '2026-09-01', to: '2026-09-01' });
    expect(parsed.observations.map(brief)).toEqual(['2026-09-01 08:30-09:30 Early']);
  });

  it('reads a 24-hour all-day DURATION, strips HTML from descriptions and warns about a cut-off file', () => {
    const parsed = read(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260914\r\nDURATION:PT24H\r\nSUMMARY:Sports day\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART:20260915T090000\r\nDURATION:PT1H\r\nSUMMARY:Maths\r\nDESCRIPTION:Teacher: Mr A<br>Room change\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART:20260916T090000\r\n`);
    expect(parsed.observations.map(o => [o.date, o.end_date, o.subject, o.teacher])).toEqual([['2026-09-14', '2026-09-14', 'Sports day', ''], ['2026-09-15', '2026-09-15', 'Maths', 'Mr A']]);
    expect(parsed.warnings).toEqual(['The file ends partway through an event, so that event was skipped. The download may be incomplete.']);
  });

  it('takes the first of a repeated hour even where the offset is over 12 hours', () => {
    expect(new Date(zonedToUtc('2027-04-04', '02:30:00', 'Pacific/Auckland')).toISOString()).toBe('2027-04-03T13:30:00.000Z');
  });
});

describe('ICS review cycle 2 fixes', () => {
  const at = (...lines) => read(cal(['DTSTART:20260914T083000', 'DTEND:20260914T092000', 'SUMMARY:Maths', ...lines]));

  it('reads a blank "Staff:" line as no teacher, and decodes HTML entities', () => {
    expect(at('DESCRIPTION:Staff:\\nRoom: S12\\nClass: 9X').observations[0].teacher).toBe('');
    expect(at('DESCRIPTION:<p>Teacher: Mr O&#39\\;Neil &amp\\; Ms Li&nbsp\\;</p>').observations[0].teacher).toBe("Mr O'Neil & Ms Li");
    expect(at('DESCRIPTION:<<<\\nTeacher: A &bogus\\; B').observations[0].teacher).toBe('A &bogus; B');
  });

  it('joins a fold that splits a multi-byte character, and leaves other files alone', () => {
    const enc = new TextEncoder();
    const [c1, c2] = enc.encode('ç');
    const bytes = new Uint8Array([...enc.encode('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260914T083000\r\nDURATION:PT1H\r\nSUMMARY:Fran'), c1, 0x0d, 0x0a, 0x20, c2,
      ...enc.encode('ais\nEND:VEVENT\r\nEND:VCALENDAR\r\n')]);
    expect(read(decodeImportFile(bytes.buffer)).observations[0].subject).toBe('Français');
    const csv = enc.encode('\uFEFFDay,Start\r\n Mon,08:30');
    expect(decodeImportFile(csv.buffer)).toBe('Day,Start\r\n Mon,08:30');
  });

  it('imports a changed occurrence with no repeating event as a one-off, and drops those of a cancelled series quietly', () => {
    const lone = read(cal(['UID:x', 'RECURRENCE-ID;TZID=Europe/London:20260914T083000', 'DTSTART;TZID=Europe/London:20260914T101500', 'DURATION:PT50M', 'SUMMARY:Maths']));
    expect(lone.observations.map(brief)).toEqual(['2026-09-14 10:15-11:05 Maths']);
    expect(lone.warnings).toEqual([]);
    const gone = read(cal(
      ['UID:m', 'DTSTART:20260907T083000', 'DURATION:PT50M', 'SUMMARY:Maths', 'RRULE:FREQ=WEEKLY;COUNT=3', 'STATUS:CANCELLED'],
      ['UID:m', 'RECURRENCE-ID:20260914T083000', 'DTSTART:20260914T101500', 'DURATION:PT50M', 'SUMMARY:Maths'],
    ));
    expect(gone.observations).toEqual([]);
    expect(gone.warnings).toEqual([]);
  });

  it('uses the highest SEQUENCE of two changes to one occurrence, and a change moved in from after the window', () => {
    const master = ['UID:m', 'DTSTART:20260907T083000', 'DURATION:PT50M', 'SUMMARY:Maths', 'RRULE:FREQ=WEEKLY'];
    const parsed = read(cal(master,
      ['UID:m', 'RECURRENCE-ID:20260914T083000', 'SEQUENCE:1', 'DTSTART:20260914T083000', 'DURATION:PT50M', 'SUMMARY:Old'],
      ['UID:m', 'RECURRENCE-ID:20260914T083000', 'SEQUENCE:2', 'DTSTART:20260914T083000', 'DURATION:PT50M', 'SUMMARY:New'],
      ['UID:m', 'RECURRENCE-ID:20261005T083000', 'DTSTART:20260930T083000', 'DURATION:PT50M', 'SUMMARY:Moved']), { to: '2026-09-30' });
    expect(parsed.observations.map(o => `${o.date} ${o.subject}`)).toEqual(['2026-09-07 Maths', '2026-09-14 New', '2026-09-21 Maths', '2026-09-28 Maths', '2026-09-30 Moved']);
    expect(parsed.warnings).toEqual([]);
  });

  it('reads a UTC UNTIL on a floating start in household time', () => {
    const parsed = read(cal(['DTSTART:20260914T083000', 'DURATION:PT50M', 'SUMMARY:Maths', 'RRULE:FREQ=WEEKLY;UNTIL=20260927T223000Z']), { timezone: 'Australia/Sydney' });
    expect(parsed.observations.map(o => o.date)).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
  });

  it('keeps the part of an all-day event inside the window', () => {
    const parsed = read(cal(['DTSTART;VALUE=DATE:20261026', 'DTEND;VALUE=DATE:20261031', 'SUMMARY:Half term']), { from: '2026-10-28' });
    expect(parsed.observations).toMatchObject([{ all_day: true, date: '2026-10-28', end_date: '2026-10-30', subject: 'Half term' }]);
  });

  it('recognises POSIX-style zone names', () => {
    expect(resolveZone('EST5EDT')).toMatch(/^(?:EST5EDT|America\/New_York)$/);
    expect(resolveZone('CST6CDT')).toMatch(/^(?:CST6CDT|America\/Chicago)$/);
  });
});

describe('ICS review cycle 3 fixes', () => {
  it('matches a zoned RECURRENCE-ID or EXDATE to a floating series in household time', () => {
    const series = ['UID:f', 'DTSTART:20260907T090000', 'DURATION:PT50M', 'SUMMARY:Maths', 'RRULE:FREQ=WEEKLY;COUNT=3'];
    const moved = read(cal(series, ['UID:f', 'RECURRENCE-ID:20260914T080000Z', 'DTSTART:20260914T110000', 'DURATION:PT50M', 'SUMMARY:Maths']));
    expect(moved.observations.map(brief)).toEqual(['2026-09-07 09:00-09:50 Maths', '2026-09-14 11:00-11:50 Maths', '2026-09-21 09:00-09:50 Maths']);
    expect(moved.warnings).toEqual([]);
    const zoned = read(cal(series, ['UID:f', 'RECURRENCE-ID;TZID=Europe/London:20260914T090000', 'DTSTART:20260914T110000', 'DURATION:PT50M', 'SUMMARY:Maths']));
    expect(zoned.observations.map(o => o.start_time)).toEqual(['09:00', '11:00', '09:00']);
    expect(read(cal([...series, 'EXDATE:20260914T080000Z'])).observations.map(o => o.date)).toEqual(['2026-09-07', '2026-09-21']);
    // A floating value is not an instant: 09:00 UTC is 10:00 in London, not this 09:00 lesson.
    expect(read(cal([...series, 'EXDATE:20260914T090000Z'])).observations.map(o => o.date)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
  });

  it('names an all-day occurrence by the household date of a UTC RECURRENCE-ID', () => {
    const parsed = read(cal(
      ['UID:d', 'DTSTART;VALUE=DATE:20260919', 'SUMMARY:Day', 'RRULE:FREQ=DAILY;COUNT=4'],
      ['UID:d', 'RECURRENCE-ID:20260920T140000Z', 'DTSTART;VALUE=DATE:20260921', 'SUMMARY:Changed'],
    ), { timezone: 'Australia/Sydney' });
    expect(parsed.observations.map(o => `${o.date} ${o.subject}`)).toEqual(['2026-09-19 Day', '2026-09-20 Day', '2026-09-21 Changed', '2026-09-22 Day']);
  });

  it('keeps a repeating week-long all-day event that started before the window', () => {
    const parsed = read(cal(['DTSTART;VALUE=DATE:20260831', 'DTEND;VALUE=DATE:20260905', 'SUMMARY:Week A', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=2']), { from: '2026-09-02' });
    expect(parsed.observations.map(o => `${o.date} ${o.end_date}`)).toEqual(['2026-09-02 2026-09-04', '2026-09-14 2026-09-18']);
  });

  it('keeps the later of two equal-SEQUENCE changes, and one-off changes that share a date', () => {
    const master = ['UID:m', 'DTSTART:20260907T083000', 'DURATION:PT50M', 'SUMMARY:Maths', 'RRULE:FREQ=WEEKLY;COUNT=2'];
    const change = summary => ['UID:m', 'RECURRENCE-ID:20260914T083000', 'DTSTART:20260914T083000', 'DURATION:PT50M', `SUMMARY:${summary}`];
    expect(read(cal(master, change('Old'), change('New'))).observations.map(o => o.subject)).toEqual(['Maths', 'New']);
    const lone = read(cal(
      ['UID:x', 'RECURRENCE-ID;VALUE=DATE:20260914', 'DTSTART;VALUE=DATE:20260914', 'SUMMARY:Trip'],
      ['UID:x', 'RECURRENCE-ID:20260914T090000', 'DTSTART:20260914T090000', 'DURATION:PT1H', 'SUMMARY:Floating'],
      ['UID:x', 'RECURRENCE-ID:20260914T090000Z', 'DTSTART:20260914T090000Z', 'DURATION:PT1H', 'SUMMARY:Utc'],
    ));
    expect(lone.observations.map(o => o.subject).sort()).toEqual(['Floating', 'Trip', 'Utc']);
  });

  it('reads block tags as line breaks and leaves invalid code points alone', () => {
    const teacher = description => read(cal(['DTSTART:20260914T083000', 'DURATION:PT1H', 'SUMMARY:Maths', `DESCRIPTION:${description}`])).observations[0].teacher;
    expect(teacher('<div>Teacher: Mr X</div><div>Room: 5</div>')).toBe('Mr X');
    expect(teacher('Teacher: Mrs O&rsquo\\;Brien &#xD800\\;')).toBe('Mrs O’Brien &#xD800;');
  });

  it('decodes UTF-16 and Windows-1252 files, and bare-CR folds', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'Day,Start'].flatMap(ch => [ch.charCodeAt(0), 0])]);
    expect(decodeImportFile(utf16.buffer)).toBe('Day,Start');
    expect(decodeImportFile(new Uint8Array([0x43, 0x61, 0x66, 0xe9]).buffer)).toBe('Café');
    const enc = new TextEncoder();
    const [c1, c2] = enc.encode('é');
    const bytes = new Uint8Array([...enc.encode('BEGIN:VCALENDAR\rBEGIN:VEVENT\rDTSTART:20260914T083000\rDURATION:PT1H\rSUMMARY:Caf'), c1, 0x0d, 0x20, c2, ...enc.encode('\rEND:VEVENT\rEND:VCALENDAR\r')]);
    expect(read(decodeImportFile(bytes.buffer)).observations[0].subject).toBe('Café');
  });
});

describe('ICS review cycle 4 fixes', () => {
  it('reads a timed EXDATE or UNTIL on an all-day series by its own date when it has a zone, and by midnight for UTC', () => {
    const weekly = extra => read(cal(['DTSTART;VALUE=DATE:20260907', 'SUMMARY:Week', 'RRULE:FREQ=WEEKLY;COUNT=3', ...extra]), { timezone: 'America/New_York' }).observations.map(o => o.date);
    expect(weekly(['EXDATE;TZID=GMT Standard Time:20260914T000000'])).toEqual(['2026-09-07', '2026-09-21']);
    expect(weekly(['EXDATE:20260914T000000Z'])).toEqual(['2026-09-07', '2026-09-21']);
    expect(weekly(['EXDATE:20260914T040000Z'])).toEqual(['2026-09-07', '2026-09-21']);
    expect(read(cal(['DTSTART;VALUE=DATE:20260907', 'SUMMARY:Week', 'RRULE:FREQ=WEEKLY;UNTIL=20260914T000000Z']), { timezone: 'America/New_York' }).observations.map(o => o.date))
      .toEqual(['2026-09-07', '2026-09-14']);
  });

  it('keeps UTF-8 text with one stray or truncated byte, and strips a UTF-8 byte-order mark first', () => {
    const enc = new TextEncoder();
    const body = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260914T083000\r\nDURATION:PT1H\r\nSUMMARY:Français\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    expect(read(decodeImportFile(new Uint8Array([...enc.encode(body), 0xc3]).buffer)).observations[0].subject).toBe('Français');
    const stray = decodeImportFile(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(body.replace('Français', 'Fran\u00e7ais x')), 0x96]).buffer);
    expect(read(stray).observations[0].subject).toBe('Français x');
  });

  it('joins a fold that splits a UTF-16 surrogate pair', () => {
    const units = [...'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260914T083000\r\nDURATION:PT1H\r\nSUMMARY:Art '].map(ch => ch.charCodeAt(0));
    const [high, low] = [...'🎨'].flatMap(ch => [ch.charCodeAt(0), ch.charCodeAt(1)]);
    units.push(high, 0x0d, 0x0a, 0x20, low, ...[...'\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'].map(ch => ch.charCodeAt(0)));
    const bytes = new Uint8Array([0xff, 0xfe, ...units.flatMap(u => [u & 0xff, u >> 8])]);
    expect(read(decodeImportFile(bytes.buffer)).observations[0].subject).toBe('Art 🎨');
  });

  it('breaks a SEQUENCE tie by file order whatever form the RECURRENCE-ID takes', () => {
    const parsed = read(cal(
      ['UID:m', 'DTSTART;TZID=Europe/London:20260907T083000', 'DURATION:PT50M', 'SUMMARY:Maths', 'RRULE:FREQ=WEEKLY;COUNT=2'],
      ['UID:m', 'RECURRENCE-ID;TZID=Europe/London:20260914T083000', 'DTSTART;TZID=Europe/London:20260914T083000', 'DURATION:PT50M', 'SUMMARY:Earlier'],
      ['UID:m', 'RECURRENCE-ID:20260914T083000', 'DTSTART;TZID=Europe/London:20260914T083000', 'DURATION:PT50M', 'SUMMARY:Later'],
    ));
    expect(parsed.observations.map(o => o.subject)).toEqual(['Maths', 'Later']);
  });

  it('gives a shared UID\'s changes to the occurrence of the same kind first', () => {
    const parsed = read(cal(
      ['UID:s', 'DTSTART:20260907T083000', 'DURATION:PT50M', 'SUMMARY:P1', 'RRULE:FREQ=WEEKLY;COUNT=2'],
      ['UID:s', 'DTSTART;VALUE=DATE:20260907', 'SUMMARY:WeekA', 'RRULE:FREQ=WEEKLY;COUNT=2'],
      ['UID:s', 'RECURRENCE-ID;VALUE=DATE:20260914', 'DTSTART;VALUE=DATE:20260914', 'SUMMARY:WeekB'],
      ['UID:s', 'RECURRENCE-ID:20260914T083000', 'DTSTART:20260914T100000', 'DURATION:PT50M', 'SUMMARY:P1 moved'],
    ));
    expect(parsed.observations.filter(o => o.date === '2026-09-14').map(o => o.subject).sort()).toEqual(['P1 moved', 'WeekB']);
  });

  it('emits one one-off change per occurrence however its RECURRENCE-ID is written', () => {
    const parsed = read(cal(
      ['UID:x', 'RECURRENCE-ID;TZID=Europe/London:20260914T090000', 'DTSTART;TZID=Europe/London:20260914T100000', 'DURATION:PT1H', 'SUMMARY:A'],
      ['UID:x', 'RECURRENCE-ID:20260914T080000Z', 'DTSTART;TZID=Europe/London:20260914T110000', 'DURATION:PT1H', 'SUMMARY:B'],
    ));
    expect(parsed.observations.map(o => o.subject)).toEqual(['B']);
  });

  it('does not spend the repeat cap on occurrences left outside the window', () => {
    const parsed = read(cal(['DTSTART;VALUE=DATE:20251201', 'DTEND;VALUE=DATE:20251203', 'SUMMARY:Block', 'RRULE:FREQ=DAILY']), { from: '2026-01-01', to: '2027-05-14' });
    expect(parsed.observations).toHaveLength(500);
    expect(parsed.warnings.some(w => w.includes('more than 500 occurrences'))).toBe(false);
  });
});

describe('ICS changes that apply to later occurrences, and changes without a start', () => {
  const series = ['UID:m', 'DTSTART;TZID=Europe/London:20260907T090000', 'DURATION:PT50M', 'SUMMARY:Maths', 'LOCATION:B1', 'RRULE:FREQ=WEEKLY;COUNT=5'];

  it('applies a THISANDFUTURE change to its occurrence and every later one, leaving earlier ones', () => {
    const parsed = read(cal(series,
      ['UID:m', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/London:20260914T090000', 'DTSTART;TZID=Europe/London:20260914T110000', 'DURATION:PT1H', 'SUMMARY:Maths', 'LOCATION:C4'],
      ['UID:m', 'RECURRENCE-ID;TZID=Europe/London:20260928T090000', 'DTSTART;TZID=Europe/London:20260928T140000', 'DURATION:PT1H', 'SUMMARY:Maths', 'LOCATION:Hall'],
    ));
    expect(parsed.observations.map(o => `${brief(o)} ${o.room}`)).toEqual([
      '2026-09-07 09:00-09:50 Maths B1', '2026-09-14 11:00-12:00 Maths C4', '2026-09-21 11:00-12:00 Maths C4', '2026-09-28 14:00-15:00 Maths Hall', '2026-10-05 11:00-12:00 Maths C4',
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it('uses the latest THISANDFUTURE change before each occurrence', () => {
    const change = (date, time) => ['UID:m', `RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/London:${date}T090000`, `DTSTART;TZID=Europe/London:${date}T${time}`, 'DURATION:PT50M', 'SUMMARY:Maths'];
    const parsed = read(cal(series, change('20260928', '130000'), change('20260914', '110000')));
    expect(parsed.observations.map(o => o.start_time)).toEqual(['09:00', '11:00', '11:00', '13:00', '13:00']);
  });

  it('cancels the rest of a series with a cancelled THISANDFUTURE change, and still honours exclusions after a range', () => {
    const cancelled = read(cal(series, ['UID:m', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/London:20260921T090000', 'STATUS:CANCELLED']));
    expect(cancelled.observations.map(o => o.date)).toEqual(['2026-09-07', '2026-09-14']);
    const excluded = read(cal([...series, 'EXDATE;TZID=Europe/London:20261005T090000'],
      ['UID:m', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/London:20260914T090000', 'DTSTART;TZID=Europe/London:20260914T100000', 'DURATION:PT50M', 'SUMMARY:Maths']));
    expect(excluded.observations.map(brief)).toEqual(['2026-09-07 09:00-09:50 Maths', '2026-09-14 10:00-10:50 Maths', '2026-09-21 10:00-10:50 Maths', '2026-09-28 10:00-10:50 Maths']);
  });

  it('cancels an occurrence whose cancellation has no DTSTART, and keeps the series length for a change with no end', () => {
    const parsed = read(cal(series,
      ['UID:m', 'RECURRENCE-ID;TZID=Europe/London:20260914T090000', 'STATUS:CANCELLED'],
      ['UID:m', 'RECURRENCE-ID;TZID=Europe/London:20260921T090000', 'SUMMARY:Maths', 'LOCATION:Library'],
    ));
    expect(parsed.observations.map(o => `${brief(o)} ${o.room}`)).toEqual(['2026-09-07 09:00-09:50 Maths B1', '2026-09-21 09:00-09:50 Maths Library', '2026-09-28 09:00-09:50 Maths B1', '2026-10-05 09:00-09:50 Maths B1']);
    expect(parsed.warnings).toEqual([]);
  });
});

describe('ICS "this and future" changes: zones, window edges and shared UIDs', () => {
  const series = ['UID:m', 'DTSTART;TZID=Europe/London:20260907T090000', 'DURATION:PT50M', 'SUMMARY:Maths', 'RRULE:FREQ=WEEKLY;COUNT=5'];
  const times = parsed => parsed.observations.map(o => `${o.date} ${o.start_time}`);

  it('moves later lessons by the change\'s shift in its own zone, whatever zone it is written in', () => {
    const later = ['2026-09-07 09:00', '2026-09-14 11:00', '2026-09-21 11:00', '2026-09-28 11:00', '2026-10-05 11:00'];
    const utc = read(cal(series, ['UID:m', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260914T080000Z', 'DTSTART:20260914T100000Z', 'DURATION:PT50M', 'SUMMARY:Maths']));
    expect(times(utc)).toEqual(later);
    const paris = read(cal(series, ['UID:m', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Paris:20260914T100000', 'DTSTART;TZID=Europe/Paris:20260914T120000', 'DURATION:PT50M', 'SUMMARY:Maths']));
    expect(times(paris)).toEqual(later);
    const mixed = read(cal(series, ['UID:m', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260914T080000Z', 'DTSTART;TZID=Europe/London:20260914T110000', 'DURATION:PT50M', 'SUMMARY:Maths']));
    expect(times(mixed)).toEqual(later);
  });

  it('brings in lessons a change moves across the edge of the window, either way', () => {
    const monday = ['UID:w', 'DTSTART:20260803T090000', 'DURATION:PT50M', 'SUMMARY:Maths', 'RRULE:FREQ=WEEKLY;COUNT=10'];
    const toWednesday = ['UID:w', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260810T090000', 'DTSTART:20260812T090000', 'DURATION:PT50M', 'SUMMARY:Maths'];
    expect(read(cal(monday, toWednesday), { from: '2026-09-02', to: '2026-09-10' }).observations.map(o => o.date)).toEqual(['2026-09-02', '2026-09-09']);
    const toFriday = ['UID:w', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260810T090000', 'DTSTART:20260807T090000', 'DURATION:PT50M', 'SUMMARY:Maths'];
    expect(read(cal(monday, toFriday), { from: '2026-09-01', to: '2026-09-19' }).observations.map(o => o.date)).toEqual(['2026-09-04', '2026-09-11', '2026-09-18']);
  });

  it('applies a change only to the series that shares its key when two share a UID', () => {
    const parsed = read(cal(
      ['UID:s', 'DTSTART:20260907T090000', 'DURATION:PT50M', 'SUMMARY:P1', 'RRULE:FREQ=WEEKLY;COUNT=3'],
      ['UID:s', 'DTSTART:20260907T110000', 'DURATION:PT50M', 'SUMMARY:P3', 'RRULE:FREQ=WEEKLY;COUNT=3'],
      ['UID:s', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260914T110000', 'DTSTART:20260914T140000', 'DURATION:PT50M', 'SUMMARY:P3 moved'],
    ));
    expect(parsed.observations.map(o => `${o.date} ${o.start_time} ${o.subject}`)).toEqual([
      '2026-09-07 09:00 P1', '2026-09-07 11:00 P3', '2026-09-14 09:00 P1', '2026-09-14 14:00 P3 moved', '2026-09-21 09:00 P1', '2026-09-21 14:00 P3 moved',
    ]);
  });
});
