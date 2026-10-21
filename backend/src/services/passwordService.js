import { HttpError } from "../utils/httpError.js";
import { hashPassword, verifyPassword } from "../utils/password.js";

/**
 * An account's owner replacing their own password (D41). This is the only way out of must_change_password, and the
 * second half of what makes a temporary password safe to hand over: the person who set it stops being able to use it.
 *
 * (Resetting SOMEONE ELSE's password is employeeMutationService.resetPassword, because it needs the employee row and
 * the role hierarchy; this service only ever deals with the caller's own account.)
 *
 * @param {{ userRepository: object, authService: object, hash?: Function, verify?: Function }} dependencies
 *   `hash` and `verify` are injectable so tests do not pay argon2's cost.
 */
export function createPasswordService({ userRepository, authService, hash = hashPassword, verify = verifyPassword }) {
  return Object.freeze({
    /**
     * Verifies the current password, replaces it, and starts a fresh session. Returns the same shape as login
     * (`{ principal, accessToken, refreshToken, expiresIn }`) so the employee carries straight on without signing in
     * again; every OTHER session is gone, because replaceOwnPassword revokes all refresh tokens and the principal
     * query refuses access tokens issued before the change.
     */
    async changeOwnPassword(principal, { currentPassword, newPassword }) {
      const storedHash = await userRepository.findPasswordHash(principal.userId);

      // 403, deliberately NOT 401: the client reads a 401 as "your session is gone" and tries to refresh it. A wrong
      // current password is a refusal of this request, not the loss of the session.
      if (!(await verify(storedHash, currentPassword))) {
        throw new HttpError(403, "current_password_incorrect", "The current password is incorrect.");
      }

      // The point of the forced change is that the creator no longer knows the password. "Change" it to the same
      // string and they still do.
      if (await verify(storedHash, newPassword)) {
        throw new HttpError(400, "password_unchanged", "The new password must be different from the current one.");
      }

      const changed = await userRepository.replaceOwnPassword(principal.userId, await hash(newPassword));
      if (!changed) throw new HttpError(401, "unauthenticated", "Authentication is required.");

      return authService.startSession(principal.userId);
    },
  });
}
