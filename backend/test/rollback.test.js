import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadMigrations, loadRollbacks, rollbackLastMigration } from "../src/db/migrator.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, "..", "src", "db", "migrations");

// These tests do not connect to a database. The rollback path is exercised against a
// fake client so the guard rails can be asserted without a server present.

test("every up migration has a matching down migration", async () => {
  const ups = await loadMigrations(migrationsDirectory);
  const downs = await loadRollbacks(migrationsDirectory);
  assert.deepEqual(
    downs.map((entry) => entry.id),
    ups.map((entry) => entry.id),
    "each NNN_name.up.sql needs an NNN_name.down.sql",
  );
});

test("every down migration clears its own schema_migrations row", async () => {
  // The defect this guards against: after a rollback the ledger still claimed the
  // migration was applied, so db:migrate reported "Database is current" against an
  // empty database and created nothing.
  for (const rollback of await loadRollbacks(migrationsDirectory)) {
    assert.match(
      rollback.sql,
      new RegExp(`DELETE FROM schema_migrations WHERE id = '${rollback.id}'`),
      `${rollback.file} must delete its own ledger row`,
    );
    // Guarded, so the file stays runnable against a database that never had it applied.
    assert.match(
      rollback.sql,
      /to_regclass\('public\.schema_migrations'\) IS NOT NULL/,
      `${rollback.file} must guard the DELETE against a missing ledger table`,
    );
  }
});

/** Minimal stand-in for a pg pool, recording the statements it is asked to run. */
function fakeDatabase({ currentDatabase = "sigma_hrm_scratch", latest = "001_initial_core_hr_hierarchy", staleAfterRollback = false } = {}) {
  const statements = [];
  const client = {
    async query(text, values) {
      statements.push(text.trim().split("\n")[0]);
      if (text.includes("current_database()")) {
        return { rows: [{ current_database: currentDatabase }] };
      }
      if (text.includes("to_regclass")) {
        return { rows: [{ present: true }] };
      }
      if (text.includes("ORDER BY id DESC")) {
        return { rows: latest ? [{ id: latest }] : [] };
      }
      if (text.includes("SELECT 1 FROM schema_migrations WHERE id")) {
        assert.deepEqual(values, [latest]);
        return { rows: staleAfterRollback ? [{ "?column?": 1 }] : [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { statements, connect: async () => client };
}

test("rollback refuses without an explicit database confirmation", async () => {
  const database = fakeDatabase();
  await assert.rejects(
    rollbackLastMigration(database, migrationsDirectory),
    /pass --confirm-database=sigma_hrm_scratch/,
  );
  assert.ok(!database.statements.includes("BEGIN"), "must not open a transaction");
});

test("rollback refuses when the confirmation names a different database", async () => {
  const database = fakeDatabase({ currentDatabase: "sigma_hrm_production" });
  await assert.rejects(
    rollbackLastMigration(database, migrationsDirectory, { confirmDatabase: "sigma_hrm_scratch" }),
    /connected to "sigma_hrm_production" but "sigma_hrm_scratch" was confirmed/,
  );
  assert.ok(!database.statements.includes("BEGIN"), "must not open a transaction");
});

test("rollback aborts if the down migration leaves its ledger row behind", async () => {
  const database = fakeDatabase({ staleAfterRollback: true });
  await assert.rejects(
    rollbackLastMigration(database, migrationsDirectory, { confirmDatabase: "sigma_hrm_scratch" }),
    /did not clear its schema_migrations row/,
  );
  assert.ok(database.statements.includes("ROLLBACK"), "must roll back, not commit");
  assert.ok(!database.statements.includes("COMMIT"));
});

test("rollback commits and reports the migration it reversed", async () => {
  const database = fakeDatabase();
  const rolledBack = await rollbackLastMigration(database, migrationsDirectory, {
    confirmDatabase: "sigma_hrm_scratch",
  });
  assert.equal(rolledBack, "001_initial_core_hr_hierarchy");
  assert.ok(database.statements.includes("COMMIT"));
  assert.ok(database.statements.includes("BEGIN"));
  // The advisory lock must be taken before the down SQL runs.
  const lockIndex = database.statements.findIndex((statement) => statement.includes("pg_advisory_xact_lock"));
  const ledgerIndex = database.statements.findIndex((statement) => statement.includes("ORDER BY id DESC"));
  assert.ok(lockIndex > -1 && lockIndex < ledgerIndex);
});

test("rollback is a no-op when nothing is applied", async () => {
  const database = fakeDatabase({ latest: null });
  const rolledBack = await rollbackLastMigration(database, migrationsDirectory, {
    confirmDatabase: "sigma_hrm_scratch",
  });
  assert.equal(rolledBack, null);
  assert.ok(!database.statements.includes("COMMIT"));
});
