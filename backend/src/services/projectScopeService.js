import { COMPANY_WIDE_ROLES } from "../utils/roles.js";

/**
 * projects has its own department_id/team_lead_id columns -- it is not joined through
 * employees the way leaves/attendance/kpis are, so it cannot reuse
 * employeeScopeService.buildEmployeeScopeFilter. Section 6 is silent on the exact
 * predicate for projects (it names only leaves/attendance/payroll/kpis), so the only
 * source of truth for what a manager/tl should see is the old getScopedWorkspace
 * callable's actual behavior, which D19/A8 confirms should carry over -- "the new API has
 * no reason to keep that split" means the same data, reached directly instead of through a
 * callable, not narrower data.
 *
 *   admin/hr  unfiltered
 *   manager   projects.department_id = principal.departmentId
 *   tl        projects.team_lead_id = principal.employeeId, OR the project has an
 *             assignee who reports to principal (an EXISTS against project_assignments
 *             joined to employees) -- the fuller old-callable behavior: own projects AND
 *             team members' projects, not "own projects only".
 *   employee  EXISTS (project_assignments WHERE project_id = projects.id AND
 *             employee_id = principal.employeeId) -- matches Firestore's
 *             assignedEmployeeIds array-contains exactly.
 *
 * Returns null for an unscopable principal, same convention as buildEmployeeScopeFilter:
 * callers must treat that as a denial, not as "no filter".
 */
export function buildProjectScopeFilter(principal, options = {}) {
  const { alias = "projects", startParameterIndex = 1 } = options;
  if (!principal?.employeeId || !principal?.role) return null;

  let index = startParameterIndex;

  if (COMPANY_WIDE_ROLES.has(principal.role)) {
    return { text: "TRUE", values: [], nextParameterIndex: index };
  }

  if (principal.role === "manager") {
    if (!principal.departmentId) return null;
    return {
      text: `${alias}.department_id = $${index}`,
      values: [principal.departmentId],
      nextParameterIndex: index + 1,
    };
  }

  if (principal.role === "tl") {
    const ownPlaceholder = `$${index}`;
    index += 1;
    const teamPlaceholder = `$${index}`;
    index += 1;
    return {
      text: `(${alias}.team_lead_id = ${ownPlaceholder} OR EXISTS (
        SELECT 1 FROM project_assignments pa
        JOIN employees assignee ON assignee.id = pa.employee_id
        WHERE pa.project_id = ${alias}.id AND assignee.team_lead_id = ${teamPlaceholder}
      ))`,
      values: [principal.employeeId, principal.employeeId],
      nextParameterIndex: index,
    };
  }

  if (principal.role === "employee") {
    return {
      text: `EXISTS (
        SELECT 1 FROM project_assignments pa
        WHERE pa.project_id = ${alias}.id AND pa.employee_id = $${index}
      )`,
      values: [principal.employeeId],
      nextParameterIndex: index + 1,
    };
  }

  return null;
}
