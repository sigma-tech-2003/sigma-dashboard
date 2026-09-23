/**
 * Creates the very first admin in an empty database: one companies row, one department, one
 * user, one employee. The only writer of `role = 'admin'` accounts that isn't itself gated by
 * an existing admin -- so it refuses outright unless the database is genuinely empty of both
 * companies and users, checked before any insert, inside the same transaction as the writes.
 *
 * Mirrors firestoreImportRepository.js's transaction shape: one BEGIN/COMMIT/ROLLBACK, a
 * single database.connect() client released in a finally.
 */
export function createBootstrapRepository(database) {
  return Object.freeze({
    async createFirstAdmin({ email, passwordHash, companyName, companyCode, departmentName, fullName, positionTitle }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [{ company_count: companyCount, user_count: userCount }] } = await client.query(`
          SELECT (SELECT COUNT(*) FROM companies)::int AS company_count,
                 (SELECT COUNT(*) FROM users)::int     AS user_count
        `);
        // Checked up front, before any insert: a users-only check would still let a leftover
        // companies row from a partial run crash the insert below on companies_singleton with
        // a raw unique-violation instead of a clear refusal.
        if (companyCount > 0) {
          throw new Error(
            "Refusing to bootstrap: a companies row already exists. This script is only for "
            + "the very first admin in an empty database.",
          );
        }
        if (userCount > 0) {
          throw new Error(
            `Refusing to bootstrap: ${userCount} user(s) already exist. This script is only `
            + "for the very first admin in an empty database.",
          );
        }

        const { rows: [{ id: companyId }] } = await client.query(
          "INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id",
          [companyName, companyCode],
        );

        const { rows: [{ id: departmentId }] } = await client.query(
          "INSERT INTO departments (company_id, name) VALUES ($1, $2) RETURNING id",
          [companyId, departmentName],
        );

        // status = 'active' explicitly: the column default is 'invited', which
        // userRepository.findPrincipalByUserId's join would silently reject at login.
        const { rows: [{ id: userId }] } = await client.query(
          `INSERT INTO users (company_id, email, password_hash, role, status)
           VALUES ($1, $2, $3, 'admin', 'active')
           RETURNING id`,
          [companyId, email, passwordHash],
        );

        const { rows: [{ employee_number: employeeNumber }] } = await client.query(
          "SELECT next_employee_number() AS employee_number",
        );

        // employment_status defaults to 'active' (001), matching what
        // findPrincipalByUserId's join requires -- no need to set it explicitly.
        const { rows: [{ id: employeeId }] } = await client.query(
          `INSERT INTO employees
             (user_id, company_id, department_id, employee_number, full_name, position_title, joined_on)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE)
           RETURNING id`,
          [userId, companyId, departmentId, employeeNumber, fullName, positionTitle],
        );

        await client.query("COMMIT");
        return { companyId, departmentId, userId, employeeId, employeeNumber };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
