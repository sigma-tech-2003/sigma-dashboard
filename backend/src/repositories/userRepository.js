/**
 * Identity reads. The principal query here is the enforcement point for decision D10:
 * because it asserts the account is still active on every request, deactivating an
 * employee ends their session immediately rather than at token expiry.
 */
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
    async findPrincipalByUserId(userId) {
      const { rows } = await database.query(
        `
        SELECT u.id            AS user_id,
               e.id            AS employee_id,
               u.role          AS role,
               e.department_id AS department_id
        FROM users u
        JOIN employees e ON e.user_id = u.id
        WHERE u.id = $1
          AND u.status = 'active'
          AND u.deleted_at IS NULL
          AND e.deleted_at IS NULL
          AND e.employment_status = 'active'
        `,
        [userId],
      );

      const row = rows[0];
      if (!row) return null;

      return Object.freeze({
        userId: row.user_id,
        employeeId: row.employee_id,
        role: row.role,
        departmentId: row.department_id,
        isTeamLead: row.role === "tl",
      });
    },

    async touchLastLogin(userId) {
      await database.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
    },
  });
}
