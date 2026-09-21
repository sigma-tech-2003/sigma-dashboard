import { buildEmployeeScopeFilter } from "../services/employeeScopeService.js";

const ATTENDANCE_COLUMNS = `
  attendance.id,
  attendance.employee_id,
  attendance.work_date,
  attendance.status,
  attendance.check_in,
  attendance.check_out,
  attendance.notes,
  attendance.created_at,
  attendance.updated_at
`;

export function createAttendanceRepository(database) {
  return Object.freeze({
    async listForPrincipal(principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees" });
      if (!scope) return [];

      const { rows } = await database.query(
        `SELECT ${ATTENDANCE_COLUMNS}
         FROM attendance
         JOIN employees ON employees.id = attendance.employee_id
         WHERE attendance.deleted_at IS NULL AND ${scope.text}
         ORDER BY attendance.work_date DESC`,
        scope.values,
      );
      return rows;
    },

    async findByIdForPrincipal(attendanceId, principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees", startParameterIndex: 2 });
      if (!scope) return null;

      const { rows } = await database.query(
        `SELECT ${ATTENDANCE_COLUMNS}
         FROM attendance
         JOIN employees ON employees.id = attendance.employee_id
         WHERE attendance.id = $1 AND attendance.deleted_at IS NULL AND ${scope.text}`,
        [attendanceId, ...scope.values],
      );
      return rows[0] || null;
    },
  });
}
