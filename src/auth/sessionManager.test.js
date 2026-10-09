import assert from "node:assert/strict";
import test from "node:test";
import { SessionError, createAuthApiService } from "../services/authApiService.js";
import { ApiError, createApiClient } from "../services/apiClient.js";
import { createSessionManager } from "./sessionManager.js";

const PROFILE = Object.freeze({
  id: "e1", employee_number: "EMP-0007", full_name: "Aisha Khan", email: "aisha@example.com", phone: null,
  role: "manager", department_id: "d1", department_name: "Engineering", position_title: "Lead",
  joined_on: "2024-03-15", team_lead_id: null, employment_status: "active",
});
const PRINCIPAL = Object.freeze({ userId: "u1", employeeId: "e1", role: "manager", departmentId: "d1", isTeamLead: false });

const apiError = (status, code = "x") => new ApiError({ status, code, message: "m" });

// A fake authApi (the layer the session manager sees). Each method can be made to fail.
function fakeAuthApi(overrides = {}) {
  const calls = [];
  const record = (name, impl) => async (...args) => { calls.push(name); return impl(...args); };
  return {
    calls,
    login: record("login", overrides.login ?? (async () => PRINCIPAL)),
    restore: record("restore", overrides.restore ?? (async () => PRINCIPAL)),
    me: record("me", overrides.me ?? (async () => PROFILE)),
    logout: record("logout", overrides.logout ?? (async () => undefined)),
  };
}

const rejection = async (promise) => {
  try { await promise; return null; } catch (error) { return error; }
};

test("restore: refresh then /auth/me gives the session user", async () => {
  const authApi = fakeAuthApi();
  const user = await createSessionManager({ authApi }).restore();

  assert.deepEqual(authApi.calls, ["restore", "me"]);
  assert.equal(user.id, "e1");
  assert.equal(user.dept, "Engineering");
  assert.equal(user.role, "manager");
});

test("restore: no session (the refresh is a 401) is null, not an error, and /auth/me is never called", async () => {
  const authApi = fakeAuthApi({ restore: async () => { throw apiError(401, "unauthenticated"); } });

  assert.equal(await createSessionManager({ authApi }).restore(), null);
  assert.deepEqual(authApi.calls, ["restore"]);
});

test("restore: a network failure is an 'unavailable' error, not a silent sign-out", async () => {
  const authApi = fakeAuthApi({ restore: async () => { throw apiError(0, "network"); } });
  const error = await rejection(createSessionManager({ authApi }).restore());

  assert.ok(error instanceof SessionError);
  assert.equal(error.code, "unavailable");
});

test("restore: a malformed profile ends the session (logout) and reports data-integrity", async () => {
  const authApi = fakeAuthApi({ me: async () => ({ ...PROFILE, role: "superuser" }) });
  const error = await rejection(createSessionManager({ authApi }).restore());

  assert.equal(error.code, "data-integrity");
  assert.ok(authApi.calls.includes("logout"));
});

test("restore: /auth/me failing with a 5xx leaves the session alone and reports unavailable", async () => {
  const authApi = fakeAuthApi({ me: async () => { throw apiError(503, "unavailable"); } });
  const error = await rejection(createSessionManager({ authApi }).restore());

  assert.equal(error.code, "unavailable");
  assert.equal(authApi.calls.includes("logout"), false);
});

test("login: credentials, then the role check, then /auth/me", async () => {
  const authApi = fakeAuthApi();
  const user = await createSessionManager({ authApi }).login({ email: "a@b.co", password: "pw", selectedRole: "manager" });

  assert.deepEqual(authApi.calls, ["login", "me"]);
  assert.equal(user.role, "manager");
});

test("login: a role that does not match the selection is logged out and shows the existing message (D37)", async () => {
  const authApi = fakeAuthApi();
  const error = await rejection(createSessionManager({ authApi }).login({ email: "a@b.co", password: "pw", selectedRole: "admin" }));

  assert.ok(error instanceof SessionError);
  assert.equal(error.code, "permission-denied");
  assert.equal(error.message, "These credentials do not belong to the selected role.");
  assert.deepEqual(authApi.calls, ["login", "logout"], "the profile is never loaded for a wrong persona");
});

