-- Phase 1 identity foundation: server-side refresh tokens.
--
-- Decision D10: short-lived access JWTs plus refresh tokens stored here, with the
-- per-request principal query also asserting the account is still active. Revoking a
-- refresh token stops the next refresh; the status assertion in the principal query is
-- what makes deactivation take effect immediately rather than at the next refresh.
--
-- token_hash holds a SHA-256 of the token, not an argon2 hash. Refresh tokens are
-- high-entropy random values, so they are not brute-forceable the way a password is and
-- do not need a memory-hard KDF. A fast digest also keeps lookup a single indexed probe.

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  CONSTRAINT refresh_tokens_hash_not_blank CHECK (length(btrim(token_hash)) > 0),
  CONSTRAINT refresh_tokens_expires_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT refresh_tokens_revoked_after_issue CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE UNIQUE INDEX refresh_tokens_hash_unique ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_user_live_index
  ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_expiry_index ON refresh_tokens (expires_at);
