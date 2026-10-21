import { api as defaultApi } from "./apiClient.js";

// The auth endpoints (D32, D37, D41), over the one API client. authService.js and authSessionService.js are the
// sign-in surface LoginPage imports, and both sit on top of the session built from this.

/**
 * Sign-in and session errors, with the message text the login page has always shown. authSessionService.js
 * re-exports this class as AuthSessionError.
 */
const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "invalid-argument": "Select a valid role before signing in.",
  "invalid-credentials": "Unable to sign in. Check your credentials and try again.",
  "permission-denied": "These credentials do not belong to the selected role.",
  "data-integrity": "Employee account data could not be verified. Contact an administrator.",
  unavailable: "Employee account verification is temporarily unavailable. Please try again.",
  internal: "Employee account verification could not be completed.",
});

export class SessionError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "internal";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "SessionError";
    this.code = safeCode;
  }
}

/** Maps a failed API call to a SessionError without leaking server detail. */
export function sessionErrorFrom(error) {
  if (error instanceof SessionError) return error;
  if (error?.name === "ApiError") {
    if (error.status === 401) return new SessionError("invalid-credentials");
    if (error.status === 0 || error.status >= 500) return new SessionError("unavailable");
  }
  return new SessionError("internal");
}

export function createAuthApiService(api = defaultApi) {
  return Object.freeze({
    /** POST /auth/login -> { principal }. Stores the access token; the refresh cookie is set by the response. */
    async login(email, password) {
      const data = await api.post("/auth/login", { email, password }, { auth: false });
      api.setAccessToken(data.accessToken);
      return data.principal;
    },

    /** POST /auth/refresh with the cookie (boot, D32) -> { principal }. Throws the API's 401 when there is no session. */
    async restore() {
      const data = await api.refreshSession();
      return data.principal;
    },

    /** GET /auth/me -> the raw profile (map it with mappers/profile.js). */
    me: () => api.get("/auth/me"),

    /** POST /auth/logout. Always forgets the token locally, even if the server call fails. */
    async logout() {
      try {
        await api.post("/auth/logout", undefined, { auth: false });
      } finally {
        api.clearSession();
      }
    },

    /**
     * POST /auth/change-password (D41): the owner replaces their own password. Authenticated, and the only call a
     * flagged account may make besides /auth/me. Every other session is ended by the server, so the response carries
     * a fresh access token (and the refresh cookie) exactly like login; it is stored here -> the new principal.
     */
    async changePassword(currentPassword, newPassword) {
      const data = await api.post("/auth/change-password", { current_password: currentPassword, new_password: newPassword });
      api.setAccessToken(data.accessToken);
      return data.principal;
    },

    onAuthLost: (listener) => api.onAuthLost(listener),
  });
}

export const authApiService = createAuthApiService();
