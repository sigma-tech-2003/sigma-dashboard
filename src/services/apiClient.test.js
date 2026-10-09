import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { API_BASE_URL } from "../config/api.js";
import { ApiError, createApiClient } from "./apiClient.js";

// A scripted fetch: `handler(call)` returns the Response for each request and `calls` records them.
function scriptedFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = {
      url, method: init.method, headers: init.headers, credentials: init.credentials,
      body: init.body === undefined ? undefined : JSON.parse(init.body), signal: init.signal, index: calls.length,
    };
    calls.push(call);
    return handler(call, calls);
  };
  return { calls, fetchImpl };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (data) => json(200, { data });
const failure = (status, code, message = "m", extra = {}) => json(status, { error: { code, message, requestId: "req-1", ...extra } });
const noContent = () => new Response(null, { status: 204 });
const refreshed = (accessToken) => ok({ accessToken, expiresIn: 900, principal: { userId: "u", role: "employee" } });
const isRefresh = (call) => call.url.endsWith("/auth/refresh");

const clientFor = (handler, options = {}) => {
  const { calls, fetchImpl } = scriptedFetch(handler);
  return { calls, client: createApiClient({ baseUrl: "/api/v1", fetchImpl, withLock: (task) => task(), ...options }) };
};

test("the base URL lives in config/api.js and is the relative /api/v1 (D36)", () => {
  assert.equal(API_BASE_URL, "/api/v1");
});

test("every request goes to baseUrl + path with credentials included, so the refresh cookie travels", async () => {
  const { calls, client } = clientFor(() => ok([]));
  await client.get("/employees");

  assert.equal(calls[0].url, "/api/v1/employees");
  assert.equal(calls[0].credentials, "include");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Accept, "application/json");
});

test("a custom baseUrl is the only thing that changes where requests go", async () => {
  const { calls, client } = clientFor(() => ok([]), { baseUrl: "https://api.example.test/api/v1" });
  await client.get("/employees");

  assert.equal(calls[0].url, "https://api.example.test/api/v1/employees");
});

test("no Authorization header before there is a token; a Bearer header after setAccessToken", async () => {
  const { calls, client } = clientFor(() => ok([]));
  await client.get("/a");
  client.setAccessToken("T1");
  await client.get("/b");

  assert.equal(Object.hasOwn(calls[0].headers, "Authorization"), false);
  assert.equal(calls[1].headers.Authorization, "Bearer T1");
});

test("auth:false never sends the token, even when one is held", async () => {
  const { calls, client } = clientFor(() => ok({}));
  client.setAccessToken("T1");
  await client.post("/auth/login", { email: "a", password: "b" }, { auth: false });

  assert.equal(Object.hasOwn(calls[0].headers, "Authorization"), false);
});

test("a body is sent as JSON with a Content-Type; a GET has neither", async () => {
  const { calls, client } = clientFor(() => ok({}));
  await client.post("/x", { a: 1 });
  await client.get("/y");
  await client.delete("/z", { replacement_team_lead_id: "t" });

  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(calls[0].body, { a: 1 });
  assert.equal(Object.hasOwn(calls[1].headers, "Content-Type"), false);
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[2].method, "DELETE");
  assert.deepEqual(calls[2].body, { replacement_team_lead_id: "t" });
});

test("{ data } is unwrapped, and a 204 resolves undefined", async () => {
  const { client } = clientFor((call) => (call.url.endsWith("/gone") ? noContent() : ok({ id: 1 })));

  assert.deepEqual(await client.get("/thing"), { id: 1 });
  assert.equal(await client.delete("/gone"), undefined);
});

test("query parameters are appended, skipping undefined, null and empty values", async () => {
  const { calls, client } = clientFor(() => ok({}));
  await client.get("/leave-balances", { query: { employee_id: "e1", as_of: undefined, x: null, y: "", n: 0 } });

  assert.equal(calls[0].url, "/api/v1/leave-balances?employee_id=e1&n=0");
});

test("the API's error envelope becomes an ApiError with status, code, message, details and requestId", async () => {
  const { client } = clientFor(() => failure(409, "leave_overlaps", "Overlaps.", { details: { conflicting_id: "L1" } }));

  await assert.rejects(client.post("/leaves", {}), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "leave_overlaps");
    assert.equal(error.message, "Overlaps.");
    assert.deepEqual(error.details, { conflicting_id: "L1" });
    assert.equal(error.requestId, "req-1");
    return true;
  });
});

