# Timetable

A Chickadee Bandit app for student school schedules. Phase 1 supports weekly
patterns of 1–4 weeks and rotating cycles of 2–10 school days, bell periods,
lesson grids, term dates, holidays and day overrides. It shows one summary
per student on Today and a count in glance; the widget shows today's lessons.

## Local checks

Use Node 22. Run `npm ci`, `npm test`, and `npm run build`. The built bundle is
`dist/bundle.json`. The app's hub contract requires the opt-in
`parent_owner_actions` policy and client-side `requireChanges` batch guards.

Open the app from a household to write data. A draft is created before the
initial projection is committed; a failed activation leaves that draft available
for recovery.

Import from a spreadsheet accepts CSV/TSV files or pasted text: either columns
named day, week, start, end, subject, room and teacher, or a grid with days
across the top and times down the side. Every import is reviewed first, with a
diff when it replaces a student's active timetable. The draft is filled over
several guarded batches and activated in one; a failed fill discards the draft.
The parsing and planning code is in `src/import.js`.

A calendar file (.ics) exported from a school portal goes through the same
review. `src/ics.js` reads its events and repeat rules into household-local
lessons, and `src/infer.js` works out the weekly or rotating cycle from lessons
that repeat, using "Day N"/"Week A" labels when the calendar has them. Review
shows the evidence, the events left out, the weekdays with no lessons (tick the
ones the school was closed) and whether each school day in the calendar lands
on the same day in the draft. Synced-calendar import, calendar export, photo
import and ambient kiosk sharing are later phases.
