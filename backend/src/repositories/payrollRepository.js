import { buildPayrollScopeFilter } from "../services/employeeScopeService.js";

const PAYROLL_COLUMNS = `
  payroll.id,
  payroll.employee_id,
  payroll.period_year,
  payroll.period_month,
  payroll.basic,
  payroll.allowances,
  payroll.bonus,
  payroll.deductions,
  payroll.gross,
  payroll.tax,
  payroll.net,
  payroll.status,
  payroll.created_at,
  payroll.updated_at
`;

/**
 * Uses buildPayrollScopeFilter, not buildEmployeeScopeFilter -- manager/tl are denied
 * (documented exception to section 6, see employeeScopeService.js), so no join to
 * employees is needed at all: payroll.employee_id is already a direct column.
 */
export function createPayrollRepository(database) {
  return Object.freeze({
    async listForPrincipal(principal) {
      const scope = buildPayrollScopeFilter(principal, { alias: "payroll" });
      if (!scope) return [];

      const { rows } = await database.query(
        `SELECT ${PAYROLL_COLUMNS}
         FROM payroll
         WHERE payroll.deleted_at IS NULL AND ${scope.text}
         ORDER BY payroll.period_year DESC, payroll.period_month DESC`,
        scope.values,
      );
      return rows;
    },

    async findByIdForPrincipal(payrollId, principal) {
      const scope = buildPayrollScopeFilter(principal, { alias: "payroll", startParameterIndex: 2 });
      if (!scope) return null;

      const { rows } = await database.query(
        `SELECT ${PAYROLL_COLUMNS}
         FROM payroll
         WHERE payroll.id = $1 AND payroll.deleted_at IS NULL AND ${scope.text}`,
        [payrollId, ...scope.values],
      );
      return rows[0] || null;
    },
  });
}
