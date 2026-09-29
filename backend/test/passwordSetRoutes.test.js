import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createAuthService } from "../src/services/authService.js";
import { createEmployeeMutationService } from "../src/services/employeeMutationService.js";
import { createPasswordSetService } from "../src/services/passwordSetService.js";

// Full lifecycle, end to end through the real routes and real services
// (employeeMutationService, passwordSetService, authService), backed by realistic in-memory
// fakes -- not canned responses -- so reuse and expiry are genuinely exercised, not asserted
// against a mock that just says what the test wants to hear.

const TEST_AUTH_CONFIG = Object.freeze({
  secret: "test-only-secret-at-least-32-characters-long",
  issuer: "sigma-hrm-api-test",
  audience: "sigma-hrm-web-test",
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 1209600,
});
const PASSWORD_SET_TOKEN_TTL_SECONDS = 60 * 60 * 24;

function principalFor(role, overrides = {}) {
  return {
    userId: randomUUID(), employeeId: randomUUID(), role, departmentId: randomUUID(),
    isTeamLead: role === "tl", ...overrides,
  };
}

function buildFixture() {
  const usersById = new Map();
  const usersByEmail = new Map();
  const employeesById = new Map();
  const passwordTokens = new Map(); // tokenHash -> { id, userId, expiresAt, usedAt, revokedAt }
  const refreshTokens = new Map(); // tokenHash -> { id, userId, revokedAt }
  let nextId = 1;

  function seedInvitedEmployee({ email }) {
    const userId = randomUUID();
    const employeeId = randomUUID();
    const user = { id: userId, email, password_hash: null, role: "employee", status: "invited" };
    usersById.set(userId, user);
    usersByEmail.set(email.toLowerCase(), user);
    employeesById.set(employeeId, { id: employeeId, user_id: userId, role: "employee" });
    return { userId, employeeId };
  }

  const userRepository = {
    async findAuthenticatableByEmail(email) {
      return usersByEmail.get(String(email).toLowerCase()) ?? null;
    },
    async findPrincipalByUserId(userId) {
      const user = usersById.get(userId);
      if (!user || user.status !== "active") return null;
      return Object.freeze({
        userId: user.id, employeeId: "employee-for-" + userId, role: user.role,
        departmentId: "dept-1", isTeamLead: false,
      });
    },
    async touchLastLogin() {},
    async findById(userId) {
      return usersById.get(userId) ?? null;
    },
  };

  const employeeRepository = {
    async findById(employeeId) {
      return employeesById.get(employeeId) ?? null;
    },
  };

  const refreshTokenRepository = {
    calls: { revokeAllForUser: [] },
    async store({ userId, tokenHash, expiresAt }) {
      const id = String(nextId++);
      refreshTokens.set(tokenHash, { id, userId, expiresAt, revokedAt: null });
      return { id, user_id: userId, expires_at: expiresAt };
    },
    async findLiveByHash(tokenHash) {
      const row = refreshTokens.get(tokenHash);
      if (!row || row.revokedAt || row.expiresAt <= new Date()) return null;
      return { id: row.id, user_id: row.userId, expires_at: row.expiresAt };
    },
    async revokeById(id) {
      for (const row of refreshTokens.values()) {
        if (row.id === id && !row.revokedAt) { row.revokedAt = new Date(); return 1; }
      }
      return 0;
    },
    async revokeAllForUser(userId) {
      refreshTokenRepository.calls.revokeAllForUser.push(userId);
      let count = 0;
      for (const row of refreshTokens.values()) {
        if (row.userId === userId && !row.revokedAt) { row.revokedAt = new Date(); count += 1; }
      }
      return count;
    },
  };

  const passwordSetTokenRepository = {
    tokens: passwordTokens, // exposed so a test can reach in and force-expire one
    async issueToken({ userId, tokenHash, expiresAt }) {
      for (const row of passwordTokens.values()) {
        if (row.userId === userId && !row.usedAt && !row.revokedAt) row.revokedAt = new Date();
      }
      const id = String(nextId++);
      passwordTokens.set(tokenHash, { id, userId, expiresAt, usedAt: null, revokedAt: null });
      return { id, user_id: userId, expires_at: expiresAt };
    },
    async redeemToken(tokenHash, passwordHash) {
      const row = passwordTokens.get(tokenHash);
      if (!row || row.usedAt || row.revokedAt || row.expiresAt <= new Date()) return null;
      row.usedAt = new Date();
      const user = usersById.get(row.userId);
      user.password_hash = passwordHash;
      user.status = "active";
      await refreshTokenRepository.revokeAllForUser(row.userId);
      return { userId: row.userId };
    },
  };

  const authService = createAuthService({ authConfig: TEST_AUTH_CONFIG, userRepository, refreshTokenRepository });
  const passwordSetService = createPasswordSetService({
    passwordSetTokenRepository, userRepository, passwordSetTokenTtlSeconds: PASSWORD_SET_TOKEN_TTL_SECONDS,
  });
  const employeeMutationService = createEmployeeMutationService({ employeeRepository, passwordSetService });

  return {
    seedInvitedEmployee, usersById, refreshTokens, passwordTokens,
    authService, passwordSetService, employeeMutationService, refreshTokenRepository,
  };
}

