/**
 * Identity reads. The principal query here is the enforcement point for decision D10:
 * because it asserts the account is still active on every request, deactivating an
 * employee ends their session immediately rather than at token expiry.
 */
async function replacePassword(database, userId, { passwordHash, mustChange, setByEmployeeId }) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE users
       SET password_hash = $2,
           must_change_password = $3,
           password_set_by_employee_id = CASE WHEN $3 THEN $4::uuid ELSE password_set_by_employee_id END,
           password_updated_at = now(),
           status = CASE WHEN status = 'invited' THEN 'active'::account_status ELSE status END,
           updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [userId, passwordHash, mustChange, setByEmployeeId ?? null],
    );
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createUserRepository(database) {
  return Object.freeze({
    /** Login lookup. Returns the password hash, so callers must not leak the row. */
    async findAuthenticatableByEmail(email) {
      const { rows } = await database.query(
        `
        SELECT u.id, u.email, u.password_hash, u.role, u.status
        FROM users u
        WHERE lower(u.email) = lower($1)
          AND u.deleted_at IS NULL
        `,
        [email],
      );
      return rows[0] || null;
    },

    /**
     * The principal from docs/schema-design.md section 6:
     * { userId, employeeId, role, departmentId, isTeamLead }
     *
     * Returns null when the account is no longer usable, which is what makes revocation
     * immediate. Four conditions must all hold:
     *   - the user row is active and not soft-deleted
     *   - the employee row is not soft-deleted
     *   - employment is active
     * Firestore expressed this as a single `status == 'active'` check on the employee
     * document (hasActiveEmployeeIdentity, firestore.rules:88-104). The Postgres schema
     * splits account status from employment status, so both are asserted.
     */
    async findPrincipalByUserId(userId, issuedAt = null) {
      // `issuedAt` is the access token's issue time in whole seconds (null at login and refresh, where there is no
      // token yet). A token issued BEFORE the password last changed is refused (D41): the password may have been
      // known to someone else, and changing it must end sessions opened under it. Whole seconds, `<=`, so the token
      // handed back by the change itself (same second) stays valid.
      const { rows } = await database.query(
        `
        SELECT u.id                   AS user_id,
               e.id                   AS employee_id,
               u.role                 AS role,
               e.department_id        AS department_id,
               u.must_change_password AS must_change_password
        FROM users u
        JOIN employees e ON e.user_id = u.id
        WHERE u.id = $1
          AND u.status = 'active'
          AND u.deleted_at IS NULL
          AND e.deleted_at IS NULL
          AND e.employment_status = 'active'
          AND ($2::bigint IS NULL
               OR u.password_updated_at IS NULL
               OR floor(extract(epoch FROM u.password_updated_at)) <= $2::bigint)
        `,
        [userId, issuedAt],
      );

      const row = rows[0];
      if (!row) return null;

      return Object.freeze({
        userId: row.user_id,
        employeeId: row.employee_id,
        role: row.role,
        departmentId: row.department_id,
        isTeamLead: row.role === "tl",
        // While true the API refuses everything but changing the password (D41).
        mustChangePassword: row.must_change_password === true,
      });
    },

    async touchLastLogin(userId) {
      await database.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
    },

    /** The stored hash, for verifying the CURRENT password before it is replaced. Callers must not leak it. */
    async findPasswordHash(userId) {
      const { rows } = await database.query(
        "SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL",
        [userId],
      );
      return rows[0]?.password_hash ?? null;
    },

    /**
     * The account's OWNER replaces their password (D41): clears must_change_password, stamps password_updated_at,
     * and revokes every refresh token, all in one transaction so a half-done change cannot leave old sessions alive.
     * password_set_by_employee_id is left as it was on purpose: it is the record of who once knew the temporary one.
     * Returns false when the user does not exist.
     */
    async replaceOwnPassword(userId, passwordHash) {
      return replacePassword(database, userId, { passwordHash, mustChange: false });
    },

    /**
     * Somebody ELSE sets a temporary password (D41): an admin or hr resetting it. (At creation it goes through
     * employeeRepository.create instead.) Sets must_change_password, records who did it, stamps password_updated_at,
     * and revokes the target's refresh tokens. Returns false when the user does not exist.
     */
    async setTemporaryPassword(userId, passwordHash, setByEmployeeId) {
      return replacePassword(database, userId, { passwordHash, mustChange: true, setByEmployeeId });
    },
  });
}
