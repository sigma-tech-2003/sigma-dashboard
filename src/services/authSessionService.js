import { session } from "../auth/session.js";
import { SessionError } from "./authApiService.js";

// LoginPage's second sign-in step. Same names and the same message text as the Firebase version.
export { SessionError as AuthSessionError };

/**
 * Establishes the session user for the signed-in credentials, after the D37 role check (the role the person
 * picked must equal the role stored on the server). Resolves `{ employee, linkage: "uid" }` as before.
 *
 * With no `selectedRole` nothing is compared: that is a session restored on page load, which has no selection
 * to check against (D37). A mismatch throws AuthSessionError("permission-denied") and the session is revoked
 * before the user is ever published, so the app never renders for the wrong persona.
 */
export async function verifyAuthSession(selectedRole) {
  const employee = await session.establish(selectedRole);
  return { employee, linkage: "uid" };
}
