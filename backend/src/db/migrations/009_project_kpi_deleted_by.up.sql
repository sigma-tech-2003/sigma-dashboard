-- D29 (docs/schema-design.md): projects and KPIs are soft-deleted, and the delete records WHO
-- did it. A KPI carries a recorded evaluation and a project is what scopes it, so "this record
-- vanished and nobody knows who removed it" is the same real gap as for attendance and payroll.
-- deleted_at already exists on both (001); this adds only the actor. Mirrors 007 and 008, which
-- did the same for attendance and payroll -- one migration here only because both tables are
-- decided together.
--
-- ON DELETE SET NULL, not RESTRICT: this is an audit pointer, and a RESTRICT pointer would
-- block ever hard-deleting an employee who happened to delete someone's project or KPI.
-- Losing the pointer in that case is the lesser evil, and the deleted_at row itself remains.
--
-- NULL is legitimate on a deleted row (the deleter was later hard-deleted, or the row was
-- deleted before this migration existed), so each CHECK only forbids the reverse: an actor
-- recorded on a row that is not deleted.

ALTER TABLE projects
  ADD COLUMN deleted_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE projects
  ADD CONSTRAINT projects_deleted_by_requires_deleted_at
  CHECK (deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL);

-- Only so the ON DELETE SET NULL above does not sequentially scan projects when an employee
-- is hard-deleted; partial because almost every row has no deleter.
CREATE INDEX projects_deleted_by_index
  ON projects (deleted_by_employee_id) WHERE deleted_by_employee_id IS NOT NULL;

ALTER TABLE kpis
  ADD COLUMN deleted_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE kpis
  ADD CONSTRAINT kpis_deleted_by_requires_deleted_at
  CHECK (deleted_by_employee_id IS NULL OR deleted_at IS NOT NULL);

CREATE INDEX kpis_deleted_by_index
  ON kpis (deleted_by_employee_id) WHERE deleted_by_employee_id IS NOT NULL;
