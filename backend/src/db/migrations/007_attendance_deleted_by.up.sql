-- D27 (docs/schema-design.md): attendance is soft-deleted, and the delete records WHO did it.
-- Attendance feeds payroll, so "this record vanished and nobody knows who removed it" is a
-- real gap. deleted_at already exists (001); this adds only the actor.
--
-- ON DELETE SET NULL, not RESTRICT: this is an audit pointer, and a RESTRICT pointer would
-- block ever hard-deleting an employee who happened to delete someone's attendance record.
-- Losing the pointer in that case is the lesser evil, and the deleted_at row itself remains.
--
-- NULL is legitimate on a deleted row (the deleter was later hard-deleted, or the row was
-- deleted before this migration existed), so the CHECK only forbids the reverse: an actor
-- recorded on a row that is not deleted.

ALTER TABLE attendance
  ADD COLUMN deleted_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE attendance
  ADD CONSTRAINT attendance_deleted_by_requires_deleted_at
  CHECK (deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL);

-- Only so the ON DELETE SET NULL above does not sequentially scan attendance when an employee
-- is hard-deleted; partial because almost every row has no deleter.
CREATE INDEX attendance_deleted_by_index
  ON attendance (deleted_by_employee_id) WHERE deleted_by_employee_id IS NOT NULL;
