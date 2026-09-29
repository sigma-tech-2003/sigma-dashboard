/**
 * Backs the invited-employee set-password flow (migration 006). Deliberately separate from
 * refreshTokenRepository.js -- a different lifecycle (single-use, revoked wholesale on
 * reissue rather than rotated individually) and a different audience (an unauthenticated
 * person redeeming an invite). See docs/schema-design.md's decision entry.
 */
export function createPasswordSetTokenRepository(database) {
  return Object.freeze({
    /**
     * Revokes any still-live token for this user, then issues a new one, in one
     * transaction -- the one-live-token-per-user rule. A lost token before it reaches the
     * employee is handled by simply issuing again, not by trying to retrieve the old one.
     */
    async issueToken({ userId, tokenHash, expiresAt }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `UPDATE password_set_tokens SET revoked_at = now()
           WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
          [userId],
        );

        const { rows: [created] } = await client.query(
          `INSERT INTO password_set_tokens (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)
           RETURNING id, user_id, expires_at`,
          [userId, tokenHash, expiresAt],
        );

        await client.query("COMMIT");
        return created;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    /**
     * Redeems a token: sets the new password, activates the account, consumes the token,
     * and revokes every outstanding refresh token for that user -- if an invited account
     * somehow already had a live session, setting a password ends it rather than leaving it
     * running alongside the new credential. All in one transaction.
     *
     * Returns null for anything that isn't a currently-live token (unknown hash, already
     * used, revoked by a later reissue, or expired) -- deliberately one shape for all of
     * those, so the caller cannot construct a response that reveals which applied.
     */
    async redeemToken(tokenHash, passwordHash) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [token] } = await client.query(
          `SELECT id, user_id FROM password_set_tokens
           WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
          [tokenHash],
        );
        if (!token) {
          await client.query("ROLLBACK");
          return null;
        }

        await client.query(
          `UPDATE users SET password_hash = $1, status = 'active', password_updated_at = now()
           WHERE id = $2`,
          [passwordHash, token.user_id],
        );
        await client.query(
          "UPDATE password_set_tokens SET used_at = now() WHERE id = $1",
          [token.id],
        );
        await client.query(
          "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
          [token.user_id],
        );

        await client.query("COMMIT");
        return { userId: token.user_id };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
