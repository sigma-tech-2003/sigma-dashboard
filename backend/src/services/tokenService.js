import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { HttpError } from "../utils/httpError.js";

const ALGORITHM = "HS256";

/**
 * Access tokens carry only the subject. Role, department and team-lead scope are NOT in
 * the token: under decision D10 the principal is resolved from the database on every
 * request, so embedding claims would let a stale role or department survive a change
 * until the token expired. The token answers "who", the database answers "what they may
 * do right now".
 */
export function createTokenService(authConfig) {
  const { secret, issuer, audience, accessTokenTtlSeconds, refreshTokenTtlSeconds } = authConfig;

  return Object.freeze({
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,

    issueAccessToken(userId) {
      return jwt.sign({}, secret, {
        algorithm: ALGORITHM,
        subject: userId,
        issuer,
        audience,
        expiresIn: accessTokenTtlSeconds,
      });
    },

    /** Returns the subject (user id). Throws HttpError 401 for anything unusable. */
    verifyAccessToken(token) {
      try {
        // algorithms is pinned explicitly. Without it, a token with alg:"none" or a
        // token signed with a different family would be considered.
        const claims = jwt.verify(token, secret, {
          algorithms: [ALGORITHM],
          issuer,
          audience,
        });
        if (!claims?.sub) {
          throw new HttpError(401, "unauthenticated", "Authentication is required.");
        }
        return claims.sub;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(401, "unauthenticated", "Authentication is required.");
      }
    },

    /**
     * Refresh tokens are 256 bits of randomness, stored as a SHA-256 digest. They are not
     * passwords: there is no low-entropy secret to protect, so a memory-hard KDF would
     * cost latency on every refresh and buy nothing. The digest also makes lookup a
     * single indexed probe.
     */
    issueRefreshToken() {
      const token = randomBytes(32).toString("base64url");
      return {
        token,
        tokenHash: hashRefreshToken(token),
        expiresAt: new Date(Date.now() + refreshTokenTtlSeconds * 1000),
      };
    },
  });
}

export function hashRefreshToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison, for callers comparing digests directly. */
export function digestsMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
