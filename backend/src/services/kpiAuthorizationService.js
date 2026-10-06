import { HttpError } from "../utils/httpError.js";
import { assertCanWriteProjectsOrKpis, canManageExistingProject } from "./projectAuthorizationService.js";

/** The role gate for KPIs: the same four roles, employee record and department as projects. */
export function assertCanWriteKpis(principal) {
  assertCanWriteProjectsOrKpis(principal, "KPIs");
}

/**
 * Scope over one KPI (D29), the callables' canManageProject / canManageLegacy.
 *
 * `context` is `{ project, employee }`:
 *   project  `{ department_id, team_lead_id, assigneeTeamLeadIds }`, or null for a legacy KPI
 *   employee `{ id, department_id, team_lead_id }` -- the KPI's employee
 *
 * With a project: admin and hr any; a manager needs the project AND the employee in their
 * department; a tl needs the project in their scope (canManageExistingProject) AND the employee on
 * their team. Legacy (no project): admin and hr any; a manager needs the employee in their
 * department; a tl needs the employee in their department and on their team.
 *
 * This is also the rater's scope: rating is authorized exactly like any other KPI write, and the
 * database -- not this function -- refuses a self-rating or a rating on a legacy KPI (D29).
 */
export function assertCanWriteKpiFor(principal, { project, employee }) {
  if (principal.role === "admin" || principal.role === "hr") return;

  const employeeOnTeam = employee.id === principal.employeeId || employee.team_lead_id === principal.employeeId;
  const employeeInDepartment = employee.department_id === principal.departmentId;

  let allowed;
  if (principal.role === "manager") {
    allowed = employeeInDepartment && (project === null || project.department_id === principal.departmentId);
  } else {
    allowed = employeeInDepartment
      && employeeOnTeam
      && (project === null || canManageExistingProject(principal, project));
  }

  if (!allowed) throw new HttpError(403, "kpi_scope_denied", "This KPI is outside your scope.");
}
