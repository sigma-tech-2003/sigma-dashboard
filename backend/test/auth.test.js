import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { createAuthService } from "../src/services/authService.js";
import { createTokenService, hashRefreshToken } from "../src/services/tokenService.js";
import { hashPassword, verifyPassword } from "../src/utils/password.js";

const AUTH_CONFIG = Object.freeze({
  secret: "test-secret-that-is-at-least-32-characters-long",
  issuer: "sigma-hrm-api",
  audience: "sigma-hrm-web",
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 1209600,
});

const USER_ID = "11111111-1111-1111-1111-111111111111";

const PRINCIPAL = Object.freeze({
  userId: USER_ID,
  employeeId: "22222222-2222-2222-2222-222222222222",
  role: "manager",
  departmentId: "33333333-3333-3333-3333-333333333333",
  isTeamLead: false,
});

/** Repositories replaced by fakes so these tests need no database. */
function harness({ user, principal = PRINCIPAL } = {}) {
  const state = { principal, refreshTokens: new Map(), lastLoginTouched: 0 };

  const userRepository = {
    async findAuthenticatableByEmail(email) {
      return user && user.email.toLowerCase() === String(email).toLowerCase() ? user : null;
    },
    async findPrincipalByUserId(userId) {
      return userId === USER_ID ? state.principal : null;
    },
    async touchLastLogin() {
      state.lastLoginTouched += 1;
    },
  };

  const refreshTokenRepository = {
    async store({ userId, tokenHash, expiresAt }) {
      const row = { id: `row-${state.refreshTokens.size + 1}`, user_id: userId, tokenHash, expiresAt, revoked: false };
      state.refreshTokens.set(tokenHash, row);
      return row;
    },
    async findLiveByHash(tokenHash) {
      const row = state.refreshTokens.get(tokenHash);
      return row && !row.revoked ? row : null;
    },
    async revokeById(id) {
      for (const row of state.refreshTokens.values()) {
        if (row.id === id && !row.revoked) {
          row.revoked = true;
          return 1;
        }
      }
      return 0;
    },
    async revokeAllForUser(userId) {
      let count = 0;
      for (const row of state.refreshTokens.values()) {
        if (row.user_id === userId && !row.revoked) {
          row.revoked = true;
          count += 1;
        }
      }
      return count;
    },
  };

  return {
    state,
    service: createAuthService({ authConfig: AUTH_CONFIG, userRepository, refreshTokenRepository }),
  };
}

const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code;
  }
};

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

test("passwords are hashed with argon2id and verify correctly", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^\$argon2id\$/, "must be argon2id, not argon2i or bcrypt");
  assert.equal(await verifyPassword(hash, "correct horse battery staple"), true);
  assert.equal(await verifyPassword(hash, "wrong password"), false);
});

