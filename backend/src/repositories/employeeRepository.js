import { HttpError } from "../utils/httpError.js";
import { buildEmployeeScopeFilter } from "../services/employeeScopeService.js";

const EMPLOYEE_COLUMNS = `
  employees.id,
  employees.user_id,
  employees.company_id,
  employees.department_id,
  employees.team_lead_id,
  employees.employee_number,
  employees.full_name,
  employees.phone,
  employees.position_title,
  employees.employment_status,
  employees.joined_on,
  employees.basic,
  employees.allowances,
  employees.created_at,
  employees.updated_at
`;
// basic/allowances are included for whoever the scope predicate already lets see the row --
// Firestore has no field-level security, only document-level, so a manager viewing their
// department sees full compensation there today. This is parity, not a new exposure
// (docs/migration-plan.md Phase 3). PAYROLL_ROLES still gates who may WRITE these fields.

/** employees.<key> for changes that belong on the employees row. */
const EMPLOYEE_UPDATE_COLUMNS = Object.freeze([
  "full_name", "phone", "department_id", "team_lead_id",
  "position_title", "employment_status", "joined_on", "basic", "allowances",
]);
/** users.<key> for changes that belong on the users row -- role moved tables (D6). */
const USER_UPDATE_COLUMNS = Object.freeze(["role", "email"]);

/**
 * Maps a Postgres constraint-violation into the same clean HttpError shape every other
 * write path in this API already uses, instead of letting a raw pg error surface as an
 * opaque 500. Anything not recognized is rethrown as-is -- an unrecognized constraint name
 * is a schema change this function has not caught up with, not something to paper over with
 * a generic message that could hide a real bug.
 */
function translateWriteError(error) {
  if (error?.code === "23505") { // unique_violation
    if (error.constraint === "users_email_unique") {
      return new HttpError(409, "email_already_exists", "An account with this email already exists.");
    }
    if (error.constraint === "employees_number_unique") {
      return new HttpError(409, "conflict", "This employee number is already in use.");
    }
    return new HttpError(409, "conflict", "This record already exists.");
  }
  if (error?.code === "23503") { // foreign_key_violation
    if (error.constraint === "employees_department_company_foreign_key") {
      return new HttpError(400, "invalid_department", "department_id does not reference an existing department.");
    }
    if (error.constraint === "employees_team_lead_department_foreign_key") {
      return new HttpError(400, "invalid_team_lead", "team_lead_id does not reference a valid team lead in this department.");
    }
    return new HttpError(400, "invalid_reference", "This request references a record that does not exist.");
  }
  if (error?.code === "23514") { // check_violation, e.g. employees_not_own_team_lead
    return new HttpError(400, "invalid_request", "This request would create an invalid employee record.");
  }
  return error;
}

async function selectEmployeeById(client, employeeId) {
  const { rows } = await client.query(
    `SELECT ${EMPLOYEE_COLUMNS}, users.role, users.email
     FROM employees
     JOIN users ON users.id = employees.user_id
     WHERE employees.id = $1 AND employees.deleted_at IS NULL`,
    [employeeId],
  );
  return rows[0] || null;
}

