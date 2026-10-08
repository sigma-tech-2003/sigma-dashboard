import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createProfileService } from "../src/services/profileService.js";
import { HttpError } from "../src/utils/httpError.js";
import { USER_ROLES } from "../src/utils/roles.js";

// HTTP-level, with the REAL authentication middleware and the real profile service, against a fake
// employee repository (no database). What is proved (D32): GET /auth/me sits behind the middleware even
// though it lives under /auth beside the public routes; it answers with the caller's own profile and
// only that; and it has no way to be asked for anyone else's.

function row(role, overrides = {}) {
  return {
    id: `emp-${role}`, user_id: `user-${role}`, company_id: "co", department_id: "dept-1", department_name: "Engineering",
    team_lead_id: null, employee_number: `EMP-${role}`, full_name: `A ${role}`, phone: null,
    position_title: "Engineer", employment_status: "active", joined_on: "2024-03-15",
    basic: 100000, allowances: 5000, role, email: `${role}@example.com`, ...overrides,
  };
}

function fakeEmployeeRepository(rows) {
  const calls = [];
  return {
    calls,
    async findById(id) {
      calls.push(id);
      return rows.find((candidate) => candidate.id === id) ?? null;
    },
  };
}

// A verifier that accepts one token per role and rejects everything else, the way the real one rejects
// a token it cannot verify.
const verifyAccessToken = async (token) => {
  const role = token.replace(/^token-/, "");
  if (!USER_ROLES.includes(role) || !token.startsWith("token-")) {
    throw new HttpError(401, "unauthenticated", "Authentication is required.");
  }
  return { userId: `user-${role}`, employeeId: `emp-${role}`, role, departmentId: "dept-1" };
};

async function withApp(rows, fn, extraDependencies = {}) {
  const employeeRepository = fakeEmployeeRepository(rows);
  const app = createApp({
    verifyAccessToken,
    repositories: {},
    profileService: createProfileService({ employeeRepository }),
    ...extraDependencies,
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const request = async (method, pathname, { token, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  try {
    return await fn(request, employeeRepository);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const ALL_ROWS = USER_ROLES.map((role) => row(role));

test("GET /auth/me without a bearer token is 401 -- it is behind the authentication middleware", async () => {
  await withApp(ALL_ROWS, async (request, repository) => {
    const response = await request("GET", "/api/v1/auth/me");

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
    assert.equal(repository.calls.length, 0, "the profile was never looked up");
  });
});

test("GET /auth/me with a token the verifier rejects is 401", async () => {
  await withApp(ALL_ROWS, async (request, repository) => {
    for (const token of ["garbage", "token-superuser", "Bearer"]) {
      const response = await request("GET", "/api/v1/auth/me", { token });
      assert.equal(response.status, 401, token);
    }
    assert.equal(repository.calls.length, 0);
  });
});

test("GET /auth/me is 200 with the caller's own profile, for every role", async () => {
  await withApp(ALL_ROWS, async (request) => {
    for (const role of USER_ROLES) {
      const response = await request("GET", "/api/v1/auth/me", { token: `token-${role}` });

      assert.equal(response.status, 200, role);
      assert.equal(response.body.data.id, `emp-${role}`, role);
      assert.equal(response.body.data.role, role, role);
      assert.equal(response.body.data.email, `${role}@example.com`, role);
    }
  });
});

test("D33 -- the profile carries department_name and department_id, for the roles that cannot read the departments list", async () => {
  await withApp(ALL_ROWS, async (request) => {
    for (const role of ["manager", "tl", "employee"]) {
      const { body } = await request("GET", "/api/v1/auth/me", { token: `token-${role}` });

      assert.equal(body.data.department_name, "Engineering", role);
      assert.equal(body.data.department_id, "dept-1", role);
    }
  });
});

test("the response is { data: profile } with exactly the profile fields, and no compensation", async () => {
  await withApp(ALL_ROWS, async (request) => {
    const { body } = await request("GET", "/api/v1/auth/me", { token: "token-employee" });

    assert.deepEqual(Object.keys(body), ["data"]);
    assert.deepEqual(Object.keys(body.data).sort(), [
      "department_id", "department_name", "email", "employee_number", "employment_status", "full_name", "id",
      "joined_on", "phone", "position_title", "role", "team_lead_id",
    ]);
    assert.equal(Object.hasOwn(body.data, "basic"), false);
    assert.equal(Object.hasOwn(body.data, "allowances"), false);
  });
});

test("it is always the caller's own: a query string cannot ask for anyone else's profile", async () => {
  await withApp(ALL_ROWS, async (request, repository) => {
    for (const query of ["?employee_id=emp-admin", "?id=emp-admin", "?user_id=user-admin", "?as=admin"]) {
      const response = await request("GET", `/api/v1/auth/me${query}`, { token: "token-employee" });

      assert.equal(response.status, 200, query);
      assert.equal(response.body.data.id, "emp-employee", query);
    }
    assert.ok(repository.calls.every((id) => id === "emp-employee"), "only the caller's own id was ever looked up");
  });
});

test("there is no way to address another profile by path: /auth/me/<id> and /auth/<id> are 404", async () => {
  await withApp(ALL_ROWS, async (request) => {
    assert.equal((await request("GET", "/api/v1/auth/me/emp-admin", { token: "token-employee" })).status, 404);
    assert.equal((await request("GET", "/api/v1/auth/emp-admin", { token: "token-employee" })).status, 404);
  });
});

test("only GET is offered: POST, PATCH and DELETE on /auth/me are 404", async () => {
  await withApp(ALL_ROWS, async (request) => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const response = await request(method, "/api/v1/auth/me", { token: "token-admin", body: { full_name: "x" } });
      assert.equal(response.status, 404, method);
    }
  });
});

test("a caller whose employee row has gone is 404, not a 500", async () => {
  await withApp([], async (request) => {
    const response = await request("GET", "/api/v1/auth/me", { token: "token-employee" });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not_found");
  });
});

test("the public auth routes stay public beside /auth/me: login needs no bearer token, and /auth/me on the same app still does", async () => {
  // A fake authService, so nothing here reaches a database. It succeeds for any login; the point is that
  // the request is answered by the login handler and not stopped by the authentication middleware that
  // guards /auth/me one router later.
  const authService = {
    tokens: { refreshTokenTtlSeconds: 100 },
    async login() {
      return { principal: { userId: "user-employee", employeeId: "emp-employee", role: "employee", departmentId: "dept-1" },
        accessToken: "token-employee", refreshToken: "r", expiresIn: 900 };
    },
  };
  await withApp(ALL_ROWS, async (request) => {
    const login = await request("POST", "/api/v1/auth/login", { body: { email: "a@b.c", password: "x" } });
    assert.equal(login.status, 200, "login is public");
    assert.equal(login.body.data.principal.role, "employee");

    const withoutToken = await request("GET", "/api/v1/auth/me");
    assert.equal(withoutToken.status, 401, "while /auth/me, on the same app, is not");

    const withToken = await request("GET", "/api/v1/auth/me", { token: login.body.data.accessToken });
    assert.equal(withToken.status, 200, "and works with the token that login handed out");
  }, { authService });
});
