import { buildEmployeeScopeFilter } from "../services/employeeScopeService.js";

const KPI_COLUMNS = `
  kpis.id,
  kpis.project_id,
  kpis.employee_id,
  kpis.title,
  kpis.target,
  kpis.current_value,
  kpis.weight,
  kpis.period,
  kpis.status,
  kpis.rating,
  kpis.rated_by_employee_id,
  kpis.rated_at,
  kpis.created_at,
  kpis.updated_at
`;

/**
 * Section 6 gives kpis the same employee-join predicate as leaves/attendance/payroll,
 * joined via kpis.employee_id = employees.id -- deliberately simpler than the old
 * getScopedWorkspace callable, which only surfaced KPIs tied to scoped projects. This is
 * section 6's own explicit simplification (a manager now sees all of their department's
 * KPIs, not only project-linked ones), followed literally rather than re-derived from the
 * callable the way projects' scope is.
 */
export function createKpiRepository(database) {
  return Object.freeze({
    async listForPrincipal(principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees" });
      if (!scope) return [];

      const { rows } = await database.query(
        `SELECT ${KPI_COLUMNS}
         FROM kpis
         JOIN employees ON employees.id = kpis.employee_id
         WHERE kpis.deleted_at IS NULL AND ${scope.text}
         ORDER BY kpis.created_at DESC`,
        scope.values,
      );
      return rows;
    },

    async findByIdForPrincipal(kpiId, principal) {
      const scope = buildEmployeeScopeFilter(principal, { alias: "employees", startParameterIndex: 2 });
      if (!scope) return null;

      const { rows } = await database.query(
        `SELECT ${KPI_COLUMNS}
         FROM kpis
         JOIN employees ON employees.id = kpis.employee_id
         WHERE kpis.id = $1 AND kpis.deleted_at IS NULL AND ${scope.text}`,
        [kpiId, ...scope.values],
      );
      return rows[0] || null;
    },
  });
}
