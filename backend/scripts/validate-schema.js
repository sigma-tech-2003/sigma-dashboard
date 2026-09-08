import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "../src/db/migrator.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, "..", "src", "db", "migrations");
const migrations = await loadMigrations(migrationsDirectory);

if (migrations.length === 0) throw new Error("At least one schema migration is required.");
for (const migration of migrations) {
  if (!migration.sql.trim() || !migration.sql.includes("CREATE TABLE")) {
    throw new Error(`Migration ${migration.file} does not define a schema change.`);
  }
}

console.info(`Validated ${migrations.length} PostgreSQL migration file(s) without a database connection.`);
