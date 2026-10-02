import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations, loadRollbacks } from "../src/db/migrator.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, "..", "src", "db", "migrations");
const migrations = await loadMigrations(migrationsDirectory);
const rollbacks = await loadRollbacks(migrationsDirectory);

if (migrations.length === 0) throw new Error("At least one schema migration is required.");

// Structural checks only -- this never parses SQL or connects to a database. Every migration
// must have SQL in it and a matching .down.sql. It deliberately does not require any particular
// statement (it once demanded CREATE TABLE, which every ALTER-, SEQUENCE- or INDEX-only
// migration after 001 failed): what a migration does is not this script's business.
const rollbackIds = new Set(rollbacks.map((rollback) => rollback.id));
for (const migration of migrations) {
  if (!migration.sql.trim()) {
    throw new Error(`Migration ${migration.file} is empty.`);
  }
  if (!rollbackIds.has(migration.id)) {
    throw new Error(`Migration ${migration.file} has no matching ${migration.id}.down.sql.`);
  }
}

const migrationIds = new Set(migrations.map((migration) => migration.id));
for (const rollback of rollbacks) {
  if (!migrationIds.has(rollback.id)) {
    throw new Error(`${rollback.file} has no matching ${rollback.id}.up.sql.`);
  }
  if (!rollback.sql.trim()) {
    throw new Error(`${rollback.file} is empty.`);
  }
}

console.info(`Validated ${migrations.length} PostgreSQL migration file(s) without a database connection.`);
