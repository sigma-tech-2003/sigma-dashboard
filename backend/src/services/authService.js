import { HttpError } from "../utils/httpError.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { createTokenService, hashRefreshToken } from "./tokenService.js";

const unauthenticated = () =>
  new HttpError(401, "unauthenticated", "Authentication is required.");

/**
 * Login, refresh, logout, and the verifyAccessToken that
 * middleware/authentication.js has always required but never had.
 *
 * The shape of verifyAccessToken is what makes decision D10 work: it validates the token
 * signature and then resolves the principal from the database, so an account that has
 * been deactivated since the token was issued is rejected on its very next request. The
 * token proves identity; the database decides whether that identity is still allowed in.
 */
export function createAuthService({ authConfig, userRepository, refreshTokenRepository }) {
  const tokens = createTokenService(authConfig);

  async function resolvePrincipal(userId) {
    const principal = await userRepository.findPrincipalByUserId(userId);
    if (!principal) throw unauthenticated();
    return principal;
  }

  return Object.freeze({
    tokens,

    async verifyAccessToken(token) {
      const userId = tokens.verifyAccessToken(token);
      return resolvePrincipal(userId);
    },

    async login({ email, password }) {
      const user = await userRepository.findAuthenticatableByEmail(email ?? "");

      // Verify against a dummy hash when the user is absent, so a missing account and a
      // wrong password take comparable time and cannot be distinguished by timing.
      const storedHash = user?.password_hash ?? null;
      const passwordMatches = await verifyPassword(storedHash, password ?? "");

      if (!user || !passwordMatches) throw unauthenticated();
      if (user.status !== "active") throw unauthenticated();

      // Resolving the principal here applies the same active-account assertion used on
      // every subsequent request, so a deactivated employee cannot obtain a token at all.
      const principal = await resolvePrincipal(user.id);

      const accessToken = tokens.issueAccessToken(user.id);
      const refresh = tokens.issueRefreshToken();
      await refreshTokenRepository.store({
        userId: user.id,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      });
      await userRepository.touchLastLogin(user.id);

      return {
        principal,
        accessToken,
        refreshToken: refresh.token,
        expiresIn: tokens.accessTokenTtlSeconds,
      };
    },

    /**
     * Rotates the refresh token: the presented one is revoked and a new one issued, so a
     * stolen refresh token is usable at most once before the legitimate holder's next
     * refresh invalidates it.
     */
    async refresh({ refreshToken }) {
      if (typeof refreshToken !== "string" || refreshToken.length === 0) {
        throw unauthenticated();
      }

      const stored = await refreshTokenRepository.findLiveByHash(hashRefreshToken(refreshToken));
      if (!stored) throw unauthenticated();

      const principal = await resolvePrincipal(stored.user_id);

      await refreshTokenRepository.revokeById(stored.id);
      const next = tokens.issueRefreshToken();
      await refreshTokenRepository.store({
        userId: stored.user_id,
        tokenHash: next.tokenHash,
        expiresAt: next.expiresAt,
      });

      return {
        principal,
        accessToken: tokens.issueAccessToken(stored.user_id),
        refreshToken: next.token,
        expiresIn: tokens.accessTokenTtlSeconds,
      };
    },

    async logout({ refreshToken }) {
      if (typeof refreshToken !== "string" || refreshToken.length === 0) return 0;
      const stored = await refreshTokenRepository.findLiveByHash(hashRefreshToken(refreshToken));
      if (!stored) return 0;
      return refreshTokenRepository.revokeById(stored.id);
    },

    async logoutEverywhere(userId) {
      return refreshTokenRepository.revokeAllForUser(userId);
    },

    hashPassword,
  });
}
