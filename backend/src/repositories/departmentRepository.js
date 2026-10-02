import { HttpError } from "../utils/httpError.js";
import { COMPANY_WIDE_ROLES } from "../utils/roles.js";

const DEPARTMENT_COLUMNS = `
  departments.id,
  departments.company_id,
  departments.name,
  departments.description,
  departments.status,
  departments.manager_employee_id,
  departments.created_at,
  departments.updated_at
`;

/** departments.<key> for changes a PATCH may touch -- a flat list, one table, unlike employees. */
const DEPARTMENT_UPDATE_COLUMNS = Object.freeze(["name", "description", "status", "manager_employee_id"]);

/**
 * Maps a Postgres constraint-violation into the same clean HttpError shape
 * employeeRepository.js's translateWriteError already uses, instead of letting a raw pg
 * error surface as an opaque 500. Anything not recognized is rethrown as-is.
 */
function translateWriteError(error) {
  if (error?.code === "23505") { // unique_violation
    if (error.constraint === "departments_name_unique") {
      return new HttpError(409, "name_already_exists", "A department with this name already exists.");
    }
    return new HttpError(409, "conflict", "This record already exists.");
  }
  if (error?.code === "23503") { // foreign_key_violation
    if (error.constraint === "departments_manager_employee_foreign_key") {
      return new HttpError(
        400,
        "invalid_manager",
        "manager_employee_id must reference an employee who already works in this department.",
      );
    }
    return new HttpError(400, "invalid_reference", "This request references a record that does not exist.");
  }
  if (error?.code === "23514") { // check_violation, e.g. departments_name_not_blank
    return new HttpError(400, "invalid_request", "This request would create an invalid department record.");
  }
  return error;
}

async function selectDepartmentById(client, departmentId) {
  const { rows } = await client.query(
    `SELECT ${DEPARTMENT_COLUMNS}
     FROM departments
     WHERE departments.id = $1 AND departments.deleted_at IS NULL`,
    [departmentId],
  );
  return rows[0] || null;
}

/**
 * No row-level predicate: Firestore denies manager/tl/employee department reads entirely
 * (auth-matrix.md), so this is a role gate, not a scope filter. The same is true of writes
 * (departmentAuthorizationService.js) -- departments have no department/team scope to speak
 * of, unlike employees.
 */
export function createDepartmentRepository(database) {
  return Object.freeze({
    async listForPrincipal(principal) {
      if (!COMPANY_WIDE_ROLES.has(principal?.role)) return [];

      const { rows } = await database.query(
        `SELECT ${DEPARTMENT_COLUMNS}
         FROM departments
         WHERE departments.deleted_at IS NULL
         ORDER BY departments.name`,
      );
      return rows;
    },

    async findByIdForPrincipal(departmentId, principal) {
      if (!COMPANY_WIDE_ROLES.has(principal?.role)) return null;

      const { rows } = await database.query(
        `SELECT ${DEPARTMENT_COLUMNS}
         FROM departments
         WHERE departments.id = $1 AND departments.deleted_at IS NULL`,
        [departmentId],
      );
      return rows[0] || null;
    },

    async findById(departmentId) {
      return selectDepartmentById(database, departmentId);
    },

    /**
     * Creates a department. manager_employee_id is never accepted here --
     * departments_manager_employee_foreign_key requires the manager to already work IN this
     * department, which is structurally impossible before the department exists at all.
     * Assigning one is necessarily a follow-up updateById call.
     */
    async create({ name, description, status }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [company] } = await client.query("SELECT id FROM companies LIMIT 1");
        if (!company) throw new HttpError(500, "internal", "No company exists to create a department under.");

        const { rows: [department] } = await client.query(
          `INSERT INTO departments (company_id, name, description, status)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [company.id, name, description ?? null, status],
        );

        const created = await selectDepartmentById(client, department.id);
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
     * Applies `changes` to the department row in one transaction. manager_employee_id may be
     * set to null freely (D15: clearing a manager auto-nulls, no forced reassignment -- no
     * validation here blocks it) or to a real employee id, validated by
     * departments_manager_employee_foreign_key via translateWriteError. Returns null if the
     * department does not exist.
     */
    async updateById(id, changes) {
      const sets = [];
      const values = [];
      for (const column of DEPARTMENT_UPDATE_COLUMNS) {
        if (!Object.hasOwn(changes, column)) continue;
        values.push(changes[column]);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0) return selectDepartmentById(database, id);

      const client = await database.connect();
      try {
        await client.query("BEGIN");

        values.push(id);
        await client.query(
          `UPDATE departments SET ${sets.join(", ")} WHERE id = $${values.length} AND deleted_at IS NULL`,
          values,
        );

        const updated = await selectDepartmentById(client, id);
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
     * Soft-deletes the department. D26: refuses with department_has_employees (and the live
     * count) if any employee still has this department_id -- employees.department_id is
     * NOT NULL, so there is no bulk-reassign shortcut; the caller moves people out
     * individually first via PATCH /api/v1/employees/:id.
     */
    async deleteById(id) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");

        const { rows: [target] } = await client.query(
          "SELECT id FROM departments WHERE id = $1 AND deleted_at IS NULL",
          [id],
        );
        if (!target) throw new HttpError(404, "not_found", "Department not found.");

        const { rows: [{ count }] } = await client.query(
          "SELECT COUNT(*)::int AS count FROM employees WHERE department_id = $1 AND deleted_at IS NULL",
          [id],
        );
        if (count > 0) {
          throw new HttpError(
            409,
            "department_has_employees",
            `This department still has ${count} employee(s); move them to another department before deleting it.`,
          );
        }

        await client.query("UPDATE departments SET deleted_at = now() WHERE id = $1", [id]);
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
