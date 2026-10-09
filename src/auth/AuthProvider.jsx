import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AuthContext } from "./context.js";
import { session } from "./session.js";

// Replaces the Firebase auth-state listener (useAuthSession.js). All of the session logic is in
// sessionManager.js, where it is tested without React; this component subscribes to it and restores a session
// on boot (POST /auth/refresh, then GET /auth/me).

export function AuthProvider({ children }) {
  const { user, authReady } = useSyncExternalStore(session.subscribe, session.getState, session.getState);

  // React StrictMode runs this twice in development; restore() shares one run between concurrent callers, so
  // the single-use refresh cookie is presented once.
  useEffect(() => {
    session.restore().catch(() => {
      // A failure that says nothing about the session (offline, 5xx) leaves the user signed out; the state is
      // already settled by restore() and the login page offers a retry.
    });
  }, []);

  const value = useMemo(() => ({
    user,
    authReady,
    seeding: false,
    login: session.login,
    logout: session.logout,
    refreshProfile: session.refreshProfile,
  }), [user, authReady]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