test("a gateway page that is not the API's envelope becomes unavailable (5xx) or unexpected_response (4xx)", async () => {
  const html = (status) => new Response("<html>Bad gateway</html>", { status, headers: { "content-type": "text/html" } });

  const bad = clientFor(() => html(502));
  await assert.rejects(bad.client.get("/x"), (error) => error.code === "unavailable" && error.status === 502);

  const missing = clientFor(() => html(404));
  await assert.rejects(missing.client.get("/x"), (error) => error.code === "unexpected_response" && error.status === 404);
});

test("a 200 that is not the API's JSON (a SPA fallback page from a missing rewrite) fails loudly", async () => {
  const { client } = clientFor(() => new Response("<!doctype html><title>app</title>", { status: 200 }));

  await assert.rejects(client.get("/employees"), (error) => error.code === "unexpected_response");
});

test("a rejected fetch becomes a network ApiError with status 0", async () => {
  const { client } = clientFor(() => { throw new TypeError("Failed to fetch"); });

  await assert.rejects(client.get("/x"), (error) => error instanceof ApiError && error.code === "network" && error.status === 0);
});

test("an abort is rethrown as an abort, not dressed up as a network failure", async () => {
  const { client } = clientFor(() => { throw new DOMException("Aborted", "AbortError"); });

  await assert.rejects(client.get("/x"), (error) => error.name === "AbortError");
});

