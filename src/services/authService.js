import { session } from "../auth/session.js";

// The sign-in surface LoginPage, AppProvider and EmployeesPage import (their call sites are unchanged), now over
// the API. Sign-in is two steps in LoginPage (signIn, then verifyAuthSession in authSessionService.js); both act
// on the one shared session, so the app only learns of a user once the role check has passed.

const PASSWORD_SETUP_ERROR_MESSAGES = {
  "invalid-email": "Enter a valid email address.",
  "not-supported":
    "An administrator issues a setup link for the employee instead.",
  internal: "Password setup could not be completed. Please try again.",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class EmployeePasswordSetupError extends Error {
  constructor(code) {
    const safeCode = PASSWORD_SETUP_ERROR_MESSAGES[code] ? code : "internal";
    super(PASSWORD_SETUP_ERROR_MESSAGES[safeCode]);
    this.name = "EmployeePasswordSetupError";
    this.code = safeCode;
  }
}

/** POST /auth/login. Resolves `{ user }` so the caller can tell a session was started (and revoke it on a role mismatch). */
export async function signIn(email, password) {
  const principal = await session.authenticate(email, password);
  return { user: principal };
}

/** POST /auth/logout. The local session is gone whatever the server says. */
export async function signOutUser() {
  try {
    await session.logout();
  } catch {
    // Already signed out locally; a failed revoke call changes nothing the user can act on.
  }
}

/**
 * Firebase sent a password-reset email here. The API sends none: an admin or hr issues a single-use setup link
 * and passes it on (D25, D34), which is `employeeService.issuePasswordSetupLink`. EmployeesPage still calls
 * this after creating an employee, so it fails honestly rather than claim an email went out; the page needs
 * the D34 change to show the link.
 */
export async function sendEmployeePasswordSetupEmail(email) {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalizedEmail || !EMAIL_PATTERN.test(normalizedEmail)) {
    throw new EmployeePasswordSetupError("invalid-email");
  }
  throw new EmployeePasswordSetupError("not-supported");
}
