-- Reverses 011_restore_leave_usage_view.up.sql.
--
-- As with 001-010, this file is only reachable through `npm run db:rollback`, which
-- requires --confirm-database=<name>.

-- Put back the view as migration 010 left it: one row per employee, type, calendar year and calendar
-- month, splitting every leave per calendar day, with approved and pending counted separately.
DROP VIEW IF EXISTS employee_leave_usage;

CREATE VIEW employee_leave_usage AS
SELECT leaves.employee_id,
       leaves.type,
       date_part('year', leave_dates.leave_date)::int  AS usage_year,
       date_part('month', leave_dates.leave_date)::int AS usage_month,
       (count(*) FILTER (WHERE leaves.status = 'approved'))::int AS days_approved,
       (count(*) FILTER (WHERE leaves.status = 'pending'))::int  AS days_pending
FROM leaves
CROSS JOIN LATERAL generate_series(
  leaves.start_date::timestamp, leaves.end_date::timestamp, interval '1 day'
) AS leave_dates(leave_date)
WHERE leaves.status IN ('approved', 'pending') AND leaves.deleted_at IS NULL
GROUP BY 1, 2, 3, 4;

-- Clear this migration's ledger row, matching the established convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '011_restore_leave_usage_view';
  END IF;
END $$;
