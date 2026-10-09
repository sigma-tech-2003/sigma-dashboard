// Test doubles shared by the service tests. Not imported by the app, so the bundle never contains it.

/**
 * A fake API client: records every call and answers with `respond(call)`. Same surface the services use
 * (get / post / patch / delete), so a service built with `createXService(fakeApi(...))` runs without a network.
 */
export function fakeApi(respond = () => undefined) {
  const calls = [];
  const record = (method) => async (path, ...args) => {
    const [first, second] = args;
    const call = method === "GET"
      ? { method, path, query: first?.query }
      : { method, path, body: first, options: second };
    calls.push(call);
    return respond(call);
  };
  return {
    calls,
    get: record("GET"),
    post: record("POST"),
    patch: record("PATCH"),
    delete: record("DELETE"),
  };
}

/**
 * Replaces the global `fetch` so the real singleton services (which use the default API client) can be tested.
 * `handler({ method, path, body, headers })` returns `{ status, body }`; the helper builds the Response.
 */
export function installFakeFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = {
      method: init.method,
      path: String(url).replace(/^\/api\/v1/, ""),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      headers: init.headers,
    };
    calls.push(call);
    const { status = 200, body } = (await handler(call)) ?? {};
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

export const ok = (data) => ({ status: 200, body: { data } });
export const created = (data) => ({ status: 201, body: { data } });
export const noContent = () => ({ status: 204 });
export const failure = (status, code, message = "m") => ({ status, body: { error: { code, message, requestId: "r" } } });