test("login: a mismatch whose logout call also fails still reports the role message", async () => {
  const authApi = fakeAuthApi({ logout: async () => { throw apiError(500); } });
  const error = await rejection(createSessionManager({ authApi }).login({ email: "a@b.co", password: "pw", selectedRole: "employee" }));

  assert.equal(error.code, "permission-denied");
});

test("login: all five picker values are checked against principal.role", async () => {
  for (const role of ["admin", "hr", "manager", "tl", "employee"]) {
    const authApi = fakeAuthApi({ login: async () => ({ ...PRINCIPAL, role }), me: async () => ({ ...PROFILE, role }) });
    const manager = createSessionManager({ authApi });

    assert.equal((await manager.login({ email: "a@b.co", password: "p", selectedRole: role })).role, role);
    assert.equal((await rejection(manager.login({ email: "a@b.co", password: "p", selectedRole: role === "admin" ? "hr" : "admin" }))).code, "permission-denied");
  }
});

test("login: no role selected is refused before any request", async () => {
  const authApi = fakeAuthApi();
  const error = await rejection(createSessionManager({ authApi }).login({ email: "a@b.co", password: "pw", selectedRole: "" }));

  assert.equal(error.code, "invalid-argument");
  assert.equal(error.message, "Select a valid role before signing in.");
  assert.deepEqual(authApi.calls, []);
});

test("login: wrong credentials give the one generic message", async () => {
  const authApi = fakeAuthApi({ login: async () => { throw apiError(401, "unauthenticated"); } });
  const error = await rejection(createSessionManager({ authApi }).login({ email: "a@b.co", password: "bad", selectedRole: "manager" }));

  assert.equal(error.code, "invalid-credentials");
  assert.equal(error.message, "Unable to sign in. Check your credentials and try again.");
});

test("login: a server or network failure is 'unavailable'; anything unrecognised is 'internal'", async () => {
  for (const [failure, code] of [[apiError(503), "unavailable"], [apiError(0, "network"), "unavailable"], [new Error("boom"), "internal"]]) {
    const authApi = fakeAuthApi({ login: async () => { throw failure; } });
    const error = await rejection(createSessionManager({ authApi }).login({ email: "a@b.co", password: "p", selectedRole: "manager" }));
    assert.equal(error.code, code);
  }
});

test("login: a failed /auth/me after a good login logs out and reports data-integrity", async () => {
  const authApi = fakeAuthApi({ me: async () => { throw apiError(404, "not_found"); } });
  const error = await rejection(createSessionManager({ authApi }).login({ email: "a@b.co", password: "p", selectedRole: "manager" }));

  assert.equal(error.code, "data-integrity");
  assert.deepEqual(authApi.calls, ["login", "me", "logout"]);
});

test("refreshProfile re-reads /auth/me", async () => {
  const authApi = fakeAuthApi();
  const user = await createSessionManager({ authApi }).refreshProfile();

  assert.deepEqual(authApi.calls, ["me"]);
  assert.equal(user.name, "Aisha Khan");
});

test("errors never leak server detail into the message", async () => {
  const authApi = fakeAuthApi({ login: async () => { throw new ApiError({ status: 500, code: "internal", message: "SQL exploded at line 9" }); } });
  const error = await rejection(createSessionManager({ authApi }).login({ email: "a@b.co", password: "p", selectedRole: "manager" }));

  assert.doesNotMatch(error.message, /SQL|line 9/);
});

// ---- the real authApiService over the real client, with a scripted fetch ------------------------------------

function wiredSession(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: url.replace("/api/v1", ""), method: init.method, auth: init.headers.Authorization, body: init.body });
    return handler(calls.at(-1));
  };
  const api = createApiClient({ fetchImpl, withLock: (task) => task() });
  const authApi = createAuthApiService(api);
  return { api, calls, manager: createSessionManager({ authApi }) };
}

const respond = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

test("end to end over the client: login stores the token, /auth/me is sent with it, and logout forgets it", async () => {
  const { api, calls, manager } = wiredSession((call) => {
    if (call.url === "/auth/login") return respond(200, { data: { accessToken: "T1", expiresIn: 900, principal: PRINCIPAL } });
    if (call.url === "/auth/me") return respond(200, { data: PROFILE });
    if (call.url === "/auth/logout") return respond(204);
    return respond(404, { error: { code: "not_found", message: "x" } });
  });

  const user = await manager.login({ email: "a@b.co", password: "pw", selectedRole: "manager" });
  assert.equal(user.id, "e1");
  assert.equal(api.getAccessToken(), "T1");
  assert.equal(calls.find((c) => c.url === "/auth/me").auth, "Bearer T1");
  assert.equal(calls.find((c) => c.url === "/auth/login").auth, undefined, "login is sent without a bearer token");

  await manager.logout();
  assert.equal(api.getAccessToken(), null);
});

