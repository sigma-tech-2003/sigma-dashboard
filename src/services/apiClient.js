import { API_BASE_URL } from "../config/api.js";

// The single client for the Postgres-backed API. Pure JavaScript with injectable `fetch` and lock, so it runs in
// plain Node under `node --test`; nothing here touches React, Firebase or web storage.
//
//   - Every call sends `credentials: "include"` so the httpOnly refresh cookie travels.
//   - The access token lives in MEMORY only. It is short-lived (15 minutes) and is never written to local or
//     session storage; a reload recovers it through POST /auth/refresh and the cookie.
//   - A 401 on an authenticated call triggers ONE refresh and ONE retry. A second 401 is returned, never looped.
//   - Refresh tokens are single-use and rotate with no grace window (backend authService.refresh): presenting the
//     same cookie twice signs the user out. So refreshes are single-flight within a tab (React StrictMode runs the
//     boot effect twice; several requests can 401 at once) and wrapped in a Web Lock across tabs, where the
//     second tab then presents the cookie the first tab already rotated.

const AUTH_LOCK_NAME = "sigma-hrm-auth-refresh";

export class ApiError extends Error {
  constructor({ status, code, message, details, requestId }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

// Cross-tab serialisation where the browser supports it; a plain call elsewhere (older browsers, Node).
const defaultWithLock = (task) => {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(AUTH_LOCK_NAME, task) : task();
};

const parseEnvelope = (text) => {
  try {
    return text ? JSON.parse(text)?.error : null;
  } catch {
    return null;
  }
};

const apiErrorFromResponse = (status, text) => {
  const envelope = parseEnvelope(text);
  if (envelope && typeof envelope.code === "string") {
    return new ApiError({
      status,
      code: envelope.code,
      message: typeof envelope.message === "string" ? envelope.message : "The request could not be completed.",
      details: envelope.details,
      requestId: envelope.requestId,
    });
  }
  // Not the API's envelope: a gateway or proxy answered (a 502 page from the rewrite, say).
  return new ApiError({
    status,
    code: status >= 500 ? "unavailable" : "unexpected_response",
    message: status >= 500
      ? "The service is temporarily unavailable. Please try again."
      : "The server returned an unexpected response.",
  });
};

export function createApiClient({ baseUrl = API_BASE_URL, fetchImpl, withLock = defaultWithLock } = {}) {
  let accessToken = null;
  let refreshing = null;
  const authLostListeners = new Set();

  const callFetch = (url, init) => (fetchImpl ?? globalThis.fetch)(url, init);

  const buildUrl = (path, query) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    }
    const queryString = search.toString();
    return `${baseUrl}${path}${queryString ? `?${queryString}` : ""}`;
  };

  async function send(method, path, { body, query, signal, token }) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await callFetch(buildUrl(path, query), {
        method,
        headers,
        credentials: "include",
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError({
        status: 0,
        code: "network",
        message: "Unable to connect. Check your connection and try again.",
      });
    }

    if (response.status === 204) return undefined;

    const text = await response.text();
    if (!response.ok) throw apiErrorFromResponse(response.status, text);

    // A 2xx that is not the API's JSON means a misrouted request (a SPA fallback page, a proxy): fail loudly
    // rather than hand HTML to a mapper.
    try {
      return JSON.parse(text).data;
    } catch {
      throw new ApiError({
        status: response.status,
        code: "unexpected_response",
        message: "The server returned an unexpected response.",
      });
    }
  }

  async function performRefresh() {
    const hadSession = accessToken !== null;
    try {
      const data = await send("POST", "/auth/refresh", {});
      accessToken = data.accessToken;
      return data;
    } catch (error) {
      accessToken = null;
      // Only a 401 means the session is gone. A network failure or a 5xx says nothing about it, and must not
      // sign the user out.
      if (error instanceof ApiError && error.status === 401 && hadSession) {
        for (const listener of [...authLostListeners]) listener();
      }
      throw error;
    }
  }

  /** Single-flight, and serialised across tabs. Resolves `{ accessToken, expiresIn, principal }`. */
  function refreshSession() {
    if (!refreshing) {
      refreshing = Promise.resolve()
        .then(() => withLock(performRefresh))
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function request(method, path, options = {}) {
    const authenticated = options.auth !== false;
    const tokenSent = authenticated ? accessToken : null;
    const attempt = (token) => send(method, path, { ...options, token });

    try {
      return await attempt(tokenSent);
    } catch (error) {
      if (!(authenticated && error instanceof ApiError && error.status === 401)) throw error;

      // If another request already replaced the token while this one was in flight, just retry with it.
      if (accessToken !== null && accessToken !== tokenSent) return attempt(accessToken);

      try {
        await refreshSession();
      } catch (refreshError) {
        throw refreshError instanceof ApiError && refreshError.status === 401 ? error : refreshError;
      }
      return attempt(accessToken);
    }
  }

  return Object.freeze({
    request,
    get: (path, options) => request("GET", path, options),
    post: (path, body, options) => request("POST", path, { ...options, body }),
    patch: (path, body, options) => request("PATCH", path, { ...options, body }),
    delete: (path, body, options) => request("DELETE", path, { ...options, body }),
    refreshSession,
    setAccessToken(token) { accessToken = token ?? null; },
    getAccessToken: () => accessToken,
    clearSession() { accessToken = null; },
    /** Called when a refresh proves the session is gone. Returns an unsubscribe function. */
    onAuthLost(listener) {
      authLostListeners.add(listener);
      return () => authLostListeners.delete(listener);
    },
  });
}

export const api = createApiClient();
