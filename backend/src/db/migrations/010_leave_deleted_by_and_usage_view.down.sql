-- Reverses 010_leave_deleted_by_and_usage_view.up.sql.
--
-- As with 001-009, this file is only reachable through `npm run db:rollback`, which
-- requires --confirm-database=<name>.

-- Restore 001's view exactly (year and type, a whole leave attributed to its start year).
DROP VIEW IF EXISTS employee_leave_usage;

CREATE VIEW employee_leave_usage AS
SELECT employee_id,
       type,
       date_part('year', start_date)::int AS leave_year,
       sum(days) AS days_used
FROM leaves
WHERE status = 'approved' AND deleted_at IS NULL
GROUP BY employee_id, type, date_part('year', start_date);

DROP INDEX IF EXISTS leaves_deleted_by_index;
ALTER TABLE leaves DROP CONSTRAINT IF EXISTS leaves_deleted_by_requires_deleted_at;
ALTER TABLE leaves DROP COLUMN IF EXISTS deleted_by_employee_id;

-- Clear this migration's ledger row, matching the established convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '010_leave_deleted_by_and_usage_view';
  END IF;
END $$;