test("verification returns false rather than throwing for unusable input", async () => {
  // users.password_hash is NULL for an invited account that has not set a password.
  // That must fail login, not crash the route.
  for (const stored of [null, undefined, "", "not-a-hash"]) {
    assert.equal(await verifyPassword(stored, "anything"), false, `stored=${stored}`);
  }
  const hash = await hashPassword("pw");
  for (const supplied of [null, undefined, ""]) {
    assert.equal(await verifyPassword(hash, supplied), false, `supplied=${supplied}`);
  }
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test("access tokens round-trip and carry only the subject", () => {
  const tokens = createTokenService(AUTH_CONFIG);
  const token = tokens.issueAccessToken(USER_ID);
  assert.equal(tokens.verifyAccessToken(token), USER_ID);

  const claims = jwt.decode(token);
  // Role and department must NOT be in the token: they are resolved per request, so an
  // embedded copy could outlive a role change.
  assert.equal(claims.role, undefined);
  assert.equal(claims.departmentId, undefined);
  assert.equal(claims.iss, AUTH_CONFIG.issuer);
  assert.equal(claims.aud, AUTH_CONFIG.audience);
});

test("tampered, mis-scoped and unsigned tokens are all rejected", () => {
  const tokens = createTokenService(AUTH_CONFIG);
  const valid = tokens.issueAccessToken(USER_ID);

  const rejected = [
    ["garbage", "not-a-token"],
    ["tampered payload", `${valid.split(".")[0]}.${Buffer.from('{"sub":"attacker"}').toString("base64url")}.${valid.split(".")[2]}`],
    ["wrong secret", jwt.sign({}, "another-secret-that-is-32-characters!!", { subject: USER_ID, issuer: AUTH_CONFIG.issuer, audience: AUTH_CONFIG.audience })],
    ["wrong issuer", jwt.sign({}, AUTH_CONFIG.secret, { subject: USER_ID, issuer: "evil", audience: AUTH_CONFIG.audience })],
    ["wrong audience", jwt.sign({}, AUTH_CONFIG.secret, { subject: USER_ID, issuer: AUTH_CONFIG.issuer, audience: "evil" })],
    ["alg none", `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(`{"sub":"${USER_ID}"}`).toString("base64url")}.`],
    ["expired", jwt.sign({}, AUTH_CONFIG.secret, { subject: USER_ID, issuer: AUTH_CONFIG.issuer, audience: AUTH_CONFIG.audience, expiresIn: -10 })],
  ];

  for (const [label, token] of rejected) {
    assert.throws(() => tokens.verifyAccessToken(token), /Authentication is required/, label);
  }
});

test("refresh tokens are high-entropy and stored only as a digest", () => {
  const tokens = createTokenService(AUTH_CONFIG);
  const first = tokens.issueRefreshToken();
  const second = tokens.issueRefreshToken();

  assert.notEqual(first.token, second.token);
  assert.ok(first.token.length >= 40, "expected 256 bits of base64url");
  assert.equal(first.tokenHash, hashRefreshToken(first.token));
  assert.notEqual(first.tokenHash, first.token, "the raw token must not be the stored value");
  assert.ok(first.expiresAt > new Date());
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function activeUser() {
  return {
    id: USER_ID,
    email: "manager@example.com",
    password_hash: await hashPassword("correct-password"),
    role: "manager",
    status: "active",
  };
}

test("login succeeds and returns the resolved principal", async () => {
  const { service, state } = harness({ user: await activeUser() });
  const result = await service.login({ email: "manager@example.com", password: "correct-password" });

  assert.deepEqual(result.principal, PRINCIPAL);
  assert.equal(result.expiresIn, AUTH_CONFIG.accessTokenTtlSeconds);
  assert.ok(result.accessToken && result.refreshToken);
  assert.equal(state.lastLoginTouched, 1);
  // The refresh token is persisted as a digest, never in the clear.
  assert.ok(state.refreshTokens.has(hashRefreshToken(result.refreshToken)));
});

test("login is case-insensitive on email but not on password", async () => {
  const { service } = harness({ user: await activeUser() });
  assert.ok(await service.login({ email: "MANAGER@EXAMPLE.COM", password: "correct-password" }));
  assert.equal(
    await codeOf(service.login({ email: "manager@example.com", password: "Correct-Password" })),
    "unauthenticated",
  );
});

test("wrong password, unknown email and missing credentials are indistinguishable", async () => {
  const { service } = harness({ user: await activeUser() });
  for (const credentials of [
    { email: "manager@example.com", password: "wrong" },
    { email: "nobody@example.com", password: "correct-password" },
    { email: undefined, password: undefined },
    {},
  ]) {
    assert.equal(await codeOf(service.login(credentials)), "unauthenticated", JSON.stringify(credentials));
  }
});

test("a non-active account cannot log in even with the right password", async () => {
  for (const status of ["invited", "inactive", "suspended"]) {
    const user = { ...(await activeUser()), status };
    const { service } = harness({ user });
    assert.equal(
      await codeOf(service.login({ email: user.email, password: "correct-password" })),
      "unauthenticated",
      status,
    );
  }
});

test("login is refused when the principal cannot be resolved", async () => {
  // The user row is active but the employee row is gone or soft-deleted, so the join in
  // findPrincipalByUserId returns nothing.
  const { service } = harness({ user: await activeUser(), principal: null });
  assert.equal(
    await codeOf(service.login({ email: "manager@example.com", password: "correct-password" })),
    "unauthenticated",
  );
});

// ---------------------------------------------------------------------------
// Decision D10: deactivation ends the session immediately
// ---------------------------------------------------------------------------

test("a still-valid token stops working the moment the account is deactivated", async () => {
  const { service, state } = harness({ user: await activeUser() });
  const { accessToken } = await service.login({
    email: "manager@example.com",
    password: "correct-password",
  });

  // The token itself is unexpired and correctly signed.
  assert.deepEqual(await service.verifyAccessToken(accessToken), PRINCIPAL);

  // Deactivation: the principal query stops returning a row.
  state.principal = null;

  // Same token, same signature, now rejected -- without waiting for expiry. This is the
  // whole reason the principal is resolved per request rather than embedded in the token.
  assert.equal(await codeOf(service.verifyAccessToken(accessToken)), "unauthenticated");
});

test("a role change takes effect on the next request, not at token expiry", async () => {
  const { service, state } = harness({ user: await activeUser() });
  const { accessToken } = await service.login({
    email: "manager@example.com",
    password: "correct-password",
  });

  assert.equal((await service.verifyAccessToken(accessToken)).role, "manager");
  state.principal = { ...PRINCIPAL, role: "employee" };
  assert.equal((await service.verifyAccessToken(accessToken)).role, "employee");
});

// ---------------------------------------------------------------------------
// Refresh and logout
// ---------------------------------------------------------------------------

test("refresh rotates the token and revokes the presented one", async () => {
  const { service } = harness({ user: await activeUser() });
  const first = await service.login({ email: "manager@example.com", password: "correct-password" });

  const second = await service.refresh({ refreshToken: first.refreshToken });
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.deepEqual(second.principal, PRINCIPAL);

  // Replaying the old token fails: a stolen refresh token is usable at most once.
  assert.equal(await codeOf(service.refresh({ refreshToken: first.refreshToken })), "unauthenticated");
  // The new one still works.
  assert.ok(await service.refresh({ refreshToken: second.refreshToken }));
});

test("refresh is refused for a deactivated account", async () => {
  const { service, state } = harness({ user: await activeUser() });
  const { refreshToken } = await service.login({
    email: "manager@example.com",
    password: "correct-password",
  });

  state.principal = null;
  assert.equal(await codeOf(service.refresh({ refreshToken })), "unauthenticated");
});

test("refresh rejects unknown and malformed tokens", async () => {
  const { service } = harness({ user: await activeUser() });
  for (const refreshToken of [undefined, null, "", "never-issued"]) {
    assert.equal(await codeOf(service.refresh({ refreshToken })), "unauthenticated", String(refreshToken));
  }
});

test("logout revokes the presented token, logoutEverywhere revokes all of them", async () => {
  const { service } = harness({ user: await activeUser() });
  const first = await service.login({ email: "manager@example.com", password: "correct-password" });
  const second = await service.login({ email: "manager@example.com", password: "correct-password" });

  assert.equal(await service.logout({ refreshToken: first.refreshToken }), 1);
  assert.equal(await codeOf(service.refresh({ refreshToken: first.refreshToken })), "unauthenticated");
  // The other session is untouched.
  assert.ok(await service.refresh({ refreshToken: second.refreshToken }));

  assert.ok(await service.logoutEverywhere(USER_ID) >= 1);
});

test("logging out an unknown token is a no-op rather than an error", async () => {
  const { service } = harness({ user: await activeUser() });
  assert.equal(await service.logout({ refreshToken: "never-issued" }), 0);
  assert.equal(await service.logout({}), 0);
});
