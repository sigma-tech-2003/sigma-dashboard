-- Bookkeeping for the Firestore importer, deliberately outside the business schema
-- docs/schema-design.md defines -- the same role schema_migrations plays for the migrator.
--
-- companies, departments, users, employees, attendance and payroll all have a real
-- natural key already (singleton, name, email, user_id, employee+date, employee+period),
-- so a plain INSERT ... ON CONFLICT ... DO UPDATE makes re-importing them idempotent for
-- free. projects and kpis have no natural key at all -- no column or combination is
-- guaranteed unique across two export runs. Without something to recognize "this
-- Firestore document was already imported," a second run would insert duplicates.
--
-- This table records, per source document, which Postgres row it became. On import, a
-- project or KPI is looked up here by (source_collection, source_id); if found, its
-- target_id is reused and the row is updated in place; if not, a fresh id is generated and
-- the mapping recorded alongside the insert.

CREATE TABLE firestore_import_refs (
  source_collection text NOT NULL,
  source_id         text NOT NULL,
  target_id         uuid NOT NULL,
  imported_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_collection, source_id)
);

CREATE INDEX firestore_import_refs_target_index ON firestore_import_refs (target_id);
