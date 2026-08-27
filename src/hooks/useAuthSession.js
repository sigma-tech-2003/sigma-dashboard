import { useEffect, useState } from "react";
import { observeAuthState, signOutUser } from "../services/authService";
import {
  AuthSessionError,
  verifyAuthSession,
} from "../services/authSessionService";

export const AUTH_ROLE_STORAGE_KEY = "sigma-hrm-selected-role";
export const AUTH_ROLE_ERROR_STORAGE_KEY = "sigma-hrm-role-error";

const safeVerificationError = (error) =>
  error instanceof AuthSessionError
    ? error
    : new AuthSessionError("internal");

const attemptSignOut = () => {
  try {
    return Promise.resolve(signOutUser()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
};

export function useAuthSession() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const unsubscribe = observeAuthState(async (firebaseUser) => {
      if (firebaseUser) {
        setUser(null);
        try {
          const selectedRole = sessionStorage.getItem(AUTH_ROLE_STORAGE_KEY);
          const principal = await verifyAuthSession(selectedRole);
          if (principal?.linkage !== "uid" || !principal.employee) {
            throw new AuthSessionError("data-integrity");
          }

          setUser(principal.employee);
        } catch (error) {
          const verificationError = safeVerificationError(error);
          const signOutPromise = attemptSignOut();

          setUser(null);
          try {
            sessionStorage.removeItem(AUTH_ROLE_STORAGE_KEY);
            sessionStorage.setItem(AUTH_ROLE_ERROR_STORAGE_KEY, verificationError.code);
          } catch {
            // Sign-out still proceeds when session storage is unavailable.
          }
          await signOutPromise;
        }
      } else {
        setUser(null);
      }
      setAuthReady(true);
    });

    return unsubscribe;
  }, []);

  return { user, authReady, seeding: false };
}
