import assert from "node:assert/strict";
import test from "node:test";
import { createPasswordSetTokenRepository } from "../src/repositories/passwordSetTokenRepository.js";

// No database. Fake client matches queries by substring, same style as
// employeeRepository.test.js.

function fakeDatabase(handlers) {
  const calls = [];
  const client = {
    async query(text, values) {
      const trimmed = text.trim();
      calls.push({ text: trimmed, values });
      for (const [matcher, response] of handlers) {
        const matches = typeof matcher === "string" ? trimmed.includes(matcher) : matcher.test(trimmed);
        if (!matches) continue;
        const resolved = typeof response === "function" ? response(values) : response;
        if (resolved?.throwError) throw resolved.throwError;
        return resolved ?? { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { calls, connect: async () => client };
}

// ---------------------------------------------------------------------------
// issueToken
// ---------------------------------------------------------------------------

test("issueToken: revokes any still-live token for the user, then inserts the new one, in one transaction", async () => {
  const database = fakeDatabase([
    ["UPDATE password_set_tokens SET revoked_at", { rows: [] }],
    ["INSERT INTO password_set_tokens", { rows: [{ id: "token-2", user_id: "user-1", expires_at: "2026-10-01" }] }],
  ]);
  const repository = createPasswordSetTokenRepository(database);

  const result = await repository.issueToken({ userId: "user-1", tokenHash: "hash-2", expiresAt: "2026-10-01" });

  assert.deepEqual(result, { id: "token-2", user_id: "user-1", expires_at: "2026-10-01" });
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");

  const revoke = database.calls.find((call) => call.text.includes("revoked_at"));
  assert.deepEqual(revoke.values, ["user-1"]);
  assert.match(revoke.text, /used_at IS NULL AND revoked_at IS NULL/);

  const insert = database.calls.find((call) => call.text.startsWith("INSERT INTO password_set_tokens"));
  assert.deepEqual(insert.values, ["user-1", "hash-2", "2026-10-01"]);
});

test("issueToken: a failure partway through rolls back rather than partially applying", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([
    ["UPDATE password_set_tokens SET revoked_at", { rows: [] }],
    ["INSERT INTO password_set_tokens", { throwError: boom }],
  ]);
  const repository = createPasswordSetTokenRepository(database);

  await assert.rejects(
    repository.issueToken({ userId: "user-1", tokenHash: "hash-2", expiresAt: "2026-10-01" }),
    /connection reset/,
  );
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});

// ---------------------------------------------------------------------------
// redeemToken
// ---------------------------------------------------------------------------

test("redeemToken: happy path activates the user, marks the token used, and revokes refresh tokens -- all in one transaction", async () => {
  const database = fakeDatabase([
    [/SELECT id, user_id FROM password_set_tokens/, { rows: [{ id: "token-1", user_id: "user-1" }] }],
    ["UPDATE users SET password_hash", { rows: [] }],
    ["UPDATE password_set_tokens SET used_at", { rows: [] }],
    ["UPDATE refresh_tokens SET revoked_at", { rows: [] }],
  ]);
  const repository = createPasswordSetTokenRepository(database);

  const result = await repository.redeemToken("hash-1", "argon2-hash-of-new-password");

  assert.deepEqual(result, { userId: "user-1" });
  assert.equal(database.calls[0].text, "BEGIN");
  assert.equal(database.calls.at(-1).text, "COMMIT");

  const select = database.calls.find((call) => call.text.includes("SELECT id, user_id FROM password_set_tokens"));
  assert.match(select.text, /used_at IS NULL AND revoked_at IS NULL AND expires_at > now\(\)/);
  assert.deepEqual(select.values, ["hash-1"]);

  const userUpdate = database.calls.find((call) => call.text.startsWith("UPDATE users SET password_hash"));
  assert.match(userUpdate.text, /status = 'active'/);
  assert.deepEqual(userUpdate.values, ["argon2-hash-of-new-password", "user-1"]);

  const tokenUpdate = database.calls.find((call) => call.text.startsWith("UPDATE password_set_tokens SET used_at"));
  assert.deepEqual(tokenUpdate.values, ["token-1"]);

  const refreshRevoke = database.calls.find((call) => call.text.startsWith("UPDATE refresh_tokens SET revoked_at"));
  assert.deepEqual(refreshRevoke.values, ["user-1"]);
});

test("redeemToken: no live token (unknown, expired, used, or revoked -- the query can't tell and doesn't need to) returns null and rolls back with no writes", async () => {
  const database = fakeDatabase([
    [/SELECT id, user_id FROM password_set_tokens/, { rows: [] }],
  ]);
  const repository = createPasswordSetTokenRepository(database);

  const result = await repository.redeemToken("unknown-hash", "argon2-hash");

  assert.equal(result, null);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
  assert.equal(database.calls.some((call) => call.text.startsWith("UPDATE")), false);
});

test("redeemToken: a failure partway through rolls back rather than partially applying", async () => {
  const boom = new Error("connection reset");
  const database = fakeDatabase([
    [/SELECT id, user_id FROM password_set_tokens/, { rows: [{ id: "token-1", user_id: "user-1" }] }],
    ["UPDATE users SET password_hash", { throwError: boom }],
  ]);
  const repository = createPasswordSetTokenRepository(database);

  await assert.rejects(repository.redeemToken("hash-1", "argon2-hash"), /connection reset/);
  assert.equal(database.calls.at(-1).text, "ROLLBACK");
});
