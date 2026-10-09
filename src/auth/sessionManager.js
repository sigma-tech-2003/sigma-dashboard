import { fromApi as profileFromApi } from "../services/mappers/profile.js";
import { SessionError, sessionErrorFrom } from "../services/authApiService.js";

// The session, as a small external store free of React so it runs under `node --test`. The AuthProvider is a
// thin shell that subscribes to it with useSyncExternalStore.
//
//   state       { user, authReady }   `user` is the session user the app already uses; null when signed out
//   restore()   POST /auth/refresh (the httpOnly cookie) -> GET /auth/me -> the user              (D32)
//   login()     authenticate() + establish(), the two steps LoginPage performs separately
//   logout()    POST /auth/logout, and the token is forgotten whatever the server says
//
// The role picker is NOT a security control (D37): authority comes from the role stored on the server. The
// check only guards against signing in as the wrong persona, runs at login only, and a restore has no
// selection to compare against. A wrong persona is never put into `state`, so the app never renders for it.

const isUnauthenticated = (error) => error?.name === "ApiError" && error.status === 401;

export function createSessionManager({ authApi }) {
  let state = { user: null, authReady: false };
  const listeners = new Set();
  let signedInPrincipal = null; // set by authenticate(), consumed by establish()
  let restoring = null;

  const setState = (patch) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  // A refresh that proves the session is gone (cookie expired or revoked) signs the user out.
  authApi.onAuthLost?.(() => setState({ user: null }));

  const quietLogout = async () => {
    signedInPrincipal = null;
    try {
      await authApi.logout();
    } catch {
      // The role is not a control, so a failed revoke leaves nothing worse than a session the user did not want.
    }
  };

  // A profile the app cannot trust is not a session: a malformed response, or an account with no employee record
  // (404), ends it. A network failure or a 5xx says nothing about the session, so it only reports "unavailable"
  // and leaves the session alone for a retry.
  async function loadUser() {
    try {
      return profileFromApi(await authApi.me());
    } catch (error) {
      const untrustworthy = error?.name === "MappingError"
        || (error?.name === "ApiError" && error.status >= 400 && error.status < 500);
      if (untrustworthy) {
        await quietLogout();
        throw new SessionError("data-integrity");
      }
      throw sessionErrorFrom(error);
    }
  }

  async function doRestore() {
    try {
      try {
        await authApi.restore();
      } catch (error) {
        if (isUnauthenticated(error)) {
          setState({ user: null, authReady: true });
          return null;
        }
        throw sessionErrorFrom(error);
      }
      const user = await loadUser();
      setState({ user, authReady: true });
      return user;
    } catch (error) {
      setState({ user: null, authReady: true });
      throw error;
    }
  }

  const manager = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The signed-in user, or null when there is no session. Concurrent calls share one run (StrictMode). */
    restore() {
      if (!restoring) restoring = doRestore().finally(() => { restoring = null; });
      return restoring;
    },

    /** Step 1 of sign-in: credentials. Holds the token but changes no state, so nothing renders yet. */
    async authenticate(email, password) {
      try {
        signedInPrincipal = await authApi.login(email, password);
      } catch (error) {
        throw sessionErrorFrom(error);
      }
      return signedInPrincipal;
    },

    /**
     * Step 2: the role check (D37) when a role was selected, then the profile, then the state. With no role, or
     * with no sign-in step before it (a restore), nothing is compared.
     */
    async establish(selectedRole) {
      if (selectedRole && signedInPrincipal && signedInPrincipal.role !== selectedRole) {
        await quietLogout();
        throw new SessionError("permission-denied");
      }
      signedInPrincipal = null;
      const user = await loadUser();
      setState({ user, authReady: true });
      return user;
    },

    async login({ email, password, selectedRole }) {
      if (!selectedRole) throw new SessionError("invalid-argument");
      await manager.authenticate(email, password);
      return manager.establish(selectedRole);
    },

    /** Re-reads the profile, e.g. after the user's own record changes (D32). */
    async refreshProfile() {
      const user = await loadUser();
      setState({ user });
      return user;
    },

    async logout() {
      signedInPrincipal = null;
      setState({ user: null });
      return authApi.logout();
    },
  };

  return Object.freeze(manager);
}
