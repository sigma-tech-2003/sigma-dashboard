import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// No database. D41 adds migration 012 (the flag and the audit column) and 013 (drops the token table). What these
// check is the SQL text the migrator will run and the down migrations that reverse it; the behaviour is proved against
// a real PostgreSQL by scripts/e2e-frontend-prereqs.js.

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "migrations");
const read = (name) => readFile(path.join(directory, name), "utf8");
const normalise = (sql) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();

// ---- 012 ----

test("012 up: adds the flag, defaulting to false so every existing account (and the bootstrap admin) is unaffected", async () => {
  const sql = normalise(await read("012_temporary_passwords.up.sql"));

  assert.match(sql, /ADD COLUMN must_change_password boolean NOT NULL DEFAULT false/);
});

test("012 up: adds the audit column as a nullable FK to employees that never blocks removing the creator", async () => {
  const sql = normalise(await read("012_temporary_passwords.up.sql"));

  assert.match(sql, /ADD COLUMN password_set_by_employee_id uuid REFERENCES employees\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(sql, /password_set_by_employee_id uuid NOT NULL/);
});

test("012 up: indexes the flagged accounts with a partial index", async () => {
  const sql = normalise(await read("012_temporary_passwords.up.sql"));

  assert.match(sql, /CREATE INDEX users_must_change_password_index ON users \(id\) WHERE must_change_password AND deleted_at IS NULL/);
});

test("012 up: touches only users, and does not recreate columns migration 001 already has", async () => {
  const sql = normalise(await read("012_temporary_passwords.up.sql"));

  assert.doesNotMatch(sql, /ADD COLUMN password_updated_at/);
  assert.doesNotMatch(sql, /ADD COLUMN last_login_at/);
  assert.equal([...sql.matchAll(/ALTER TABLE (\w+)/g)].every((match) => match[1] === "users"), true);
  assert.doesNotMatch(sql, /DROP /);
});

test("012 down: drops the index and both columns, and clears its own ledger row", async () => {
  const sql = normalise(await read("012_temporary_passwords.down.sql"));

  assert.match(sql, /DROP INDEX IF EXISTS users_must_change_password_index/);
  assert.match(sql, /DROP COLUMN IF EXISTS password_set_by_employee_id/);
  assert.match(sql, /DROP COLUMN IF EXISTS must_change_password/);
  assert.match(sql, /DELETE FROM schema_migrations WHERE id = '012_temporary_passwords'/);
});

test("012: migration 001 really does already have password_updated_at and last_login_at (the comment's claim)", async () => {
  const sql = normalise(await read("001_initial_core_hr_hierarchy.up.sql"));

  assert.match(sql, /password_updated_at timestamptz/);
  assert.match(sql, /last_login_at timestamptz/);
});

// ---- 013 ----

test("013 up: drops the token table and nothing else", async () => {
  const sql = normalise(await read("013_drop_password_set_tokens.up.sql"));

  assert.equal(sql, "DROP TABLE IF EXISTS password_set_tokens;");
});

test("013 down: recreates the table EXACTLY as migration 006 defined it", async () => {
  const original = normalise(await read("006_password_set_tokens.up.sql"));
  const restored = normalise(await read("013_drop_password_set_tokens.down.sql"));

  const tableOf = (sql) => /CREATE TABLE password_set_tokens \(.*?\);/.exec(sql)?.[0];
  assert.ok(tableOf(original), "006 defines the table");
  assert.equal(tableOf(restored), tableOf(original));

  for (const statement of [
    "CREATE UNIQUE INDEX password_set_tokens_hash_unique ON password_set_tokens (token_hash);",
    "CREATE INDEX password_set_tokens_user_live_index ON password_set_tokens (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;",
    "CREATE INDEX password_set_tokens_expiry_index ON password_set_tokens (expires_at);",
  ]) {
    assert.ok(original.includes(statement), `006 has: ${statement}`);
    assert.ok(restored.includes(statement), `013 down restores: ${statement}`);
  }
  assert.match(restored, /DELETE FROM schema_migrations WHERE id = '013_drop_password_set_tokens'/);
});

test("006 is untouched: it still creates the table (applied migrations are never edited)", async () => {
  const sql = normalise(await read("006_password_set_tokens.up.sql"));

  assert.match(sql, /CREATE TABLE password_set_tokens/);
  assert.doesNotMatch(sql, /must_change_password/);
});

test("every migration from 012 on has both halves, so db:validate and db:rollback work", async () => {
  for (const id of ["012_temporary_passwords", "013_drop_password_set_tokens"]) {
    assert.ok((await read(`${id}.up.sql`)).trim().length > 0, `${id} up`);
    assert.ok((await read(`${id}.down.sql`)).trim().length > 0, `${id} down`);
  }
});
