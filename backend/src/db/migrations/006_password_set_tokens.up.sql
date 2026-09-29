-- Phase 4 Part C: lets an invited employee set their password. employee-create leaves
-- users.status = 'invited' with no password_hash (employeeRepository.js's create()) --
-- there is no way in without this.
--
-- Deliberately its own table, not refresh_tokens: a different lifecycle (single-use, never
-- rotated, and revoked wholesale on reissue rather than individually) and a different
-- audience (an unauthenticated person redeeming an invite, not an already-logged-in
-- session). See docs/schema-design.md's decision entry for the full reasoning, including
-- why the token is handed back in an API response rather than emailed, the one-live-token-
-- per-user rule, and that this is explicitly an interim mechanism pending email
-- infrastructure and a frontend route.
--
-- token_hash holds a SHA-256 of the token, matching refresh_tokens' own reasoning exactly:
-- a high-entropy random value is not brute-forceable the way a password is, so a fast
-- digest is enough and keeps lookup a single indexed probe.

CREATE TABLE password_set_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  CONSTRAINT password_set_tokens_hash_not_blank CHECK (length(btrim(token_hash)) > 0),
  CONSTRAINT password_set_tokens_expires_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT password_set_tokens_used_after_issue CHECK (used_at IS NULL OR used_at >= issued_at),
  CONSTRAINT password_set_tokens_revoked_after_issue CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE UNIQUE INDEX password_set_tokens_hash_unique ON password_set_tokens (token_hash);
-- Used both to find "is there a live token for this user" (redemption) and to revoke it on
-- reissue -- the same query shape as refresh_tokens_user_live_index.
CREATE INDEX password_set_tokens_user_live_index
  ON password_set_tokens (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX password_set_tokens_expiry_index ON password_set_tokens (expires_at);
