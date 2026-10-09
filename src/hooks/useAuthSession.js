import { useAuth } from "../auth/useAuth.js";

// LoginPage and AppProvider still import these two keys from here.
export const AUTH_ROLE_STORAGE_KEY = "sigma-hrm-selected-role";
export const AUTH_ROLE_ERROR_STORAGE_KEY = "sigma-hrm-role-error";

/**
 * { user, authReady, seeding }, as the Firebase-backed hook returned them, now from the auth context: a session
 * restored from the refresh cookie on boot (POST /auth/refresh, then GET /auth/me) or started by LoginPage.
 *
 * The role the person picked is no longer re-verified on every session start (D37): it is checked once, at sign-in,
 * by verifyAuthSession. A reload or a new tab restores the session without picking a role again.
 */
export function useAuthSession() {
  const { user, authReady, seeding } = useAuth();
  return { user, authReady, seeding };
}
