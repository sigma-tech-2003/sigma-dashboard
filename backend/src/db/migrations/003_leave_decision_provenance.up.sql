-- Firestore's canUpdateLeave only ever changed `status` (firestore.rules:428-438); it
-- never recorded who decided a leave or when. leaves has no updatedAt field either, so
-- there is no proxy timestamp to backfill from. Every pre-cutover approved/rejected leave
-- has no real approver, but the leaves_decision_consistent constraint from
-- 001_initial_core_hr_hierarchy requires one whenever status <> 'pending'.
--
-- decision_recorded names the fact the constraint actually checks, not when the row
-- arrived. It defaults to true, so every row the live app ever inserts (Phase 9 onward)
-- keeps the original strict requirement with no code change there. Only the Firestore
-- importer ever sets it false, for a leave whose decision predates this migration.
--
-- leaves_no_self_approval needs no change: it already tolerates a NULL approver.

ALTER TABLE leaves ADD COLUMN decision_recorded boolean NOT NULL DEFAULT true;

ALTER TABLE leaves DROP CONSTRAINT leaves_decision_consistent;

ALTER TABLE leaves ADD CONSTRAINT leaves_decision_consistent CHECK (
  (status = 'pending' AND decided_by_employee_id IS NULL AND decided_at IS NULL) OR
  (status <> 'pending' AND decision_recorded
     AND decided_by_employee_id IS NOT NULL AND decided_at IS NOT NULL) OR
  (status <> 'pending' AND NOT decision_recorded
     AND decided_by_employee_id IS NULL AND decided_at IS NULL)
);
