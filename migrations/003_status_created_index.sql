-- The list reads page by status in (created_at, id) order. Active rows had a
-- partial index to lean on; drafts had none, so that read scanned the table
-- and sorted it. This serves both in order, with no sort.
CREATE INDEX IF NOT EXISTS app_timetable__timetables_status_created_idx ON app_timetable__timetables(status,created_at,id);
