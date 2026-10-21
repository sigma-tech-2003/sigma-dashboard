import assert from "node:assert/strict";
import test from "node:test";
import { createUserRepository } from "../src/repositories/userRepository.js";

// No database. D41: the principal carries mustChangePassword, a token issued before the password last changed is
// refused, and the two password writes are each ONE transaction that also revokes refresh tokens. Where the SQL's
// behaviour (as opposed to its text) matters, scripts/e2e-frontend-prereqs.js runs it against a real PostgreSQL.

function fakeDatabase(handlers = []) {
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
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ text: "RELEASE" }); },
  };
  // findPrincipalByUserId uses the pool directly; the two writes use a checked-out client.
  return { calls, query: client.query, connect: async () => client };
}

const PRINCIPAL_ROW = Object.freeze({
  user_id: "user-1", employee_id: "employee-1", role: "employee", department_id: "dept-1", must_change_password: false,
});

// ---------------------------------------------------------------------------
// findPrincipalByUserId
// ---------------------------------------------------------------------------

test("a password write activates a leftover 'invited' account and changes no other status (D41)", async () => {
  // Accounts created under the token flow (D25/D34) may still be 'invited' with no password; with that flow gone a
  // reset is their only way in. 'inactive' and 'suspended' must NOT be reactivated by a password write.
  const database = fakeDatabase([[/^UPDATE users/, { rowCount: 1 }]]);

  await createUserRepository(database).setTemporaryPassword("user-1", "hash", "employee-9");

  const update = database.calls.find((call) => /^UPDATE users/.test(call.text)).text;
  assert.match(update, /status = CASE WHEN status = 'invited' THEN 'active'::account_status ELSE status END/);
  assert.doesNotMatch(update, /status = 'active'(?!::)/, "never an unconditional activation");
});

test("the principal carries mustChangePassword, true only for a row that says true", async () => {
  for (const [stored, expected] of [[true, true], [false, false], [null, false], [undefined, false], ["true", false]]) {
    const database = fakeDatabase([["FROM users u", { rows: [{ ...PRINCIPAL_ROW, must_change_password: stored }] }]]);

    const principal = await createUserRepository(database).findPrincipalByUserId("user-1");

    assert.equal(principal.mustChangePassword, expected, String(stored));
  }
});

test("the principal selects the flag from users and keeps every existing key", async () => {
  const database = fakeDatabase([["FROM users u", { rows: [PRINCIPAL_ROW] }]]);

  const principal = await createUserRepository(database).findPrincipalByUserId("user-1");

  assert.match(database.calls[0].text, /u\.must_change_password\s+AS must_change_password/);
  assert.deepEqual(Object.keys(principal).sort(), ["departmentId", "employeeId", "isTeamLead", "mustChangePassword", "role", "userId"]);
});

test("the issue time goes to the query as a parameter, and the check is against password_updated_at in whole seconds", async () => {
  const database = fakeDatabase([["FROM users u", { rows: [PRINCIPAL_ROW] }]]);

  await createUserRepository(database).findPrincipalByUserId("user-1", 1760000000);

  assert.deepEqual(database.calls[0].values, ["user-1", 1760000000]);
  assert.match(database.calls[0].text, /\$2::bigint IS NULL/, "no issue time (login, refresh): nothing to compare");
  assert.match(database.calls[0].text, /u\.password_updated_at IS NULL/, "an account whose password never changed is never refused");
  assert.match(database.calls[0].text, /floor\(extract\(epoch FROM u\.password_updated_at\)\) <= \$2::bigint/,
    "whole seconds and <=, so the token the change itself hands back (same second) stays valid");
});

test("with no issue time the lookup passes null, not undefined", async () => {
  const database = fakeDatabase([["FROM users u", { rows: [PRINCIPAL_ROW] }]]);

  await createUserRepository(database).findPrincipalByUserId("user-1");

  assert.deepEqual(database.calls[0].values, ["user-1", null]);
});

test("the active-account assertions (D10) are all still there", async () => {
  const database = fakeDatabase([["FROM users u", { rows: [PRINCIPAL_ROW] }]]);

  await createUserRepository(database).findPrincipalByUserId("user-1");

  for (const clause of [/u\.status = 'active'/, /u\.deleted_at IS NULL/, /e\.deleted_at IS NULL/, /e\.employment_status = 'active'/]) {
    assert.match(database.calls[0].text, clause);
  }
});

test("a row the query does not return (stale token, inactive account) is a null principal", async () => {
  const database = fakeDatabase([["FROM users u", { rows: [] }]]);

  assert.equal(await createUserRepository(database).findPrincipalByUserId("user-1", 1), null);
});

// ---------------------------------------------------------------------------
// findPasswordHash
// ---------------------------------------------------------------------------

