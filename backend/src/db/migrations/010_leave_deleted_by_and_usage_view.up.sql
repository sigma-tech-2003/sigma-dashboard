-- D31 (docs/schema-design.md): two things Phase 9 needs from the schema.
--
-- 1. Leaves are soft-deleted, and the delete records WHO did it, as for attendance, payroll,
--    projects and KPIs (007-009). deleted_at already exists (001); this adds only the actor.
--    ON DELETE SET NULL, not RESTRICT: this is an audit pointer, and a RESTRICT pointer would
--    block ever hard-deleting an employee who happened to delete someone's leave. NULL is
--    legitimate on a deleted row (the deleter was later hard-deleted, or the row was deleted
--    before this migration existed), so the CHECK only forbids the reverse: an actor recorded on
--    a row that is not deleted.
--
-- 2. employee_leave_usage is replaced. The 001 view grouped by YEAR and TYPE and attributed a
--    whole leave to its start year, which cannot express management's entitlement (D4): a monthly
--    pool that resets every month, and a leave that spans months. D5 settled that a leave is split
--    per calendar day, each day charged to the month it falls in, so this view does exactly that.
--
--    It is deliberately a pure USAGE fact. It knows nothing about pools, allowances or which leave
--    type draws on which pool: the type-to-pool map and the entitlement numbers live in one code
--    module (src/services/leaveEntitlements.js), so a rule change is a code change, not a view
--    rewrite. Only approved and pending leaves count -- a pending request reserves its days -- and
--    rejected and soft-deleted leaves never do (section 8 item 7). The two statuses are separate
--    columns so a caller can show "approved" and "waiting" apart.
--
--    CREATE OR REPLACE VIEW cannot change a view's columns, hence DROP and CREATE. Nothing in the
--    code base reads the old columns (leave_year, days_used).

ALTER TABLE leaves
  ADD COLUMN deleted_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE leaves
  ADD CONSTRAINT leaves_deleted_by_requires_deleted_at
  CHECK (deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL);

-- Only so the ON DELETE SET NULL above does not sequentially scan leaves when an employee is
-- hard-deleted; partial because almost every row has no deleter.
CREATE INDEX leaves_deleted_by_index
  ON leaves (deleted_by_employee_id) WHERE deleted_by_employee_id IS NOT NULL;

DROP VIEW employee_leave_usage;

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
