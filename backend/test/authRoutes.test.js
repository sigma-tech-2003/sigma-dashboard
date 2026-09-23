import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createAuthService } from "../src/services/authService.js";
import { hashPassword } from "../src/utils/password.js";

// Built around a REAL authService (Phase 1's actual code), backed by fake userRepository/
// refreshTokenRepository -- a fully-fake authService.login would only prove whatever this
// file hardcodes, not that the real generic-error/rotation/revocation behavior holds.

const TEST_AUTH_CONFIG = Object.freeze({
  secret: "test-only-secret-at-least-32-characters-long",
  issuer: "sigma-hrm-api-test",
  audience: "sigma-hrm-web-test",
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 1209600,
});

function createFakeUserRepository({ users, principals }) {
  return {
    async findAuthenticatableByEmail(email) {
      return users.get(String(email).toLowerCase()) ?? null;
    },
    async findPrincipalByUserId(userId) {
      return principals.get(userId) ?? null;
    },
    async touchLastLogin() {},
  };
}

/** In-memory mirror of refresh_tokens: store/findLiveByHash/revokeById/revokeAllForUser. */
function createFakeRefreshTokenRepository() {
  const rows = new Map(); // tokenHash -> { id, userId, tokenHash, expiresAt, revokedAt }
  let nextId = 1;
  return {
    async store({ userId, tokenHash, expiresAt }) {
      const id = String(nextId++);
      rows.set(tokenHash, { id, userId, tokenHash, expiresAt, revokedAt: null });
      return { id, user_id: userId, expires_at: expiresAt };
    },
    async findLiveByHash(tokenHash) {
      const row = rows.get(tokenHash);
      if (!row || row.revokedAt || row.expiresAt <= new Date()) return null;
      return { id: row.id, user_id: row.userId, expires_at: row.expiresAt };
    },
    async revokeById(id) {
      for (const row of rows.values()) {
        if (row.id === id && !row.revokedAt) {
          row.revokedAt = new Date();
          return 1;
        }
      }
      return 0;
    },
    async revokeAllForUser(userId) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.userId === userId && !row.revokedAt) {
          row.revokedAt = new Date();
          count += 1;
        }
      }
      return count;
    },
  };
}

async function buildFixture() {
  const password = "correct horse battery staple";
  const passwordHash = await hashPassword(password);

  const users = new Map();
  const principals = new Map();

  users.set("active@example.com", {
    id: "user-active",
    email: "active@example.com",
    password_hash: passwordHash,
    role: "employee",
    status: "active",
  });
  principals.set("user-active", Object.freeze({
    userId: "user-active",
    employeeId: "employee-active",
    role: "employee",
    departmentId: "dept-1",
    isTeamLead: false,
  }));

  // Deactivated: present in users, but deliberately given NO principal entry. authService's
  // own status check must reject before resolvePrincipal is ever reached -- if it weren't,
  // this account would 500 (principal not found) instead of the expected generic 401.
  users.set("inactive@example.com", {
    id: "user-inactive",
    email: "inactive@example.com",
    password_hash: passwordHash,
    role: "employee",
    status: "inactive",
  });

  const userRepository = createFakeUserRepository({ users, principals });
  const refreshTokenRepository = createFakeRefreshTokenRepository();
  const authService = createAuthService({ authConfig: TEST_AUTH_CONFIG, userRepository, refreshTokenRepository });

  return { authService, password };
}

function extractRefreshCookie(response) {
  const setCookieHeaders = response.headers.getSetCookie();
  const refreshCookieHeader = setCookieHeaders.find((header) => header.startsWith("refresh_token="));
  if (!refreshCookieHeader) return null;
  const [nameValue, ...attributes] = refreshCookieHeader.split(";").map((part) => part.trim());
  const value = nameValue.slice("refresh_token=".length);
  return { value, attributes, raw: refreshCookieHeader };
}