test("end to end: logout forgets the token even when the server call fails", async () => {
  const { api, manager } = wiredSession(() => respond(500, { error: { code: "internal", message: "x" } }));
  api.setAccessToken("T1");

  await rejection(manager.logout());
  assert.equal(api.getAccessToken(), null);
});

test("end to end: restore on boot, with the cookie, signs the user in without a role pick (D37)", async () => {
  const { api, calls, manager } = wiredSession((call) => {
    if (call.url === "/auth/refresh") return respond(200, { data: { accessToken: "T9", expiresIn: 900, principal: PRINCIPAL } });
    return respond(200, { data: PROFILE });
  });

  const user = await manager.restore();

  assert.equal(user.role, "manager");
  assert.equal(api.getAccessToken(), "T9");
  assert.deepEqual(calls.map((c) => c.url), ["/auth/refresh", "/auth/me"]);
});

test("end to end: restore with no cookie (refresh 401) is simply signed out", async () => {
  const { manager } = wiredSession(() => respond(401, { error: { code: "unauthenticated", message: "x" } }));

  assert.equal(await manager.restore(), null);
});

test("end to end: StrictMode's two simultaneous restores make ONE refresh request", async () => {
  const { calls, manager } = wiredSession(async (call) => {
    if (call.url === "/auth/refresh") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return respond(200, { data: { accessToken: "T9", expiresIn: 900, principal: PRINCIPAL } });
    }
    return respond(200, { data: PROFILE });
  });

  const [a, b] = await Promise.all([manager.restore(), manager.restore()]);

  assert.equal(calls.filter((c) => c.url === "/auth/refresh").length, 1);
  assert.equal(a.id, "e1");
  assert.equal(b.id, "e1");
});

test("end to end: setPassword is a public call and sends the token and password", async () => {
  const { calls } = wiredSession(() => respond(204));
  const authApi = createAuthApiService(createApiClient({
    fetchImpl: async (url, init) => { calls.push({ url, body: init.body, auth: init.headers.Authorization }); return respond(204); },
    withLock: (task) => task(),
  }));

  await authApi.setPassword("tok", "a long password");

  assert.equal(calls[0].url, "/api/v1/auth/set-password");
  assert.deepEqual(JSON.parse(calls[0].body), { token: "tok", password: "a long password" });
  assert.equal(calls[0].auth, undefined);
});

// ---- the session as a store ------------------------------------------------------------------------------------

const watch = (manager) => {
  const seen = [];
  manager.subscribe(() => seen.push(manager.getState()));
  return seen;
};

test("store: starts signed out and not ready", () => {
  const manager = createSessionManager({ authApi: fakeAuthApi() });

  assert.deepEqual(manager.getState(), { user: null, authReady: false });
});

test("store: getState returns the same object until something changes (useSyncExternalStore needs that)", async () => {
  const manager = createSessionManager({ authApi: fakeAuthApi() });
  assert.equal(manager.getState(), manager.getState());

  const before = manager.getState();
  await manager.restore();
  assert.notEqual(manager.getState(), before);
  assert.equal(manager.getState(), manager.getState());
});

test("store: restore sets the user and authReady, and notifies subscribers", async () => {
  const manager = createSessionManager({ authApi: fakeAuthApi() });
  const seen = watch(manager);
  await manager.restore();

  assert.equal(manager.getState().authReady, true);
  assert.equal(manager.getState().user.id, "e1");
  assert.equal(seen.at(-1).user.id, "e1");
});

test("store: restore with no session is ready and signed out", async () => {
  const manager = createSessionManager({ authApi: fakeAuthApi({ restore: async () => { throw apiError(401, "unauthenticated"); } }) });
  await manager.restore();

  assert.deepEqual(manager.getState(), { user: null, authReady: true });
});

