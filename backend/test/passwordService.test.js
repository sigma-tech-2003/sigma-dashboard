import assert from "node:assert/strict";
import test from "node:test";
import { createPasswordService } from "../src/services/passwordService.js";
import { hashPassword, verifyPassword } from "../src/utils/password.js";

// D41: the owner replacing their own password. Fakes for the repository and the auth service; argon2 is real in the
// two tests that need to prove "the old password stops working", and a fast stand-in everywhere else.

const PRINCIPAL = Object.freeze({ userId: "user-1", employeeId: "employee-1", role: "employee", mustChangePassword: true });
const SESSION = Object.freeze({ principal: { userId: "user-1", mustChangePassword: false }, accessToken: "access", refreshToken: "refresh", expiresIn: 900 });

const fastHash = async (plain) => `hashed:${Buffer.from(plain).toString("base64")}`;
const fastVerify = async (stored, plain) => stored === (await fastHash(plain));

function fakes({ storedHash, replaceResult = true } = {}) {
  const calls = { replaceOwnPassword: [], startSession: [], findPasswordHash: [] };
  return {
    calls,
    userRepository: {
      async findPasswordHash(userId) { calls.findPasswordHash.push(userId); return storedHash; },
      async replaceOwnPassword(userId, passwordHash) { calls.replaceOwnPassword.push({ userId, passwordHash }); return replaceResult; },
    },
    authService: { async startSession(userId) { calls.startSession.push(userId); return SESSION; } },
  };
}

const serviceFor = (parts, overrides = {}) => createPasswordService({ ...parts, hash: fastHash, verify: fastVerify, ...overrides });
const rejection = async (promise) => { try { await promise; return null; } catch (error) { return error; } };

test("changes the password: verifies the current one, stores the hash of the new one, and returns a fresh session", async () => {
  const parts = fakes({ storedHash: await fastHash("temp-pass-1234") });

  const result = await serviceFor(parts).changeOwnPassword(PRINCIPAL, { currentPassword: "temp-pass-1234", newPassword: "my-own-secret-9" });

  assert.equal(result, SESSION);
  assert.deepEqual(parts.calls.replaceOwnPassword, [{ userId: "user-1", passwordHash: await fastHash("my-own-secret-9") }]);
  assert.deepEqual(parts.calls.startSession, ["user-1"]);
  assert.equal(JSON.stringify(parts.calls).includes("my-own-secret-9"), false, "the plain new password never reaches a repository");
});

test("a wrong current password is a 403, NOT a 401: the client reads 401 as 'session lost' and would try to refresh", async () => {
  const parts = fakes({ storedHash: await fastHash("temp-pass-1234") });

  const error = await rejection(serviceFor(parts).changeOwnPassword(PRINCIPAL, { currentPassword: "guess", newPassword: "my-own-secret-9" }));

  assert.equal(error.statusCode, 403);
  assert.equal(error.code, "current_password_incorrect");
  assert.deepEqual(parts.calls.replaceOwnPassword, [], "nothing was changed");
  assert.deepEqual(parts.calls.startSession, [], "and no session was started");
});

test("'changing' it to the same password is refused: the creator would still know it (400 password_unchanged)", async () => {
  const parts = fakes({ storedHash: await fastHash("temp-pass-1234") });

  const error = await rejection(serviceFor(parts).changeOwnPassword(PRINCIPAL, { currentPassword: "temp-pass-1234", newPassword: "temp-pass-1234" }));

  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "password_unchanged");
  assert.deepEqual(parts.calls.replaceOwnPassword, []);
});

test("the current password is checked BEFORE 'unchanged', so a wrong guess cannot probe what the password is", async () => {
  const parts = fakes({ storedHash: await fastHash("temp-pass-1234") });

  // The guess equals neither: wrong-current wins. If "unchanged" were checked first, sending the same string twice would
  // reveal whether it was the password without knowing it.
  const error = await rejection(serviceFor(parts).changeOwnPassword(PRINCIPAL, { currentPassword: "guess-one", newPassword: "guess-one" }));

  assert.equal(error.code, "current_password_incorrect");
});

test("an account with no stored password (or none found) cannot change it: 403, not a crash", async () => {
  for (const storedHash of [null, undefined, ""]) {
    const parts = fakes({ storedHash });
    const error = await rejection(serviceFor(parts).changeOwnPassword(PRINCIPAL, { currentPassword: "anything", newPassword: "my-own-secret-9" }));

    assert.equal(error.code, "current_password_incorrect", String(storedHash));
  }
});

test("a user that vanished between the check and the write is a 401, with no session started", async () => {
  const parts = fakes({ storedHash: await fastHash("temp-pass-1234"), replaceResult: false });

  const error = await rejection(serviceFor(parts).changeOwnPassword(PRINCIPAL, { currentPassword: "temp-pass-1234", newPassword: "my-own-secret-9" }));

  assert.equal(error.statusCode, 401);
  assert.deepEqual(parts.calls.startSession, []);
});

test("the session is started only AFTER the password is replaced (the new token must postdate the change)", async () => {
  const order = [];
  const parts = fakes({ storedHash: await fastHash("temp-pass-1234") });
  parts.userRepository.replaceOwnPassword = async () => { order.push("replace"); return true; };
  parts.authService.startSession = async () => { order.push("session"); return SESSION; };

  await serviceFor(parts).changeOwnPassword(PRINCIPAL, { currentPassword: "temp-pass-1234", newPassword: "my-own-secret-9" });

  assert.deepEqual(order, ["replace", "session"]);
});

// ---- with the real argon2, once, to prove the claim the whole design rests on ----

test("with real argon2: after the change the temporary password no longer verifies and the new one does", async () => {
  let stored = await hashPassword("temp-pass-1234");
  const parts = {
    userRepository: {
      async findPasswordHash() { return stored; },
      async replaceOwnPassword(_userId, passwordHash) { stored = passwordHash; return true; },
    },
    authService: { async startSession() { return SESSION; } },
  };
  const service = createPasswordService(parts); // real hash and verify

  await service.changeOwnPassword(PRINCIPAL, { currentPassword: "temp-pass-1234", newPassword: "my-own-secret-9" });

  assert.equal(await verifyPassword(stored, "temp-pass-1234"), false, "the admin-set password stops working the moment it is replaced");
  assert.equal(await verifyPassword(stored, "my-own-secret-9"), true);
  assert.match(stored, /^\$argon2id\$/);
});

test("with real argon2: a second change needs the NEW password as the current one, not the temporary one", async () => {
  let stored = await hashPassword("temp-pass-1234");
  const parts = {
    userRepository: {
      async findPasswordHash() { return stored; },
      async replaceOwnPassword(_userId, passwordHash) { stored = passwordHash; return true; },
    },
    authService: { async startSession() { return SESSION; } },
  };
  const service = createPasswordService(parts);
  await service.changeOwnPassword(PRINCIPAL, { currentPassword: "temp-pass-1234", newPassword: "my-own-secret-9" });

  const error = await rejection(service.changeOwnPassword(PRINCIPAL, { currentPassword: "temp-pass-1234", newPassword: "another-secret-7" }));

  assert.equal(error.code, "current_password_incorrect");
});
