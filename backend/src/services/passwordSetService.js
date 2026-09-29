import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../utils/httpError.js";
import { hashPassword } from "../utils/password.js";
import { COMPANY_WIDE_ROLES } from "../utils/roles.js";

/**
 * Lets an invited employee set their password (Phase 4 Part C). Deliberately its own
 * service, not folded into authService.js: issuing a token is an admin/hr action against
 * someone else's account, and redeeming one is a public, unauthenticated action -- neither
 * resembles login/refresh/logout's "already know who you are" shape.
 *
 * The generic error below is not a convenience wrapper -- it is the actual requirement.
 * Expired, already-used, and unknown tokens must be indistinguishable, the same way
 * authService.login already makes a wrong password and an unknown email indistinguishable.
 */
const invalidTokenError = () =>
  new HttpError(400, "invalid_token", "This link is invalid or has expired.");

function generateToken() {
  return randomBytes(32).toString("base64url");
}

/**
 * SHA-256, not argon2: a random 32-byte token is not brute-forceable the way a password is,
 * so a fast digest is enough and keeps redemption a single indexed lookup -- the same
 * reasoning tokenService.js's hashRefreshToken uses, duplicated rather than imported so this
 * table's hashing has no coupling to refresh_tokens' at all.
 */
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createPasswordSetService({ passwordSetTokenRepository, userRepository, passwordSetTokenTtlSeconds }) {
  return Object.freeze({
    /**
     * Admin/hr only -- deliberately narrower than "whoever may update this employee".
     * Minting a login credential is a materially bigger power than editing a phone number,
     * and nothing in auth-matrix.md grants a manager or tl that.
     *
     * @param {object} principal
     * @param {string} targetUserId - the invited employee's users.id (resolved by the
     *   caller from an employeeId; this service only knows about users).
     */
    async issueTokenForUser(principal, targetUserId) {
      if (!COMPANY_WIDE_ROLES.has(principal?.role)) {
        throw new HttpError(403, "role_not_allowed", "Only admin or hr may issue a set-password token.");
      }

      const user = await userRepository.findById(targetUserId);
      if (!user) throw new HttpError(404, "not_found", "User not found.");
      if (user.status !== "invited") {
        throw new HttpError(
          409,
          "not_invited",
          "A set-password token can only be issued for an invited account.",
        );
      }

      const token = generateToken();
      const expiresAt = new Date(Date.now() + passwordSetTokenTtlSeconds * 1000);
      await passwordSetTokenRepository.issueToken({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt,
      });

      // The token is returned here and only here -- see docs/schema-design.md's decision
      // entry for why (no email infrastructure, no frontend route to hand a link to yet).
      // It is never retrievable again; a lost token before delivery means issuing a new one.
      return { token, expiresAt };
    },

    /** Public: no principal, identity comes entirely from possessing the token. */
    async redeemToken(token, newPassword) {
      if (typeof token !== "string" || token.length === 0) throw invalidTokenError();

      const passwordHash = await hashPassword(newPassword);
      const result = await passwordSetTokenRepository.redeemToken(hashToken(token), passwordHash);
      if (!result) throw invalidTokenError();
    },
  });
}
