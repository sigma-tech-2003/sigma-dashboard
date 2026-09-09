import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIGRATION_FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.up\.sql$/;
const ROLLBACK_FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.down\.sql$/;
const ADVISORY_LOCK_KEY = 61720101;

async function loadSqlFiles(migrationsDirectory, pattern, suffix) {
  const files = await readdir(migrationsDirectory);
  const matching = files.filter((file) => pattern.test(file)).sort();

  return Promise.all(matching.map(async (file) => ({
    id: file.replace(suffix, ""),
    file,
    sql: await readFile(path.join(migrationsDirectory, file), "utf8"),
  })));
}

export async function loadMigrations(migrationsDirectory) {
  return loadSqlFiles(migrationsDirectory, MIGRATION_FILE_PATTERN, /\.up\.sql$/);
}

export async function loadRollbacks(migrationsDirectory) {
  return loadSqlFiles(migrationsDirectory, ROLLBACK_FILE_PATTERN, /\.down\.sql$/);
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
    await client.query(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);
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

/**
 * Reverses the most recently applied migration by running its .down.sql.
 *
 * A down migration is responsible for clearing its own schema_migrations row. If it does
 * not, this function aborts rather than committing: a ledger that disagrees with the
 * schema is how `db:migrate` ends up reporting "Database is current" against an empty
 * database. That check is here so the failure cannot recur for a future migration.
 *
 * Destructive. Requires confirmDatabase to match the connected database by name.
 */
export async function rollbackLastMigration(database, migrationsDirectory, options = {}) {
  const { confirmDatabase } = options;
  const client = await database.connect();

  try {
    const { rows: [{ current_database: currentDatabase }] } =
      await client.query("SELECT current_database()");

    if (!confirmDatabase) {
      throw new Error(
        `Refusing to roll back: pass --confirm-database=${currentDatabase} to confirm the target.`,
      );
    }
    if (confirmDatabase !== currentDatabase) {
      throw new Error(
        `Refusing to roll back: connected to "${currentDatabase}" but "${confirmDatabase}" was confirmed.`,
      );
    }

    await client.query("BEGIN");

    const { rows: [ledger] } = await client.query(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    );
    if (!ledger.present) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);

    const { rows: [latest] } = await client.query(
      "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
    );
    if (!latest) {
      await client.query("ROLLBACK");
      return null;
    }

    const rollbacks = await loadRollbacks(migrationsDirectory);
    const rollback = rollbacks.find((candidate) => candidate.id === latest.id);
    if (!rollback) {
      throw new Error(`No down migration found for "${latest.id}".`);
    }

    await client.query(rollback.sql);

    const { rows: stale } = await client.query(
      "SELECT 1 FROM schema_migrations WHERE id = $1",
      [latest.id],
    );
    if (stale.length > 0) {
      throw new Error(
        `${rollback.file} did not clear its schema_migrations row. ` +
        "Add a DELETE for this migration id, or the ledger will disagree with the schema.",
      );
    }

    await client.query("COMMIT");
    return latest.id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------------
// CLI entry point: `npm run db:rollback -- --confirm-database=<name>`
//
// This lives here rather than in backend/scripts/ only because the follow-up that
// introduced it was scoped to this file. A dedicated scripts/rollback.js alongside
// migrate.js would be tidier and is a one-file move.
// --------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const confirmArgument = process.argv
    .slice(2)
    .find((argument) => argument.startsWith("--confirm-database="));
  const confirmDatabase = confirmArgument?.slice("--confirm-database=".length);

  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to roll back with NODE_ENV=production.");
    process.exit(1);
  }

  const { closePool, getPool } = await import("./pool.js");
  const migrationsDirectory = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations",
  );

  try {
    const rolledBack = await rollbackLastMigration(getPool(), migrationsDirectory, {
      confirmDatabase,
    });
    console.info(rolledBack ? `Rolled back: ${rolledBack}` : "Nothing to roll back.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
