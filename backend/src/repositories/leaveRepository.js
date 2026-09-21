import { buildEmployeeScopeFilter } from "../services/employeeScopeService.js";

const LEAVE_COLUMNS = `
  leaves.id,
  leaves.employee_id,
  leaves.type,
  leaves.start_date,
  leaves.end_date,
  leaves.days,
  leaves.reason,
  leaves.status,
  leaves.applied_on,
  leaves.decided_by_employee_id,
  leaves.decided_at,
  leaves.decision_recorded,
  leaves.created_at,
  leaves.updated_at
`;

export function createLeaveRepository(database) {
  return Object.freeze({
    async listForPrincipal(principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees" });
      if (!scope) return [];

      const { rows } = await database.query(
        `SELECT ${LEAVE_COLUMNS}
         FROM leaves
         JOIN employees ON employees.id = leaves.employee_id
         WHERE leaves.deleted_at IS NULL AND ${scope.text}
         ORDER BY leaves.start_date DESC`,
        scope.values,
      );
      return rows;
    },

    async findByIdForPrincipal(leaveId, principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees", startParameterIndex: 2 });
      if (!scope) return null;

      const { rows } = await database.query(
        `SELECT ${LEAVE_COLUMNS}
         FROM leaves
         JOIN employees ON employees.id = leaves.employee_id
         WHERE leaves.id = $1 AND leaves.deleted_at IS NULL AND ${scope.text}`,
        [leaveId, ...scope.values],
      );
      return rows[0] || null;
    },
  });
}
