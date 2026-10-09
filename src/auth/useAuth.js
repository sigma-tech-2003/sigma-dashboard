import { useContext } from "react";
import { AuthContext } from "./context.js";

/**
 * { user, authReady, seeding, login, logout, refreshProfile }
 *
 * `user`, `authReady` and `seeding` are the same three values the Firebase-backed `useAuthSession()` returns, so
 * at cutover `AppProvider` swaps one hook for the other and nothing downstream changes.
 */
export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }

  return context;
}
