-- Reverses 013_drop_password_set_tokens.up.sql: recreates the table exactly as migration 006 defined it (empty: the
-- tokens it held were short-lived and are not restored).
--
-- As with 001-012, this file is only reachable through `npm run db:rollback`, which
-- requires --confirm-database=<name>.

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
CREATE INDEX password_set_tokens_user_live_index
  ON password_set_tokens (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX password_set_tokens_expiry_index ON password_set_tokens (expires_at);

-- Clear this migration's ledger row, matching the established convention.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE id = '013_drop_password_set_tokens';
  END IF;
END $$;
