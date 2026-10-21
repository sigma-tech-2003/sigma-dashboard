import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { HttpError } from "../src/utils/httpError.js";

// HTTP-level, with the REAL authentication middleware (the gate lives there) and a fake principal resolver. D41: while
// an account is on a temporary password the API refuses everything except GET /auth/me and POST /auth/change-password,
// and change-password answers like login does.

const EMPLOYEE_ID = "22222222-2222-4222-8222-222222222222";
const principal = (overrides = {}) => ({
  userId: "11111111-1111-4111-8111-111111111111", employeeId: EMPLOYEE_ID, role: "employee",
  departmentId: "33333333-3333-4333-8333-333333333333", isTeamLead: false, mustChangePassword: false, ...overrides,
});
const FLAGGED = () => principal({ mustChangePassword: true });

const SESSION = Object.freeze({
  principal: { userId: "11111111-1111-4111-8111-111111111111", employeeId: EMPLOYEE_ID, role: "employee", mustChangePassword: false },
  accessToken: "new-access-token", refreshToken: "new-refresh-token", expiresIn: 900,
});

function fakeRepositories() {
  const calls = [];
  const spy = (name) => ({
    async listForPrincipal() { calls.push(`${name}.list`); return []; },
    async findByIdForPrincipal() { calls.push(`${name}.find`); return null; },
  });
  return { calls, repositories: { employeeRepository: spy("employees"), payrollRepository: spy("payroll"), leaveRepository: spy("leaves") } };
}

