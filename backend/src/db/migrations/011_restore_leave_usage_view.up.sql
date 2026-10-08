-- D40 (docs/schema-design.md): there are no leave entitlements and no limits, so the per-day,
-- per-month usage view that migration 010 built for the pool model is no longer wanted.
--
-- This restores employee_leave_usage to the shape it had before 010 -- the text of migration 001's
-- view: approved leave only, per employee, leave type and calendar year, each leave attributed whole
-- to the year it STARTS in. That is exactly what a "days taken" figure needs, and no more.
--
-- 010 is already applied and is never edited, so this is a new migration. 010's other half -- the
-- leaves.deleted_by_employee_id column, its CHECK and its index -- is untouched and still wanted.
--
-- CREATE OR REPLACE VIEW cannot change a view's columns, hence DROP and CREATE.
--
-- `days_used` is sum(integer), which is bigint; pg returns bigint as a string. The repository casts it
-- (::int) where it reads the view.

DROP VIEW employee_leave_usage;

CREATE VIEW employee_leave_usage AS
SELECT employee_id,
       type,
       date_part('year', start_date)::int AS leave_year,
       sum(days) AS days_used
FROM leaves
WHERE status = 'approved' AND deleted_at IS NULL
GROUP BY employee_id, type, date_part('year', start_date);