async function startApp(principal, fixture) {
  const app = createApp({
    verifyAccessToken: async () => principal,
    repositories: {},
    authService: fixture.authService,
    employeeMutationService: fixture.employeeMutationService,
    passwordSetService: fixture.passwordSetService,
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    async request(method, pathname, body) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("full lifecycle: issue, redeem, and the new password actually logs in", async () => {
  const fixture = buildFixture();
  const { employeeId } = fixture.seedInvitedEmployee({ email: "new.hire@example.com" });
  const app = await startApp(principalFor("admin"), fixture);
  try {
    const issue = await app.request("POST", `/api/v1/employees/${employeeId}/password-token`);
    assert.equal(issue.status, 201);
    assert.equal(typeof issue.body.data.token, "string");

    const redeem = await app.request("POST", "/api/v1/auth/set-password", {
      token: issue.body.data.token, password: "a-perfectly-fine-password",
    });
    assert.equal(redeem.status, 204);

    const login = await app.request("POST", "/api/v1/auth/login", {
      email: "new.hire@example.com", password: "a-perfectly-fine-password",
    });
    assert.equal(login.status, 200);
    assert.equal(typeof login.body.data.accessToken, "string");
  } finally {
    await app.close();
  }
});

test("reuse: redeeming the same token twice fails the second time with the generic error", async () => {
  const fixture = buildFixture();
  const { employeeId } = fixture.seedInvitedEmployee({ email: "reuse@example.com" });
  const app = await startApp(principalFor("admin"), fixture);
  try {
    const issue = await app.request("POST", `/api/v1/employees/${employeeId}/password-token`);
    const token = issue.body.data.token;

    const first = await app.request("POST", "/api/v1/auth/set-password", { token, password: "first-password-ok" });
    assert.equal(first.status, 204);

    const second = await app.request("POST", "/api/v1/auth/set-password", { token, password: "second-password-ok" });
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, "invalid_token");
  } finally {
    await app.close();
  }
});

test("expiry, reuse, and an unknown token all produce byte-identical error bodies", async () => {
  const fixture = buildFixture();
  const { employeeId } = fixture.seedInvitedEmployee({ email: "expiry@example.com" });
  const app = await startApp(principalFor("admin"), fixture);
  try {
    // Expired: issue, then force the stored expiry into the past.
    const issued = await app.request("POST", `/api/v1/employees/${employeeId}/password-token`);
    for (const row of fixture.passwordTokens.values()) row.expiresAt = new Date(Date.now() - 1000);
    const expired = await app.request("POST", "/api/v1/auth/set-password", {
      token: issued.body.data.token, password: "does-not-matter-1",
    });

    // Reused: a second employee, issue and redeem once, then redeem again.
    const { employeeId: secondEmployeeId } = fixture.seedInvitedEmployee({ email: "reused@example.com" });
    const issuedForReuse = await app.request("POST", `/api/v1/employees/${secondEmployeeId}/password-token`);
    await app.request("POST", "/api/v1/auth/set-password", { token: issuedForReuse.body.data.token, password: "does-not-matter-2" });
    const reused = await app.request("POST", "/api/v1/auth/set-password", {
      token: issuedForReuse.body.data.token, password: "does-not-matter-3",
    });

    // Unknown: never issued at all.
    const unknown = await app.request("POST", "/api/v1/auth/set-password", {
      token: "this-token-was-never-issued-by-anyone", password: "does-not-matter-4",
    });

    for (const response of [expired, reused, unknown]) {
      assert.equal(response.status, 400, JSON.stringify(response));
    }
    // requestId is a legitimate per-request UUID (middleware/requestId.js) and is expected
    // to differ; everything that could actually reveal which reason applied must not.
    for (const [a, b] of [[expired, reused], [reused, unknown]]) {
      assert.equal(a.body.error.code, b.body.error.code);
      assert.equal(a.body.error.message, b.body.error.message);
    }
  } finally {
    await app.close();
  }
});

test("reissuing a token revokes the previous one -- only the newest token works", async () => {
  const fixture = buildFixture();
  const { employeeId } = fixture.seedInvitedEmployee({ email: "reissue@example.com" });
  const app = await startApp(principalFor("admin"), fixture);
  try {
    const first = await app.request("POST", `/api/v1/employees/${employeeId}/password-token`);
    const second = await app.request("POST", `/api/v1/employees/${employeeId}/password-token`);
    assert.notEqual(first.body.data.token, second.body.data.token);

    const redeemFirst = await app.request("POST", "/api/v1/auth/set-password", {
      token: first.body.data.token, password: "should-not-work-12345",
    });
    assert.equal(redeemFirst.status, 400);

    const redeemSecond = await app.request("POST", "/api/v1/auth/set-password", {
      token: second.body.data.token, password: "should-work-fine-12345",
    });
    assert.equal(redeemSecond.status, 204);
  } finally {
    await app.close();
  }
});

test("issuing for a non-invited (already active) account is refused with 409", async () => {
  const fixture = buildFixture();
  const { employeeId } = fixture.seedInvitedEmployee({ email: "already-active@example.com" });
  for (const user of fixture.usersById.values()) user.status = "active";
  const app = await startApp(principalFor("admin"), fixture);
  try {
    const response = await app.request("POST", `/api/v1/employees/${employeeId}/password-token`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "not_invited");
  } finally {
    await app.close();
  }
});

for (const role of ["manager", "tl", "employee"]) {
  test(`issuance is denied for ${role} -- admin/hr only, not "whoever may update this employee"`, async () => {
    const fixture = buildFixture();
    const { employeeId } = fixture.seedInvitedEmployee({ email: `${role}-cannot-issue@example.com` });
    const app = await startApp(principalFor(role), fixture);
    try {
      const response = await app.request("POST", `/api/v1/employees/${employeeId}/password-token`);
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, "role_not_allowed");
    } finally {
      await app.close();
    }
  });
}

test("hr may issue a token -- not just admin", async () => {
  const fixture = buildFixture();
  const { employeeId } = fixture.seedInvitedEmployee({ email: "hr-can-issue@example.com" });
  const app = await startApp(principalFor("hr"), fixture);
  try {
    const response = await app.request("POST", `/api/v1/employees/${employeeId}/password-token`);
    assert.equal(response.status, 201);
  } finally {
    await app.close();
  }
});

test("redeeming revokes every outstanding refresh token for that user", async () => {
  const fixture = buildFixture();
  const { userId, employeeId } = fixture.seedInvitedEmployee({ email: "has-a-session@example.com" });
  // An invited account cannot normally log in to acquire one -- this simulates the
  // defensive edge case the requirement is actually about: a live session existing anyway.
  fixture.refreshTokens.set("preexisting-hash", { id: "rt-1", userId, expiresAt: new Date(Date.now() + 1e9), revokedAt: null });

  const app = await startApp(principalFor("admin"), fixture);
  try {
    const issue = await app.request("POST", `/api/v1/employees/${employeeId}/password-token`);
    await app.request("POST", "/api/v1/auth/set-password", { token: issue.body.data.token, password: "new-password-123" });

    assert.deepEqual(fixture.refreshTokenRepository.calls.revokeAllForUser, [userId]);
    assert.ok(fixture.refreshTokens.get("preexisting-hash").revokedAt, "the preexisting session must be revoked");
  } finally {
    await app.close();
  }
});

test("set-password rejects a malformed body -- missing token, or a too-short password", async () => {
  const fixture = buildFixture();
  const app = await startApp(principalFor("admin"), fixture);
  try {
    const missingToken = await app.request("POST", "/api/v1/auth/set-password", { password: "long-enough-password" });
    assert.equal(missingToken.status, 400);

    const shortPassword = await app.request("POST", "/api/v1/auth/set-password", { token: "some-token", password: "short" });
    assert.equal(shortPassword.status, 400);
  } finally {
    await app.close();
  }
});
