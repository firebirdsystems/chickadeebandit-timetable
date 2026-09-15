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
for recovery. Calendar import/export, photo import and ambient kiosk sharing
are later phases.
