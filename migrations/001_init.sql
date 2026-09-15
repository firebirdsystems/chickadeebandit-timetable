CREATE TABLE IF NOT EXISTS app_timetable__timetables (
 id TEXT PRIMARY KEY, member_id TEXT NOT NULL, name TEXT NOT NULL,
 cycle_kind TEXT NOT NULL CHECK(cycle_kind IN ('weekly','day_rotation')),
 cycle_length INTEGER NOT NULL CHECK((cycle_kind = 'weekly' AND cycle_length BETWEEN 1 AND 4) OR (cycle_kind = 'day_rotation' AND cycle_length BETWEEN 2 AND 10)),
 anchor_date TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL CHECK(end_date >= start_date),
 override_consumes_cycle_day INTEGER NOT NULL DEFAULT 0 CHECK(override_consumes_cycle_day IN (0,1)),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0), export_mode TEXT NOT NULL DEFAULT 'off' CHECK(export_mode IN ('off','day')),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS app_timetable__active_member_idx
 ON app_timetable__timetables(member_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS app_timetable__member_idx ON app_timetable__timetables(member_id,status);
CREATE TABLE IF NOT EXISTS app_timetable__periods (
 id TEXT PRIMARY KEY, timetable_id TEXT NOT NULL REFERENCES app_timetable__timetables(id) ON DELETE CASCADE, label TEXT NOT NULL,
 start_time TEXT NOT NULL, end_time TEXT NOT NULL CHECK(end_time > start_time), sort_order INTEGER NOT NULL,
 created_by TEXT NOT NULL, UNIQUE(timetable_id,id)
);
CREATE INDEX IF NOT EXISTS app_timetable__periods_parent_idx ON app_timetable__periods(timetable_id,sort_order,id);
CREATE TABLE IF NOT EXISTS app_timetable__lessons (
 id TEXT PRIMARY KEY, timetable_id TEXT NOT NULL REFERENCES app_timetable__timetables(id) ON DELETE CASCADE, slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 27),
 period_id TEXT NOT NULL, subject TEXT NOT NULL, room TEXT NOT NULL DEFAULT '',
 teacher TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
 UNIQUE(timetable_id,slot,period_id),
 FOREIGN KEY(timetable_id,period_id) REFERENCES app_timetable__periods(timetable_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS app_timetable__lessons_parent_idx ON app_timetable__lessons(timetable_id,slot,id);
CREATE TABLE IF NOT EXISTS app_timetable__exceptions (
 id TEXT PRIMARY KEY, timetable_id TEXT NOT NULL REFERENCES app_timetable__timetables(id) ON DELETE CASCADE, start_date TEXT NOT NULL,
 end_date TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('no_school','day_override')),
 override_slot INTEGER, label TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
 CHECK(end_date >= start_date),
 CHECK(kind != 'day_override' OR (start_date = end_date AND override_slot IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS app_timetable__exceptions_parent_idx ON app_timetable__exceptions(timetable_id,start_date,id);
CREATE TABLE IF NOT EXISTS app_timetable__school_days (
 id TEXT PRIMARY KEY, timetable_id TEXT NOT NULL REFERENCES app_timetable__timetables(id) ON DELETE CASCADE, day_date TEXT NOT NULL,
 slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 27), label TEXT NOT NULL DEFAULT '',
 materializer_version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
 UNIQUE(timetable_id,day_date)
);
CREATE INDEX IF NOT EXISTS app_timetable__school_days_date_idx ON app_timetable__school_days(day_date,timetable_id);
