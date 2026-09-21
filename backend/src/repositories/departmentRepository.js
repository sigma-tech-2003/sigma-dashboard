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

/**
 * No row-level predicate: Firestore denies manager/tl/employee department reads entirely
 * (auth-matrix.md), so this is a role gate, not a scope filter.
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
  });
}