test("a 401 on an authenticated call refreshes once and retries once with the new token", async () => {
  const { calls, client } = clientFor((call) => {
    if (isRefresh(call)) return refreshed("T2");
    return call.headers.Authorization === "Bearer T2" ? ok({ id: 1 }) : failure(401, "unauthenticated");
  });
  client.setAccessToken("T1");

  assert.deepEqual(await client.get("/employees"), { id: 1 });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace("/api/v1", "")}`), ["GET /employees", "POST /auth/refresh", "GET /employees"]);
  assert.equal(calls[2].headers.Authorization, "Bearer T2");
  assert.equal(client.getAccessToken(), "T2");
});

test("the refresh request carries the cookie and no bearer token", async () => {
  const { calls, client } = clientFor((call) => (isRefresh(call) ? refreshed("T2") : failure(401, "unauthenticated")));
  client.setAccessToken("T1");
  await client.get("/x").catch(() => {});

  const refresh = calls.find(isRefresh);
  assert.equal(refresh.credentials, "include");
  assert.equal(Object.hasOwn(refresh.headers, "Authorization"), false);
});

test("a second 401 after the retry is returned, never looped: one refresh, two attempts", async () => {
  const { calls, client } = clientFor((call) => (isRefresh(call) ? refreshed("T2") : failure(401, "unauthenticated")));
  client.setAccessToken("T1");

  await assert.rejects(client.get("/employees"), (error) => error.status === 401);
  assert.equal(calls.filter(isRefresh).length, 1);
  assert.equal(calls.filter((c) => !isRefresh(c)).length, 2);
});

test("a failed refresh clears the token, tells the listeners, and throws the original 401", async () => {
  const { client } = clientFor((call) => (isRefresh(call) ? failure(401, "unauthenticated", "refresh") : failure(401, "unauthenticated", "original")));
  client.setAccessToken("T1");
  let lost = 0;
  client.onAuthLost(() => { lost += 1; });

  await assert.rejects(client.get("/x"), (error) => error.status === 401 && error.message === "original");
  assert.equal(client.getAccessToken(), null);
  assert.equal(lost, 1);
});

test("a refresh that fails for a NETWORK reason does not sign the user out", async () => {
  const { client } = clientFor((call) => {
    if (isRefresh(call)) throw new TypeError("offline");
    return failure(401, "unauthenticated");
  });
  client.setAccessToken("T1");
  let lost = 0;
  client.onAuthLost(() => { lost += 1; });

  await assert.rejects(client.get("/x"), (error) => error.code === "network");
  assert.equal(lost, 0, "no auth-lost on a network failure");
});

test("a refresh that fails with a 5xx does not sign the user out either", async () => {
  const { client } = clientFor((call) => (isRefresh(call) ? failure(503, "unavailable") : failure(401, "unauthenticated")));
  client.setAccessToken("T1");
  let lost = 0;
  client.onAuthLost(() => { lost += 1; });

  await assert.rejects(client.get("/x"), (error) => error.status === 503);
  assert.equal(lost, 0);
});

test("a 401 refresh at boot (no session yet) is not an auth-lost event", async () => {
  const { client } = clientFor(() => failure(401, "unauthenticated"));
  let lost = 0;
  client.onAuthLost(() => { lost += 1; });

  await assert.rejects(client.refreshSession(), (error) => error.status === 401);
  assert.equal(lost, 0, "there was no session to lose");
});

test("onAuthLost returns an unsubscribe function", async () => {
  const { client } = clientFor(() => failure(401, "unauthenticated"));
  client.setAccessToken("T1");
  let lost = 0;
  const unsubscribe = client.onAuthLost(() => { lost += 1; });
  unsubscribe();

  await client.get("/x").catch(() => {});
  assert.equal(lost, 0);
});

test("auth:false calls (login, refresh, logout, set-password) never trigger a refresh on a 401", async () => {
  const { calls, client } = clientFor(() => failure(401, "unauthenticated"));
  client.setAccessToken("T1");

  await assert.rejects(client.post("/auth/login", {}, { auth: false }), (error) => error.status === 401);
  assert.equal(calls.length, 1, "exactly one request, no refresh, no retry");
});

test("three parallel requests that all 401 share ONE refresh (single-flight)", async () => {
  const { calls, client } = clientFor(async (call) => {
    if (isRefresh(call)) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return refreshed("T2");
    }
    return call.headers.Authorization === "Bearer T2" ? ok({ path: call.url }) : failure(401, "unauthenticated");
  });
  client.setAccessToken("T1");

  const results = await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);

  assert.equal(results.length, 3);
  assert.equal(calls.filter(isRefresh).length, 1, "the single-use refresh cookie is presented once");
});

test("two concurrent refreshSession() calls (React StrictMode's double effect) make ONE request", async () => {
  const { calls, client } = clientFor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return refreshed("T2");
  });

  const [first, second] = await Promise.all([client.refreshSession(), client.refreshSession()]);

  assert.equal(calls.length, 1);
  assert.equal(first, second, "both callers get the same result");
});

test("after a refresh settles, the next refresh is a fresh request", async () => {
  let n = 0;
  const { calls, client } = clientFor(() => refreshed(`T${(n += 1)}`));

  await client.refreshSession();
  await client.refreshSession();

  assert.equal(calls.length, 2);
  assert.equal(client.getAccessToken(), "T2");
});

test("a request whose token was replaced while it was in flight retries with the new token and does NOT refresh", async () => {
  const { calls, client } = clientFor((call) => {
    if (call.index === 0) {
      client.setAccessToken("T2"); // another request's refresh landed while this one was in flight
      return failure(401, "unauthenticated");
    }
    return ok({ retried: call.headers.Authorization });
  });
  client.setAccessToken("T1");

  assert.deepEqual(await client.get("/x"), { retried: "Bearer T2" });
  assert.equal(calls.filter(isRefresh).length, 0);
});

test("the refresh runs inside the injected lock (cross-tab serialisation)", async () => {
  const events = [];
  const { client } = clientFor(
    () => { events.push("refresh-request"); return refreshed("T2"); },
    { withLock: async (task) => { events.push("lock-acquired"); const result = await task(); events.push("lock-released"); return result; } },
  );

  await client.refreshSession();

  assert.deepEqual(events, ["lock-acquired", "refresh-request", "lock-released"]);
});

test("clearSession forgets the token", async () => {
  const { client } = clientFor(() => ok({}));
  client.setAccessToken("T1");
  client.clearSession();

  assert.equal(client.getAccessToken(), null);
});

test("the access token is held in memory only: the client never touches web storage", async () => {
  const source = await readFile(new URL("./apiClient.js", import.meta.url), "utf8");
  const code = source.replace(/\/\/.*$/gm, "");

  assert.doesNotMatch(code, /localStorage|sessionStorage|document\.cookie|indexedDB/);
});
