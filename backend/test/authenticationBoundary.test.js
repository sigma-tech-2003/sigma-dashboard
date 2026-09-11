import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.js";
import { HttpError } from "../src/utils/httpError.js";

const PRINCIPAL = Object.freeze({
  userId: "user-1",
  employeeId: "emp-1",
  role: "manager",
  departmentId: "dept-1",
  isTeamLead: false,
});

/** Starts the app on an ephemeral port and returns a fetch helper plus a closer. */
async function startApp(verifyAccessToken) {
  const app = createApp({ verifyAccessToken });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    async get(pathname, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("health is public and answers without credentials", async () => {
  // A readiness probe has no token, and health must answer before anyone can log in.
  const app = await startApp(async () => PRINCIPAL);
  try {
    const response = await app.get("/api/v1/health");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ok" });
  } finally {
    await app.close();
  }
});

test("routes behind the boundary reject a request with no bearer token", async () => {
  const app = await startApp(async () => PRINCIPAL);
  try {
    // No authenticated routes exist yet, so an unknown path proves which handler ran:
    // 401 from the authentication middleware, not 404 from notFound.
    const response = await app.get("/api/v1/employees");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
    assert.ok(response.body.error.requestId, "the error envelope carries the request id");
  } finally {
    await app.close();
  }
});

test("malformed authorization headers are rejected without calling the verifier", async () => {
  let verifierCalls = 0;
  const app = await startApp(async () => {
    verifierCalls += 1;
    return PRINCIPAL;
  });

  try {
    for (const authorization of [
      "",
      "Bearer",
      "Basic dXNlcjpwYXNz",
      "bearer lowercase-scheme",
      "Token abc",
    ]) {
      const response = await app.get("/api/v1/employees", { authorization });
      assert.equal(response.status, 401, `authorization: ${authorization}`);
    }
    assert.equal(verifierCalls, 0, "the verifier must not see a malformed header");
  } finally {
    await app.close();
  }
});

test("a rejected token yields 401 and never leaks the verifier's reason", async () => {
  const app = await startApp(async () => {
    throw new Error("user 4f2a is suspended in tenant acme");
  });

  try {
    const response = await app.get("/api/v1/employees", { authorization: "Bearer whatever" });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.message, "Authentication is required.");
    assert.doesNotMatch(JSON.stringify(response.body), /suspended|4f2a|acme/);
  } finally {
    await app.close();
  }
});

test("the middleware refuses to be constructed without a verifier", () => {
  // This is the guard that went unsatisfied for the whole of Phase 0: the middleware
  // demanded a verifyAccessToken that did not exist, so it was never mounted.
  for (const dependencies of [{}, { verifyAccessToken: null }, { verifyAccessToken: "nope" }]) {
    assert.throws(() => createAuthenticationMiddleware(dependencies), TypeError);
  }
  assert.doesNotThrow(() => createAuthenticationMiddleware({ verifyAccessToken: async () => PRINCIPAL }));
});

test("a valid token attaches the principal to the request", async () => {
  let seen = null;
  const middleware = createAuthenticationMiddleware({
    verifyAccessToken: async (token) => {
      assert.equal(token, "good-token");
      return PRINCIPAL;
    },
  });

  const request = { get: (name) => (name === "authorization" ? "Bearer good-token" : undefined) };
  await middleware(request, {}, (error) => { seen = error ?? "next"; });

  assert.equal(seen, "next");
  assert.deepEqual(request.principal, PRINCIPAL);
});

test("an HttpError from the verifier is preserved rather than flattened", async () => {
  let seen = null;
  const middleware = createAuthenticationMiddleware({
    verifyAccessToken: async () => {
      throw new HttpError(403, "account_locked", "This account is locked.");
    },
  });

  const request = { get: () => "Bearer token" };
  await middleware(request, {}, (error) => { seen = error; });

  assert.ok(seen instanceof HttpError);
  assert.equal(seen.statusCode, 403);
  assert.equal(seen.code, "account_locked");
});
