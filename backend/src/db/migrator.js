import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MIGRATION_FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.up\.sql$/;

export async function loadMigrations(migrationsDirectory) {
  const files = await readdir(migrationsDirectory);
  const migrationFiles = files.filter((file) => MIGRATION_FILE_PATTERN.test(file)).sort();

  return Promise.all(migrationFiles.map(async (file) => ({
    id: file.replace(/\.up\.sql$/, ""),
    file,
    sql: await readFile(path.join(migrationsDirectory, file), "utf8"),
  })));
}

export async function runMigrations(database, migrationsDirectory) {
  const migrations = await loadMigrations(migrationsDirectory);
  const client = await database.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("SELECT pg_advisory_xact_lock(61720101)");
    const { rows } = await client.query("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.id));

    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
    }

    await client.query("COMMIT");
    return migrations.map((migration) => migration.id).filter((id) => !applied.has(id));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
