-- D41 (docs/schema-design.md): whoever creates an employee sets a TEMPORARY password, and the employee is forced to
-- replace it the first time they sign in. This supersedes D25 and D34's set-password token flow.
--
-- Why a forced change exists at all: without it the creator permanently knows that employee's password, and nothing
-- done under the account could be attributed to the employee rather than to whoever created it. In a system holding
-- payroll that is not acceptable. (Honest limit, recorded in D41: it narrows the window to "creation until the
-- employee's first sign-in" and makes abuse detectable; it cannot stop a creator who signs in first.)
--
-- must_change_password: true from the moment a temporary password is set until the account's owner replaces it. The
-- API refuses everything except changing the password while it is true; this column is the single source of that.
--
-- password_set_by_employee_id: who set the password that is current NOW, when it was set for the employee rather than
-- by them. It records the window above, so it is attributable afterwards. It is left in place after the employee
-- changes their password on purpose: it is the history of who once knew the temporary one. SET NULL on delete so
-- removing the creator never blocks, and never removes the employee whose password it describes.
--
-- password_updated_at and last_login_at already exist on users (migration 001); password_updated_at is what the
-- access-token check compares against, so a token issued before a password change stops working at once.

ALTER TABLE users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN password_set_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

-- Finding "every account that is still on a temporary password" (an admin's follow-up list) is a partial-index probe.
CREATE INDEX users_must_change_password_index
  ON users (id) WHERE must_change_password AND deleted_at IS NULL;