export function createEmployeeRepository(database) {
  return Object.freeze({
    async findByUserId(userId) {
      const { rows } = await database.query(
        `SELECT ${EMPLOYEE_COLUMNS}, users.role, users.email
         FROM employees
         JOIN users ON users.id = employees.user_id
         WHERE employees.user_id = $1 AND employees.deleted_at IS NULL`,
        [userId],
      );
      return rows[0] || null;
    },

    async findById(employeeId) {
      return selectEmployeeById(database, employeeId);
    },

    /** Members of a team lead, used by the deletion reassignment path. */
    async findTeamMembers(teamLeadId) {
      const { rows } = await database.query(
        `SELECT ${EMPLOYEE_COLUMNS}, users.role, users.email
         FROM employees
         JOIN users ON users.id = employees.user_id
         WHERE employees.team_lead_id = $1 AND employees.deleted_at IS NULL`,
        [teamLeadId],
      );
      return rows;
    },

    /**
     * Every employee the principal may see. The scope predicate comes from
     * employeeScopeService; a null filter means the principal has no valid scope and is
     * returned as an empty list rather than as an unfiltered query.
     */
    async listForPrincipal(principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees" });
      if (!scope) return [];

      const { rows } = await database.query(
        `SELECT ${EMPLOYEE_COLUMNS}, users.role, users.email
         FROM employees
         JOIN users ON users.id = employees.user_id
         WHERE employees.deleted_at IS NULL AND ${scope.text}
         ORDER BY employees.full_name`,
        scope.values,
      );
      return rows;
    },

    /**
     * A single employee, filtered by id AND the principal's scope in one query -- an
     * out-of-scope id simply returns no row, so the route 404s rather than confirming to
     * an unauthorized caller that the id exists at all.
     */
    async findByIdForPrincipal(employeeId, principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees", startParameterIndex: 2 });
      if (!scope) return null;

      const { rows } = await database.query(
        `SELECT ${EMPLOYEE_COLUMNS}, users.role, users.email
         FROM employees
         JOIN users ON users.id = employees.user_id
         WHERE employees.id = $1 AND employees.deleted_at IS NULL AND ${scope.text}`,
        [employeeId, ...scope.values],
      );
      return rows[0] || null;
    },

    /**
     * Creates the users row and the employees row in one transaction. The new account is
     * always status = 'invited' with no password_hash -- nobody can log in until a separate
     * flow sets one (not part of this phase). employee_number is drawn from
     * next_employee_number() (migration 005 / D17), never invented here.
     */
    async create({ email, role, fullName, phone, departmentId, positionTitle, joinedOn, basic, allowances, teamLeadId }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [company] } = await client.query("SELECT id FROM companies LIMIT 1");
        if (!company) throw new HttpError(500, "internal", "No company exists to create an employee under.");

        const { rows: [user] } = await client.query(
          `INSERT INTO users (company_id, email, role, status)
           VALUES ($1, $2, $3, 'invited')
           RETURNING id`,
          [company.id, email, role],
        );

        const { rows: [{ employee_number: employeeNumber }] } = await client.query(
          "SELECT next_employee_number() AS employee_number",
        );

        const { rows: [employee] } = await client.query(
          `INSERT INTO employees
             (user_id, company_id, department_id, team_lead_id, employee_number,
              full_name, phone, position_title, joined_on, basic, allowances)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [user.id, company.id, departmentId, teamLeadId, employeeNumber,
            fullName, phone, positionTitle, joinedOn, basic, allowances],
        );

        const created = await selectEmployeeById(client, employee.id);
        await client.query("COMMIT");
        return created;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw translateWriteError(error);
      } finally {
        client.release();
      }
    },

    /**
     * Applies `changes` across employees and/or users, whichever columns they touch, in one
     * transaction. Returns the updated row, or null if the employee does not exist (the
     * controller/service is responsible for turning that into the right HTTP status --
     * authorization has already run against a row fetched before this call, so a null here
     * would mean it was deleted in between, not that it never existed).
     */
    async updateById(id, changes) {
      const employeeSets = [];
      const employeeValues = [];
      const userSets = [];
      const userValues = [];

      for (const column of EMPLOYEE_UPDATE_COLUMNS) {
        if (!Object.hasOwn(changes, column)) continue;
        employeeValues.push(changes[column]);
        employeeSets.push(`${column} = $${employeeValues.length}`);
      }
      for (const column of USER_UPDATE_COLUMNS) {
        if (!Object.hasOwn(changes, column)) continue;
        userValues.push(changes[column]);
        userSets.push(`${column} = $${userValues.length}`);
      }

      const client = await database.connect();
      try {
        await client.query("BEGIN");

        if (employeeSets.length > 0) {
          employeeValues.push(id);
          await client.query(
            `UPDATE employees SET ${employeeSets.join(", ")} WHERE id = $${employeeValues.length} AND deleted_at IS NULL`,
            employeeValues,
          );
        }

        if (userSets.length > 0) {
          const { rows: [target] } = await client.query(
            "SELECT user_id FROM employees WHERE id = $1 AND deleted_at IS NULL",
            [id],
          );
          if (target) {
            userValues.push(target.user_id);
            await client.query(
              `UPDATE users SET ${userSets.join(", ")} WHERE id = $${userValues.length} AND deleted_at IS NULL`,
              userValues,
            );
          }
        }

        const updated = await selectEmployeeById(client, id);
        await client.query("COMMIT");
        return updated;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw translateWriteError(error);
      } finally {
        client.release();
      }
    },

    /**
     * Soft-deletes the target and, when it was a team lead with members,
     * promotes replacementTeamLeadId and reassigns reassignedMemberIds to them first, in
     * the SAME transaction -- these are exactly the values assertCanDeleteEmployee already
     * computed and authorized, this only carries them out.
     *
     * The target's users row is soft-deleted alongside the employees row. Firestore's
     * equivalent deletion (functions/employeeMutationService.js) deletes the Firebase Auth
     * account together with the employee document -- users is the structural descendant of
     * that auth identity (schema-design.md section 4.2), so leaving it live while the
     * employee record is gone would both permanently reserve the email (defeating the
     * partial-unique-index re-hire support D1 §8 item 6 exists for) and leave an account
     * users_email_unique still guards while nothing employment-related backs it. Login
     * itself does not depend on this: findPrincipalByUserId's join already requires
     * employees.deleted_at IS NULL, so a deleted employee cannot obtain a principal even
     * without this.
     */
    async deleteById(id, { replacementTeamLeadId = null, reassignedMemberIds = [] } = {}) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [target] } = await client.query(
          "SELECT id, user_id FROM employees WHERE id = $1 AND deleted_at IS NULL",
          [id],
        );
        if (!target) throw new HttpError(404, "not_found", "Employee not found.");

        if (replacementTeamLeadId) {
          const { rows: [replacement] } = await client.query(
            "SELECT user_id FROM employees WHERE id = $1 AND deleted_at IS NULL",
            [replacementTeamLeadId],
          );
          if (!replacement) throw new HttpError(404, "not_found", "Replacement team lead not found.");

          await client.query("UPDATE users SET role = 'tl' WHERE id = $1", [replacement.user_id]);
          await client.query("UPDATE employees SET team_lead_id = NULL WHERE id = $1", [replacementTeamLeadId]);

          if (reassignedMemberIds.length > 0) {
            await client.query(
              "UPDATE employees SET team_lead_id = $1 WHERE id = ANY($2::uuid[])",
              [replacementTeamLeadId, reassignedMemberIds],
            );
          }
        }

        await client.query("UPDATE employees SET deleted_at = now() WHERE id = $1", [id]);
        await client.query("UPDATE users SET deleted_at = now() WHERE id = $1", [target.user_id]);

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw translateWriteError(error);
      } finally {
        client.release();
      }
    },
  });
}