test("store: a restore that fails for a reason that says nothing about the session is still ready, and signed out", async () => {
  const manager = createSessionManager({ authApi: fakeAuthApi({ restore: async () => { throw apiError(0, "network"); } }) });
  const error = await rejection(manager.restore());

  assert.equal(error.code, "unavailable");
  assert.deepEqual(manager.getState(), { user: null, authReady: true });
});

test("store: two simultaneous restores (StrictMode) share one run", async () => {
  const authApi = fakeAuthApi();
  const manager = createSessionManager({ authApi });
  await Promise.all([manager.restore(), manager.restore()]);

  assert.deepEqual(authApi.calls, ["restore", "me"]);
});

test("store: authenticate holds the token but changes no state, so nothing renders for a wrong persona", async () => {
  const authApi = fakeAuthApi();
  const manager = createSessionManager({ authApi });
  const seen = watch(manager);

  const principal = await manager.authenticate("a@b.co", "pw");

  assert.equal(principal.role, "manager");
  assert.equal(manager.getState().user, null);
  assert.equal(seen.length, 0);
});

test("store: establish sets the user only after the role check passes", async () => {
  const authApi = fakeAuthApi();
  const manager = createSessionManager({ authApi });
  await manager.authenticate("a@b.co", "pw");
  const user = await manager.establish("manager");

  assert.equal(manager.getState().user, user);
  assert.equal(manager.getState().authReady, true);
});

test("store: establish with the wrong role logs out and NEVER sets the user (LoginPage's own two-step flow)", async () => {
  const authApi = fakeAuthApi();
  const manager = createSessionManager({ authApi });
  const seen = watch(manager);
  await manager.authenticate("a@b.co", "pw");

  const error = await rejection(manager.establish("admin"));

  assert.equal(error.code, "permission-denied");
  assert.equal(manager.getState().user, null);
  assert.equal(seen.length, 0, "no state change was ever published");
  assert.deepEqual(authApi.calls, ["login", "logout"]);
});

test("store: establish with no role compares nothing (a restore, or a session started in another tab)", async () => {
  const authApi = fakeAuthApi();
  const manager = createSessionManager({ authApi });
  await manager.authenticate("a@b.co", "pw");

  assert.equal((await manager.establish(null)).role, "manager");
  assert.equal((await manager.establish(undefined)).role, "manager");
});

test("store: establish with no prior sign-in step does not invent a mismatch", async () => {
  const manager = createSessionManager({ authApi: fakeAuthApi() });

  assert.equal((await manager.establish("admin")).role, "manager", "nothing to compare against, so nothing refused");
});

test("store: authenticate with bad credentials throws the generic message and publishes nothing", async () => {
  const authApi = fakeAuthApi({ login: async () => { throw apiError(401, "unauthenticated"); } });
  const manager = createSessionManager({ authApi });
  const error = await rejection(manager.authenticate("a@b.co", "bad"));

  assert.equal(error.code, "invalid-credentials");
  assert.equal(manager.getState().user, null);
});

test("store: logout signs the user out immediately, before the server answers, and still calls the server", async () => {
  const authApi = fakeAuthApi();
  const manager = createSessionManager({ authApi });
  await manager.restore();

  const pending = manager.logout();
  assert.equal(manager.getState().user, null);
  await pending;
  assert.ok(authApi.calls.includes("logout"));
});

test("store: when the API proves the session is gone, the user is signed out", async () => {
  let lost;
  const authApi = { ...fakeAuthApi(), onAuthLost: (listener) => { lost = listener; return () => {}; } };
  const manager = createSessionManager({ authApi });
  await manager.restore();
  assert.ok(manager.getState().user);

  lost();

  assert.equal(manager.getState().user, null);
});

test("store: refreshProfile publishes the re-read user", async () => {
  let name = "Aisha Khan";
  const authApi = fakeAuthApi({ me: async () => ({ ...PROFILE, full_name: name }) });
  const manager = createSessionManager({ authApi });
  await manager.restore();
  name = "Aisha Q. Khan";
  await manager.refreshProfile();

  assert.equal(manager.getState().user.name, "Aisha Q. Khan");
});

test("store: unsubscribe stops notifications", async () => {
  const manager = createSessionManager({ authApi: fakeAuthApi() });
  let count = 0;
  const unsubscribe = manager.subscribe(() => { count += 1; });
  unsubscribe();
  await manager.restore();

  assert.equal(count, 0);
});
