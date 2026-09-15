-- Reverses 003_leave_decision_provenance.up.sql.
--
-- Refuses if any decision_recorded = false row exists: the original strict constraint
-- cannot be restored while real imported data depends on the relaxation, and this file
-- must not silently corrupt that data by dropping the column out from under it.
--
-- As with 001 and 002, this file is only reachable through `npm run db:rollback`, which
-- requires --confirm-database=<name>.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM leaves WHERE decision_recorded = false) THEN
    RAISE EXCEPTION
      'Cannot roll back 003_leave_decision_provenance: % row(s) have decision_recorded = false and would violate the original leaves_decision_consistent constraint.',
      (SELECT count(*) FROM leaves WHERE decision_recorded = false);
  END IF;
END $$;

ALTER TABLE leaves DROP CONSTRAINT leaves_decision_consistent;

ALTER TABLE leaves ADD CONSTRAINT leaves_decision_consistent CHECK (
  (status = 'pending'  AND decided_by_employee_id IS NULL     AND decided_at IS NULL) OR
  (status <> 'pending' AND decided_by_employee_id IS NOT NULL AND decided_at IS NOT NULL)
);

ALTER TABLE leaves DROP COLUMN decision_recorded;

-- Clear this migration's ledger row, matching 001 and 002's convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '003_leave_decision_provenance';
  END IF;
END $$;
