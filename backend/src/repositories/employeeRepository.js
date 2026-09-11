import { buildEmployeeScopeFilter } from "../services/employeeScopeService.js";

const EMPLOYEE_COLUMNS = `
  employees.id,
  employees.user_id,
  employees.company_id,
  employees.department_id,
  employees.team_lead_id,
  employees.employee_number,
  employees.full_name,
  employees.position_title,
  employees.employment_status,
  employees.basic,
  employees.allowances
`;

export function createEmployeeRepository(database) {
  return Object.freeze({
    async findByUserId(userId) {
      const { rows } = await database.query(
        `SELECT ${EMPLOYEE_COLUMNS}, users.role
         FROM employees
         JOIN users ON users.id = employees.user_id
         WHERE employees.user_id = $1 AND employees.deleted_at IS NULL`,
        [userId],
      );
      return rows[0] || null;
    },

    async findById(employeeId) {
      const { rows } = await database.query(
        `SELECT ${EMPLOYEE_COLUMNS}, users.role
         FROM employees
         JOIN users ON users.id = employees.user_id
         WHERE employees.id = $1 AND employees.deleted_at IS NULL`,
        [employeeId],
      );
      return rows[0] || null;
    },

    /** Members of a team lead, used by the deletion reassignment path. */
    async findTeamMembers(teamLeadId) {
      const { rows } = await database.query(
        `SELECT ${EMPLOYEE_COLUMNS}, users.role
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
        `SELECT ${EMPLOYEE_COLUMNS}, users.role
         FROM employees
         JOIN users ON users.id = employees.user_id
         WHERE employees.deleted_at IS NULL AND ${scope.text}
         ORDER BY employees.full_name`,
        scope.values,
      );
      return rows;
    },
  });
}
