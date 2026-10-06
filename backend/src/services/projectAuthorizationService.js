import { HttpError } from "../utils/httpError.js";
import { DEPARTMENT_SCOPED_ROLES, TEAM_SCOPED_ROLES } from "../utils/roles.js";

/**
 * Who may write projects and KPIs (D29): the callables' MANAGING_ROLES. The auth matrix's "denied"
 * rows are the rules layer (client writes), not this policy.
 */
export const PROJECT_WRITE_ROLES = new Set(["admin", "hr", "manager", "tl"]);

const denied = (code, message) => new HttpError(403, code, message);

/**
 * The role gate, ahead of any database access. An account with no employee record is refused:
 * the acting employee's id becomes the deleter on a delete and the rater on a rating (D29). A
 * manager or tl with no department has no scope at all, so is refused rather than treated as
 * unscoped -- the legacy callable's PRINCIPAL_SCOPE_INVALID.
 */
export function assertCanWriteProjectsOrKpis(principal, subject = "projects") {
  if (!PROJECT_WRITE_ROLES.has(principal?.role)) {
    throw denied("role_not_allowed", `This account cannot manage ${subject}.`);
  }
  if (!principal.employeeId) {
    throw denied("role_not_allowed", "This account is not linked to an employee record.");
  }
  const scoped = DEPARTMENT_SCOPED_ROLES.has(principal.role) || TEAM_SCOPED_ROLES.has(principal.role);
  if (scoped && !principal.departmentId) {
    throw denied("role_not_allowed", "This account has no department, so it has no scope.");
  }
}

/**
 * A project as the write authorization sees it: `{ department_id, team_lead_id,
 * assigneeTeamLeadIds }`, where assigneeTeamLeadIds holds each assignee's own team_lead_id.
 *
 * True when the principal may manage this project AS IT STANDS (D29): admin and hr always; a
 * manager for their department; a tl for a project in their department that they lead or that has
 * any assignee who reports to them. This is deliberately NOT the Phase 3 read filter
 * (projectScopeService.js) -- a pure predicate over rows already loaded, and the one KPI scope reuses.
 */
export function canManageExistingProject(principal, project) {
  if (principal.role === "admin" || principal.role === "hr") return true;
  if (principal.role === "manager") return project.department_id === principal.departmentId;
  if (principal.role !== "tl" || project.department_id !== principal.departmentId) return false;
  return project.team_lead_id === principal.employeeId
    || project.assigneeTeamLeadIds.some((teamLeadId) => teamLeadId === principal.employeeId);
}

export function assertCanManageExistingProject(principal, project) {
  if (!canManageExistingProject(principal, project)) {
    throw denied("project_scope_denied", "This project is outside your scope.");
  }
}

/**
 * The second half of D29's two-sided check, run on the project AS IT WOULD BECOME (create, or an
 * edit applied over the stored row): a manager's resulting department must be their own; a tl must
 * be its lead, in their department, with EVERY assignee on their team. So a tl can manage a
 * project they only partly touch but can never leave one that is not wholly theirs -- which is also
 * why a tl who is not the lead can delete a project but not edit it, exactly as the callable behaved.
 */
export function assertResultingProjectInScope(principal, resulting) {
  if (principal.role === "admin" || principal.role === "hr") return;

  if (principal.role === "manager") {
    if (resulting.department_id !== principal.departmentId) {
      throw denied("project_scope_denied", "The resulting project would be outside your department.");
    }
    return;
  }

  const everyAssigneeOnTeam = resulting.assigneeTeamLeadIds
    .every((teamLeadId) => teamLeadId === principal.employeeId);
  if (
    resulting.department_id !== principal.departmentId
    || resulting.team_lead_id !== principal.employeeId
    || !everyAssigneeOnTeam
  ) {
    throw denied(
      "project_scope_denied",
      "A team lead's project must be led by them, in their department, with only their own team assigned.",
    );
  }
}
