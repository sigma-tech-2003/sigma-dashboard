-- D41 (docs/schema-design.md) removes the set-password token flow that migration 006 built for D25 and D34: an
-- employee now receives a temporary password at creation (migration 012) instead of a one-time link.
--
-- Nothing of value is lost. A token is short-lived and single-use, and the table only ever held a SHA-256 of tokens
-- that were already expired, used or revoked, or would have expired within 24 hours. Migration 006 is already
-- applied and is never edited, so this is a new migration; 006 stays in history exactly as it was.

DROP TABLE IF EXISTS password_set_tokens;
