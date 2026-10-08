import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createUserRepository } from "../src/repositories/userRepository.js";
import { createAuthService } from "../src/services/authService.js";
import { hashPassword } from "../src/utils/password.js";
import { USER_ROLES } from "../src/utils/roles.js";

// D37: the login page keeps its mandatory role picker, and checks the pick CLIENT-side by comparing the
// role the user picked with `principal.role` in the login response. That only works if login (and
// refresh) already return the stored role for every one of the five roles -- so no backend change is
// needed. authRoutes.test.js asserts only `principal.userId`; this file pins `principal.role`.
//
// The role is NOT a security control (D37). It is only here to be compared with a UI choice.

// The values the login page offers, copied from src/pages/login-page/LoginPage.jsx (LOGIN_ROLES). They are
// restated here because that file is JSX in the frontend and cannot be imported by a backend test.
const PICKER_VALUES = ["admin", "hr", "manager", "tl", "employee"];

const TEST_AUTH_CONFIG = Object.freeze({
  secret: "test-only-secret-at-least-32-characters-long",
  issuer: "sigma-hrm-api-test",
  audience: "sigma-hrm-web-test",
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 1209600,
});

function fakeRefreshTokenRepository() {
  const rows = new Map();
  let nextId = 1;
  return {
    async store({ userId, tokenHash, expiresAt }) {
      const id = String(nextId++);
      rows.set(tokenHash, { id, userId, expiresAt, revokedAt: null });
      return { id };
    },
    async findLiveByHash(tokenHash) {
      const row = rows.get(tokenHash);
      if (!row || row.revokedAt || row.expiresAt <= new Date()) return null;
      return { id: row.id, user_id: row.userId, expires_at: row.expiresAt };
    },
    async revokeById(id) {
      for (const row of rows.values()) if (row.id === id) row.revokedAt = new Date();
      return 1;
    },
    async revokeAllForUser() { return 0; },
  };
}

async function fixture() {
  const password = "correct horse battery staple";
  const passwordHash = await hashPassword(password);
  const users = new Map();
  const principals = new Map();

  for (const role of PICKER_VALUES) {
    users.set(`${role}@example.com`, { id: `user-${role}`, email: `${role}@example.com`, password_hash: passwordHash, role, status: "active" });
    principals.set(`user-${role}`, Object.freeze({
      userId: `user-${role}`, employeeId: `employee-${role}`, role, departmentId: role === "admin" || role === "hr" ? null : "dept-1",
    }));
  }

  const userRepository = {
    async findAuthenticatableByEmail(email) { return users.get(String(email).toLowerCase()) ?? null; },
    async findPrincipalByUserId(userId) { return principals.get(userId) ?? null; },
    async touchLastLogin() {},
  };
  const authService = createAuthService({
    authConfig: TEST_AUTH_CONFIG, userRepository, refreshTokenRepository: fakeRefreshTokenRepository(),
  });
  return { authService, password };
}

async function withApp(authService, fn) {
  const app = createApp({ authService, repositories: {}, verifyAccessToken: async () => { throw new Error("not used"); } });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(async (pathname, { body, cookie } = {}) => {
      const headers = { "content-type": "application/json" };
      if (cookie) headers.cookie = `refresh_token=${cookie}`;
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const refresh = response.headers.getSetCookie().find((header) => header.startsWith("refresh_token="));
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
        refreshToken: refresh ? refresh.split(";")[0].slice("refresh_token=".length) : null,
      };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the five values the login page offers are exactly the five roles the backend has", () => {
  assert.deepEqual([...PICKER_VALUES].sort(), [...USER_ROLES].sort());
});

test("D37: POST /auth/login returns principal.role for every one of the five roles, equal to the account's stored role", async () => {
  const { authService, password } = await fixture();
  await withApp(authService, async (post) => {
    for (const role of PICKER_VALUES) {
      const response = await post("/api/v1/auth/login", { body: { email: `${role}@example.com`, password } });

      assert.equal(response.status, 200, role);
      assert.equal(response.body.data.principal.role, role, `login must report the stored role for ${role}`);
      assert.ok(PICKER_VALUES.includes(response.body.data.principal.role), `${role}: the role is one the picker can offer`);
    }
  });
});

test("D37: POST /auth/refresh returns principal.role too, so a restored session can be compared the same way", async () => {
  const { authService, password } = await fixture();
  await withApp(authService, async (post) => {
    for (const role of PICKER_VALUES) {
      const login = await post("/api/v1/auth/login", { body: { email: `${role}@example.com`, password } });
      const refreshed = await post("/api/v1/auth/refresh", { cookie: login.refreshToken });

      assert.equal(refreshed.status, 200, role);
      assert.equal(refreshed.body.data.principal.role, role, `refresh must report the stored role for ${role}`);
    }
  });
});

test("D37: a client-side comparison of picked role to principal.role accepts a match and rejects every mismatch", async () => {
  // This is the check the login page will make. It is a UI guard, not authorization: the server has
  // already authenticated the user whatever was picked (D37).
  const { authService, password } = await fixture();
  await withApp(authService, async (post) => {
    for (const actual of PICKER_VALUES) {
      const { body } = await post("/api/v1/auth/login", { body: { email: `${actual}@example.com`, password } });
      for (const picked of PICKER_VALUES) {
        assert.equal(body.data.principal.role === picked, picked === actual, `picked ${picked}, account is ${actual}`);
      }
    }
  });
});

test("D37: the login response gains nothing for this -- the principal keeps its four fields and the body no more than before", async () => {
  const { authService, password } = await fixture();
  await withApp(authService, async (post) => {
    const { body } = await post("/api/v1/auth/login", { body: { email: "employee@example.com", password } });

    assert.deepEqual(Object.keys(body.data.principal).sort(), ["departmentId", "employeeId", "role", "userId"]);
    assert.deepEqual(Object.keys(body.data).sort(), ["accessToken", "expiresIn", "principal"]);
  });
});

test("the role in the principal comes from users.role in the database, joined to a live employee", async () => {
  // The claim "no backend change is needed" rests on this query selecting the role. Pinned so that
  // dropping the column from it would fail here rather than silently break the picker check.
  const calls = [];
  const database = {
    async query(text, values) {
      calls.push({ text: text.replace(/\s+/g, " ").trim(), values });
      return { rows: [{ user_id: "u1", employee_id: "e1", role: "manager", department_id: "d1" }] };
    },
  };

  const principal = await createUserRepository(database).findPrincipalByUserId("u1");

  assert.match(calls[0].text, /u\.role\s+AS role/);
  assert.match(calls[0].text, /u\.status = 'active'/);
  assert.match(calls[0].text, /e\.employment_status = 'active'/);
  assert.equal(principal.role, "manager");
});
