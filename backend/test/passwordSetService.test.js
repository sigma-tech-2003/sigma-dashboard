import assert from "node:assert/strict";
import test from "node:test";
import { createPasswordSetService } from "../src/services/passwordSetService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Fake repository-interface level -- authorization and the generic-error
// guarantee are what this file proves; the SQL/transaction shape is covered in
// passwordSetTokenRepository.test.js, and the full lifecycle end to end (reuse, expiry) in
// passwordSetRoutes.test.js.

function fakeUserRepository(users) {
  return { async findById(id) { return users.get(id) ?? null; } };
}

function fakePasswordSetTokenRepository({ issueResult, redeemResult } = {}) {
  const calls = { issueToken: [], redeemToken: [] };
  return {
    calls,
    async issueToken(args) {
      calls.issueToken.push(args);
      return issueResult ?? { id: "token-1", user_id: args.userId, expires_at: args.expiresAt };
    },
    async redeemToken(tokenHash, passwordHash) {
      calls.redeemToken.push({ tokenHash, passwordHash });
      return redeemResult !== undefined ? redeemResult : { userId: "user-1" };
    },
  };
}

const principalFor = (role) => ({ userId: "principal-id", employeeId: "principal-emp", role });

// ---------------------------------------------------------------------------
// issueTokenForUser
// ---------------------------------------------------------------------------

test("issueTokenForUser: only admin and hr may issue, matching COMPANY_WIDE_ROLES exactly", async () => {
  const users = new Map([["user-1", { id: "user-1", status: "invited" }]]);
  for (const role of USER_ROLES) {
    const passwordSetTokenRepository = fakePasswordSetTokenRepository();
    const service = createPasswordSetService({
      passwordSetTokenRepository, userRepository: fakeUserRepository(users), passwordSetTokenTtlSeconds: 86400,
    });

    const allowed = role === "admin" || role === "hr";
    if (allowed) {
      await service.issueTokenForUser(principalFor(role), "user-1");
      assert.equal(passwordSetTokenRepository.calls.issueToken.length, 1, role);
    } else {
      await assert.rejects(
        service.issueTokenForUser(principalFor(role), "user-1"),
        (error) => { assert.equal(error.statusCode, 403); assert.equal(error.code, "role_not_allowed"); return true; },
        role,
      );
      assert.equal(passwordSetTokenRepository.calls.issueToken.length, 0, role);
    }
  }
});

test("issueTokenForUser: a manager who could update the employee still cannot issue a token -- a deliberately different, narrower gate", async () => {
  const users = new Map([["user-1", { id: "user-1", status: "invited" }]]);
  const passwordSetTokenRepository = fakePasswordSetTokenRepository();
  const service = createPasswordSetService({
    passwordSetTokenRepository, userRepository: fakeUserRepository(users), passwordSetTokenTtlSeconds: 86400,
  });

  await assert.rejects(
    service.issueTokenForUser(principalFor("manager"), "user-1"),
    (error) => { assert.equal(error.code, "role_not_allowed"); return true; },
  );
});

test("issueTokenForUser: 404 for a user that does not exist", async () => {
  const service = createPasswordSetService({
    passwordSetTokenRepository: fakePasswordSetTokenRepository(),
    userRepository: fakeUserRepository(new Map()),
    passwordSetTokenTtlSeconds: 86400,
  });

  await assert.rejects(
    service.issueTokenForUser(principalFor("admin"), "missing-user"),
    (error) => { assert.equal(error.statusCode, 404); return true; },
  );
});

test("issueTokenForUser: 409 for an account that is not invited (already active, suspended, ...)", async () => {
  for (const status of ["active", "suspended", "inactive"]) {
    const users = new Map([["user-1", { id: "user-1", status }]]);
    const passwordSetTokenRepository = fakePasswordSetTokenRepository();
    const service = createPasswordSetService({
      passwordSetTokenRepository, userRepository: fakeUserRepository(users), passwordSetTokenTtlSeconds: 86400,
    });

    await assert.rejects(
      service.issueTokenForUser(principalFor("admin"), "user-1"),
      (error) => { assert.equal(error.statusCode, 409); assert.equal(error.code, "not_invited"); return true; },
      status,
    );
    assert.equal(passwordSetTokenRepository.calls.issueToken.length, 0, status);
  }
});

test("issueTokenForUser: happy path returns the raw token and expiry, computed from the configured TTL", async () => {
  const users = new Map([["user-1", { id: "user-1", status: "invited" }]]);
  const passwordSetTokenRepository = fakePasswordSetTokenRepository();
  const service = createPasswordSetService({
    passwordSetTokenRepository, userRepository: fakeUserRepository(users), passwordSetTokenTtlSeconds: 3600,
  });

  const before = Date.now();
  const result = await service.issueTokenForUser(principalFor("admin"), "user-1");
  const after = Date.now();

  assert.equal(typeof result.token, "string");
  assert.ok(result.token.length >= 32, "the token should be high-entropy, not a short guessable value");
  assert.ok(result.expiresAt.getTime() >= before + 3600 * 1000);
  assert.ok(result.expiresAt.getTime() <= after + 3600 * 1000);

  const issued = passwordSetTokenRepository.calls.issueToken[0];
  assert.equal(issued.userId, "user-1");
  assert.notEqual(issued.tokenHash, result.token, "the repository must only ever see the hash, never the raw token");
});

// ---------------------------------------------------------------------------
// redeemToken
// ---------------------------------------------------------------------------

test("redeemToken: an empty or non-string token is the same generic error, without reaching the repository", async () => {
  const passwordSetTokenRepository = fakePasswordSetTokenRepository();
  const service = createPasswordSetService({
    passwordSetTokenRepository, userRepository: fakeUserRepository(new Map()), passwordSetTokenTtlSeconds: 86400,
  });

  for (const badToken of ["", undefined, null]) {
    await assert.rejects(
      service.redeemToken(badToken, "a-fine-password"),
      (error) => { assert.equal(error.statusCode, 400); assert.equal(error.code, "invalid_token"); return true; },
    );
  }
  assert.equal(passwordSetTokenRepository.calls.redeemToken.length, 0);
});

test("redeemToken: a repository miss (unknown/expired/used/revoked) surfaces the same generic error", async () => {
  const passwordSetTokenRepository = fakePasswordSetTokenRepository({ redeemResult: null });
  const service = createPasswordSetService({
    passwordSetTokenRepository, userRepository: fakeUserRepository(new Map()), passwordSetTokenTtlSeconds: 86400,
  });

  await assert.rejects(
    service.redeemToken("some-token", "a-fine-password"),
    (error) => { assert.equal(error.statusCode, 400); assert.equal(error.code, "invalid_token"); return true; },
  );
});

test("redeemToken: the repository only ever receives a hash of the password, never the plaintext", async () => {
  const passwordSetTokenRepository = fakePasswordSetTokenRepository();
  const service = createPasswordSetService({
    passwordSetTokenRepository, userRepository: fakeUserRepository(new Map()), passwordSetTokenTtlSeconds: 86400,
  });

  await service.redeemToken("some-token", "a-fine-password");

  const call = passwordSetTokenRepository.calls.redeemToken[0];
  assert.notEqual(call.passwordHash, "a-fine-password");
  assert.equal(typeof call.passwordHash, "string");
});
