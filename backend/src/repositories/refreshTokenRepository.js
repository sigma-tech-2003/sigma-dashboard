export function createRefreshTokenRepository(database) {
  return Object.freeze({
    async store({ userId, tokenHash, expiresAt }) {
      const { rows } = await database.query(
        `
        INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
        VALUES ($1, $2, $3)
        RETURNING id, user_id, expires_at
        `,
        [userId, tokenHash, expiresAt],
      );
      return rows[0];
    },

    /** Live means: not revoked and not expired. Expiry is evaluated by the database. */
    async findLiveByHash(tokenHash) {
      const { rows } = await database.query(
        `
        SELECT id, user_id, expires_at
        FROM refresh_tokens
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > now()
        `,
        [tokenHash],
      );
      return rows[0] || null;
    },

    async revokeById(id) {
      const { rowCount } = await database.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
        [id],
      );
      return rowCount;
    },

    /**
     * Used on logout-everywhere, and on deactivation so a suspended account cannot mint a
     * new access token. Note this is belt and braces: the principal query already refuses
     * an inactive account, so revoking here closes the refresh path rather than the
     * request path.
     */
    async revokeAllForUser(userId) {
      const { rowCount } = await database.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [userId],
      );
      return rowCount;
    },
  });
}