async function startApp(authService) {
  const app = createApp({
    authService,
    repositories: {}, // never reached by these tests -- auth routes sit before the seven domains
    verifyAccessToken: async () => { throw new Error("not used by auth route tests"); },
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    async post(pathname, { body, cookie } = {}) {
      const headers = { "content-type": "application/json" };
      if (cookie) headers.cookie = `refresh_token=${cookie}`;
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
        refreshCookie: extractRefreshCookie(response),
      };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("a successful login returns an access token and delivers the refresh token only as an httpOnly cookie", async () => {
  const { authService, password } = await buildFixture();
  const app = await startApp(authService);
  try {
    const response = await app.post("/api/v1/auth/login", { body: { email: "active@example.com", password } });

    assert.equal(response.status, 200);
    assert.equal(typeof response.body.data.accessToken, "string");
    assert.equal(response.body.data.principal.userId, "user-active");
    assert.equal("refreshToken" in response.body.data, false, "the refresh token must never appear in the response body");

    assert.ok(response.refreshCookie, "the refresh token must be set as a cookie");
    assert.match(response.refreshCookie.raw, /HttpOnly/i);
    assert.match(response.refreshCookie.raw, /SameSite=Strict/i);
    assert.match(response.refreshCookie.raw, /Path=\/api\/v1\/auth/i);
  } finally {
    await app.close();
  }
});

test("a wrong password and an unknown email produce an identical response", async () => {
  const { authService, password } = await buildFixture();
  const app = await startApp(authService);
  try {
    const wrongPassword = await app.post("/api/v1/auth/login", {
      body: { email: "active@example.com", password: "not the password" },
    });
    const unknownEmail = await app.post("/api/v1/auth/login", {
      body: { email: "nobody@example.com", password },
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    // requestId is a legitimate per-request UUID (middleware/requestId.js) and is expected to
    // differ; everything that could actually reveal which credential failed must not.
    assert.deepEqual(wrongPassword.body.error.code, unknownEmail.body.error.code, "must never reveal which of the two failed");
    assert.deepEqual(wrongPassword.body.error.message, unknownEmail.body.error.message, "must never reveal which of the two failed");
    assert.equal(wrongPassword.refreshCookie, null);
    assert.equal(unknownEmail.refreshCookie, null);
  } finally {
    await app.close();
  }
});

test("a deactivated account gets the same generic error as a wrong password, not a distinct message", async () => {
  const { authService, password } = await buildFixture();
  const app = await startApp(authService);
  try {
    const deactivated = await app.post("/api/v1/auth/login", { body: { email: "inactive@example.com", password } });
    const wrongPassword = await app.post("/api/v1/auth/login", {
      body: { email: "active@example.com", password: "not the password" },
    });

    assert.equal(deactivated.status, 401);
    assert.deepEqual(deactivated.body.error.code, wrongPassword.body.error.code);
    assert.deepEqual(deactivated.body.error.message, wrongPassword.body.error.message);
    assert.equal(deactivated.refreshCookie, null);
  } finally {
    await app.close();
  }
});

test("refresh with a valid cookie issues a new access token and rotates the refresh cookie", async () => {
  const { authService, password } = await buildFixture();
  const app = await startApp(authService);
  try {
    const login = await app.post("/api/v1/auth/login", { body: { email: "active@example.com", password } });
    const refresh = await app.post("/api/v1/auth/refresh", { cookie: login.refreshCookie.value });

    assert.equal(refresh.status, 200);
    assert.equal(typeof refresh.body.data.accessToken, "string");
    assert.equal(refresh.body.data.principal.userId, "user-active");
    assert.ok(refresh.refreshCookie, "refresh must also set a new refresh cookie");
    assert.notEqual(refresh.refreshCookie.value, login.refreshCookie.value, "refresh rotates the token, it does not reissue the same one");
  } finally {
    await app.close();
  }
});

test("reusing an already-rotated (stale) refresh token is rejected", async () => {
  const { authService, password } = await buildFixture();
  const app = await startApp(authService);
  try {
    const login = await app.post("/api/v1/auth/login", { body: { email: "active@example.com", password } });
    await app.post("/api/v1/auth/refresh", { cookie: login.refreshCookie.value }); // consumes/rotates it
    const reuse = await app.post("/api/v1/auth/refresh", { cookie: login.refreshCookie.value }); // the now-stale token

    assert.equal(reuse.status, 401);
  } finally {
    await app.close();
  }
});

test("logout revokes the refresh token, and a refresh attempt after logout is rejected", async () => {
  const { authService, password } = await buildFixture();
  const app = await startApp(authService);
  try {
    const login = await app.post("/api/v1/auth/login", { body: { email: "active@example.com", password } });

    const logout = await app.post("/api/v1/auth/logout", { cookie: login.refreshCookie.value });
    assert.equal(logout.status, 204);

    const refreshAfterLogout = await app.post("/api/v1/auth/refresh", { cookie: login.refreshCookie.value });
    assert.equal(refreshAfterLogout.status, 401);
  } finally {
    await app.close();
  }
});
