-- Where a timetable came from (plan §5.5). source_kind is plaintext
-- (db_plaintext_columns); source_digest is the SHA-256 of the imported text,
-- encrypted and compared client-side only. NULL for manual timetables, so no
-- empty string is ever written to an encrypted column.
ALTER TABLE app_timetable__timetables ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual' CHECK(source_kind IN ('manual','csv','ics','calendar'));
ALTER TABLE app_timetable__timetables ADD COLUMN source_digest TEXT;