test("findPasswordHash returns the stored hash, or null when there is none", async () => {
  const withHash = fakeDatabase([["SELECT password_hash", { rows: [{ password_hash: "argon2-hash" }] }]]);
  const without = fakeDatabase([["SELECT password_hash", { rows: [] }]]);

  assert.equal(await createUserRepository(withHash).findPasswordHash("user-1"), "argon2-hash");
  assert.equal(await createUserRepository(without).findPasswordHash("user-1"), null);
  assert.deepEqual(withHash.calls[0].values, ["user-1"]);
  assert.match(withHash.calls[0].text, /deleted_at IS NULL/);
});

// ---------------------------------------------------------------------------
// replaceOwnPassword / setTemporaryPassword
// ---------------------------------------------------------------------------

const updated = { rowCount: 1 };

test("replaceOwnPassword: one transaction -- clears the flag, stamps password_updated_at, revokes every refresh token", async () => {
  const database = fakeDatabase([["UPDATE users", updated], ["UPDATE refresh_tokens", { rowCount: 3 }]]);

  assert.equal(await createUserRepository(database).replaceOwnPassword("user-1", "new-hash"), true);

  const texts = database.calls.map((call) => call.text);
  assert.equal(texts[0], "BEGIN");
  assert.equal(texts.at(-2), "COMMIT");
  assert.equal(texts.at(-1), "RELEASE");
  const userUpdate = database.calls.find((call) => call.text.startsWith("UPDATE users"));
  assert.deepEqual(userUpdate.values, ["user-1", "new-hash", false, null]);
  assert.match(userUpdate.text, /must_change_password = \$3/);
  assert.match(userUpdate.text, /password_updated_at = now\(\)/);
  const revoke = database.calls.find((call) => call.text.startsWith("UPDATE refresh_tokens"));
  assert.match(revoke.text, /SET revoked_at = now\(\)/);
  assert.match(revoke.text, /user_id = \$1 AND revoked_at IS NULL/);
  assert.deepEqual(revoke.values, ["user-1"]);
});

test("replaceOwnPassword leaves password_set_by_employee_id alone: it is the record of who knew the temporary one", async () => {
  const database = fakeDatabase([["UPDATE users", updated]]);

  await createUserRepository(database).replaceOwnPassword("user-1", "new-hash");

  const userUpdate = database.calls.find((call) => call.text.startsWith("UPDATE users"));
  assert.match(userUpdate.text, /password_set_by_employee_id = CASE WHEN \$3 THEN \$4::uuid ELSE password_set_by_employee_id END/);
  assert.equal(userUpdate.values[2], false, "the flag is false, so the CASE keeps the column as it was");
});

test("setTemporaryPassword: sets the flag, records WHO set it, and revokes the target's refresh tokens", async () => {
  const database = fakeDatabase([["UPDATE users", updated], ["UPDATE refresh_tokens", { rowCount: 1 }]]);

  assert.equal(await createUserRepository(database).setTemporaryPassword("user-9", "temp-hash", "admin-employee-1"), true);

  const userUpdate = database.calls.find((call) => call.text.startsWith("UPDATE users"));
  assert.deepEqual(userUpdate.values, ["user-9", "temp-hash", true, "admin-employee-1"]);
  assert.equal(database.calls.some((call) => call.text.startsWith("UPDATE refresh_tokens")), true);
  assert.equal(database.calls.at(-2).text, "COMMIT");
});

test("a user that does not exist is false, rolled back, and revokes nothing", async () => {
  for (const write of ["replaceOwnPassword", "setTemporaryPassword"]) {
    const database = fakeDatabase([["UPDATE users", { rowCount: 0 }]]);
    const repository = createUserRepository(database);

    assert.equal(await repository[write]("missing", "hash", "someone"), false, write);

    const texts = database.calls.map((call) => call.text);
    assert.ok(texts.includes("ROLLBACK"), write);
    assert.equal(texts.includes("COMMIT"), false, write);
    assert.equal(texts.some((text) => text.startsWith("UPDATE refresh_tokens")), false, write);
    assert.equal(texts.at(-1), "RELEASE", write);
  }
});

test("a failure part-way rolls the whole thing back and releases the client, so no half-change survives", async () => {
  const database = fakeDatabase([["UPDATE users", updated], ["UPDATE refresh_tokens", { throwError: new Error("connection lost") }]]);

  await assert.rejects(createUserRepository(database).replaceOwnPassword("user-1", "new-hash"), /connection lost/);

  const texts = database.calls.map((call) => call.text);
  assert.ok(texts.includes("ROLLBACK"));
  assert.equal(texts.includes("COMMIT"), false);
  assert.equal(texts.at(-1), "RELEASE");
});

test("the password is only ever a bound parameter, never text in the SQL", async () => {
  const database = fakeDatabase([["UPDATE users", updated]]);

  await createUserRepository(database).setTemporaryPassword("user-1", "distinctive-hash-value", "admin-1");

  for (const call of database.calls) assert.equal(call.text.includes("distinctive-hash-value"), false);
});
