import { session } from "../auth/session.js";

// The sign-in surface LoginPage and AppProvider import (their call sites are unchanged), now over the API.
// Sign-in is two steps in LoginPage (signIn, then verifyAuthSession in authSessionService.js); both act on the one
// shared session, so the app only learns of a user once the role check has passed.

const PASSWORD_CHANGE_ERROR_MESSAGES = {
  "current-incorrect": "The current password is incorrect.",
  "password-unchanged": "Choose a password different from the temporary one.",
  "invalid-password": "Choose a new password of 8 to 200 characters.",
  "missing-current": "Enter your current password.",
  unavailable: "Unable to connect. Check your connection and try again.",
  internal: "Your password could not be changed. Please try again.",
};

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

export class PasswordChangeError extends Error {
  constructor(code) {
    const safeCode = PASSWORD_CHANGE_ERROR_MESSAGES[code] ? code : "internal";
    super(PASSWORD_CHANGE_ERROR_MESSAGES[safeCode]);
    this.name = "PasswordChangeError";
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
 * D41: the signed-in person replaces their own password (POST /auth/change-password). This is the forced change after
 * a creator or an admin set a temporary one, and it works the same any time. The lengths are checked here first so a
 * 400 from the server can only mean what it says. A wrong CURRENT password is a 403 (never a 401, which the client
 * would read as a lost session), so it surfaces as its own message.
 */
export async function changeOwnPassword(currentPassword, newPassword) {
  if (typeof currentPassword !== "string" || currentPassword === "") throw new PasswordChangeError("missing-current");
  if (typeof newPassword !== "string" || newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > PASSWORD_MAX_LENGTH) {
    throw new PasswordChangeError("invalid-password");
  }

  try {
    await session.changePassword(currentPassword, newPassword);
  } catch (error) {
    if (error?.name === "ApiError") {
      if (error.code === "current_password_incorrect") throw new PasswordChangeError("current-incorrect");
      if (error.code === "password_unchanged") throw new PasswordChangeError("password-unchanged");
      if (error.code === "invalid_request") throw new PasswordChangeError("invalid-password");
      // Only "could not reach it" is unavailable; a server that answered with an error is a different message.
      if (error.status === 0 || error.code === "unavailable") throw new PasswordChangeError("unavailable");
    }
    throw new PasswordChangeError("internal");
  }
}
