-- Reverses 007_attendance_deleted_by.up.sql.
--
-- As with 001-006, this file is only reachable through `npm run db:rollback`, which
-- requires --confirm-database=<name>.

DROP INDEX IF EXISTS attendance_deleted_by_index;
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_deleted_by_requires_deleted_at;
ALTER TABLE attendance DROP COLUMN IF EXISTS deleted_by_employee_id;

-- Clear this migration's ledger row, matching the established convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '007_attendance_deleted_by';
  END IF;
END $$;