async function withApp(resolvePrincipal, fn, { passwordService, bearer = true } = {}) {
  const { calls, repositories } = fakeRepositories();
  const passwordCalls = [];
  const app = createApp({
    verifyAccessToken: async (token) => {
      if (token === "reject") throw new HttpError(401, "unauthenticated", "Authentication is required.");
      return resolvePrincipal();
    },
    repositories,
    authService: { tokens: { refreshTokenTtlSeconds: 1209600 } },
    profileService: { async getOwnProfile(p) { calls.push("profile"); return { id: p.employeeId }; } },
    passwordService: passwordService ?? {
      async changeOwnPassword(p, body) { passwordCalls.push({ principal: p, body }); return SESSION; },
    },
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const request = async (method, pathname, { body, token = "ok" } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { ...(bearer && token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  try {
    return await fn(request, { calls, passwordCalls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const ID = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("while on a temporary password, EVERY other route is refused with 403 password_change_required, and nothing is read or written", async () => {
  await withApp(FLAGGED, async (request, { calls }) => {
    const attempts = [
      ["GET", "/api/v1/employees"], ["GET", `/api/v1/employees/${ID}`], ["GET", "/api/v1/payroll"], ["GET", "/api/v1/leaves"],
      ["GET", "/api/v1/projects"], ["GET", "/api/v1/kpis"], ["GET", "/api/v1/attendance"], ["GET", "/api/v1/departments"],
      ["GET", "/api/v1/leave-balances"],
      ["POST", "/api/v1/employees"], ["PATCH", `/api/v1/employees/${ID}`], ["DELETE", `/api/v1/employees/${ID}`],
      ["POST", `/api/v1/employees/${ID}/temporary-password`], ["POST", "/api/v1/leaves"], ["POST", "/api/v1/payroll"],
      ["POST", "/api/v1/departments"], ["GET", "/api/v1/no-such-route"],
    ];
    for (const [method, path] of attempts) {
      const response = await request(method, path, { body: method === "GET" ? undefined : {} });

      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.body.error.code, "password_change_required", `${method} ${path}`);
    }
    assert.deepEqual(calls, [], "no repository was ever reached");
  });
});

test("the two allowed routes are the ONLY ones: GET /auth/me and POST /auth/change-password", async () => {
  await withApp(FLAGGED, async (request, { calls, passwordCalls }) => {
    assert.equal((await request("GET", "/api/v1/auth/me")).status, 200);
    assert.deepEqual(calls, ["profile"]);

    const changed = await request("POST", "/api/v1/auth/change-password", { body: { current_password: "temp-pass-1234", new_password: "my-own-secret-9" } });
    assert.equal(changed.status, 200);
    assert.equal(passwordCalls.length, 1);
  });
});

test("the gate matches method AND path exactly: the wrong verb on an allowed path is still refused", async () => {
  await withApp(FLAGGED, async (request) => {
    for (const [method, path] of [
      ["POST", "/api/v1/auth/me"], ["PATCH", "/api/v1/auth/me"], ["DELETE", "/api/v1/auth/me"],
      ["GET", "/api/v1/auth/change-password"], ["PUT", "/api/v1/auth/change-password"],
      ["GET", "/api/v1/auth/me/extra"], ["POST", "/api/v1/auth/change-password/extra"], ["GET", "/api/v1/auth/mex"],
      ["GET", "/api/v1/auth/ME"],
    ]) {
      const response = await request(method, path, { body: method === "GET" ? undefined : {} });

      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.body.error.code, "password_change_required", `${method} ${path}`);
    }
  });
});

test("a trailing slash on an allowed route does not slip past, or lock out, the gate", async () => {
  await withApp(FLAGGED, async (request) => {
    assert.equal((await request("GET", "/api/v1/auth/me/")).status, 200);
    assert.equal((await request("POST", "/api/v1/auth/change-password/", { body: { current_password: "x", new_password: "12345678" } })).status, 200);
  });
});

test("an ordinary account is untouched by the gate: it reaches routes, and /auth/me", async () => {
  await withApp(() => principal(), async (request, { calls }) => {
    assert.equal((await request("GET", "/api/v1/employees")).status, 200);
    assert.equal((await request("GET", "/api/v1/auth/me")).status, 200);
    assert.deepEqual(calls, ["employees.list", "profile"]);
  });
});

test("a principal with no flag at all (an older shape) is treated as not flagged, never as flagged", async () => {
  const { mustChangePassword, ...legacy } = principal();
  void mustChangePassword;
  await withApp(() => legacy, async (request) => {
    assert.equal((await request("GET", "/api/v1/employees")).status, 200);
  });
});

test("the gate refuses a flagged account BEFORE routing, so it cannot be used to discover which routes exist", async () => {
  await withApp(FLAGGED, async (request) => {
    const known = await request("GET", "/api/v1/payroll");
    const unknown = await request("GET", "/api/v1/definitely/not/a/route");

    assert.equal(known.status, unknown.status);
    assert.equal(known.body.error.code, unknown.body.error.code);
  });
});

test("an unauthenticated caller is still a plain 401, not a 403: the gate only applies to a resolved principal", async () => {
  await withApp(FLAGGED, async (request) => {
    assert.equal((await request("GET", "/api/v1/employees", { token: null })).status, 401);
    assert.equal((await request("GET", "/api/v1/employees", { token: "reject" })).status, 401);
    assert.equal((await request("POST", "/api/v1/auth/change-password", { token: null, body: {} })).status, 401);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/change-password
// ---------------------------------------------------------------------------

const GOOD_BODY = Object.freeze({ current_password: "temp-pass-1234", new_password: "my-own-secret-9" });

test("success answers exactly as login does: { data: { accessToken, expiresIn, principal } } and a fresh refresh cookie", async () => {
  await withApp(FLAGGED, async (request, { passwordCalls }) => {
    const response = await request("POST", "/api/v1/auth/change-password", { body: GOOD_BODY });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { data: { accessToken: "new-access-token", expiresIn: 900, principal: SESSION.principal } });
    assert.equal(JSON.stringify(response.body).includes("new-refresh-token"), false, "the refresh token is NEVER in the body");

    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /^refresh_token=new-refresh-token;/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\/api\/v1\/auth/);
    assert.match(cookie, /Max-Age=1209600/);

    assert.deepEqual(passwordCalls[0].body, { currentPassword: "temp-pass-1234", newPassword: "my-own-secret-9" });
    assert.equal(passwordCalls[0].principal.userId, "11111111-1111-4111-8111-111111111111", "the caller's own account, from the token, never from the body");
  });
});

test("the response never contains either password", async () => {
  await withApp(FLAGGED, async (request) => {
    const response = await request("POST", "/api/v1/auth/change-password", { body: GOOD_BODY });

    const everything = JSON.stringify([response.body, [...response.headers.entries()]]);
    assert.equal(everything.includes("temp-pass-1234"), false);
    assert.equal(everything.includes("my-own-secret-9"), false);
  });
});

test("a voluntary change by an account that is NOT flagged uses the same route", async () => {
  await withApp(() => principal(), async (request) => {
    assert.equal((await request("POST", "/api/v1/auth/change-password", { body: GOOD_BODY })).status, 200);
  });
});

test("a malformed body is a 400 invalid_request and the service is never called", async () => {
  await withApp(FLAGGED, async (request, { passwordCalls }) => {
    const bad = [
      {}, { current_password: "x" }, { new_password: "12345678" },
      { current_password: "", new_password: "12345678" },
      { current_password: "x", new_password: "short" },
      { current_password: "x", new_password: "1234567" },
      { current_password: "x", new_password: "y".repeat(201) },
      { current_password: "x".repeat(201), new_password: "12345678" },
      { current_password: 123, new_password: "12345678" },
      { current_password: "x", new_password: "12345678", extra: "field" },
      { current_password: "x", new_password: "12345678", role: "admin" },
    ];
    for (const body of bad) {
      const response = await request("POST", "/api/v1/auth/change-password", { body });

      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, "invalid_request", JSON.stringify(body));
    }
    assert.equal(passwordCalls.length, 0);
  });
});

test("the limits are inclusive: a new password of exactly 8 or exactly 200 characters is accepted", async () => {
  await withApp(FLAGGED, async (request) => {
    for (const length of [8, 200]) {
      const response = await request("POST", "/api/v1/auth/change-password", { body: { current_password: "x", new_password: "n".repeat(length) } });
      assert.equal(response.status, 200, `${length}`);
    }
  });
});

test("a validation error never echoes the password that was submitted", async () => {
  await withApp(FLAGGED, async (request) => {
    const response = await request("POST", "/api/v1/auth/change-password", { body: { current_password: "my-secret-current", new_password: "short" } });

    assert.equal(response.status, 400);
    const text = JSON.stringify(response.body);
    assert.equal(text.includes("short"), false);
    assert.equal(text.includes("my-secret-current"), false);
  });
});

test("the service's refusals pass straight through: wrong current is a 403 (not 401), unchanged is a 400", async () => {
  const refusing = (error) => ({ async changeOwnPassword() { throw error; } });

  await withApp(FLAGGED, async (request) => {
    const wrong = await request("POST", "/api/v1/auth/change-password", { body: GOOD_BODY });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, "current_password_incorrect");
  }, { passwordService: refusing(new HttpError(403, "current_password_incorrect", "The current password is incorrect.")) });

  await withApp(FLAGGED, async (request) => {
    const same = await request("POST", "/api/v1/auth/change-password", { body: GOOD_BODY });
    assert.equal(same.status, 400);
    assert.equal(same.body.error.code, "password_unchanged");
  }, { passwordService: refusing(new HttpError(400, "password_unchanged", "The new password must be different from the current one.")) });
});

test("an unexpected failure is a 500 with no detail", async () => {
  await withApp(FLAGGED, async (request) => {
    const response = await request("POST", "/api/v1/auth/change-password", { body: GOOD_BODY });

    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(response.body).includes("boom"), false);
  }, { passwordService: { async changeOwnPassword() { throw new Error("boom: the database exploded"); } } });
});

test("the public auth routes did not move: login, refresh and logout are still public, and set-password is gone", async () => {
  const authService = {
    tokens: { refreshTokenTtlSeconds: 100 },
    async login() { return { principal: SESSION.principal, accessToken: "a", refreshToken: "r", expiresIn: 900 }; },
    async logout() { return 0; },
  };
  const app = createApp({ verifyAccessToken: async () => { throw new HttpError(401, "unauthenticated", "x"); }, repositories: {}, authService });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/api/v1/auth/login", { email: "a@b.co", password: "x" })).status, 200);
    assert.equal((await post("/api/v1/auth/logout", {})).status, 204);
    assert.equal((await post("/api/v1/auth/set-password", { token: "t", password: "12345678" })).status, 401, "no longer a public route, so the middleware answers");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
