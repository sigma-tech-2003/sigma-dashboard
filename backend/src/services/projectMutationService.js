import { HttpError } from "../utils/httpError.js";
import { DEPARTMENT_SCOPED_ROLES, TEAM_SCOPED_ROLES } from "../utils/roles.js";
import {
  assertCanManageExistingProject,
  assertCanWriteProjectsOrKpis,
  assertResultingProjectInScope,
} from "./projectAuthorizationService.js";

/**
 * Orchestrates project create/update/delete (D29): authorization -- including the two-sided check
 * on the project as it stands AND as it would become -- then the rules a column cannot express
 * (who may be a lead or an assignee), then the repository. The same-department rule itself is the
 * database's (composite foreign keys), and so is the refusal to delete a project or remove an
 * assignee while live KPIs depend on it, which the repository enforces inside its transaction.
 */
export function createProjectMutationService({ projectRepository, employeeRepository }) {
  async function loadEmployeeOrNull(employeeId) {
    return employeeRepository.findById(employeeId);
  }

  /** D29: a lead is an active `tl` in the project's department. */
  async function loadValidLead(teamLeadId, departmentId) {
    const lead = await loadEmployeeOrNull(teamLeadId);
    if (!lead || lead.employment_status !== "active" || lead.role !== "tl" || lead.department_id !== departmentId) {
      throw new HttpError(
        400,
        "invalid_team_lead",
        "team_lead_id must reference an active team lead in the project's department.",
      );
    }
    return lead;
  }

  /** D29: every assignee is an active `employee`-role person in the project's department. */
  async function loadValidAssignees(employeeIds, departmentId) {
    const assignees = [];
    for (const employeeId of employeeIds) {
      const employee = await loadEmployeeOrNull(employeeId);
      if (
        !employee
        || employee.employment_status !== "active"
        || employee.role !== "employee"
        || employee.department_id !== departmentId
      ) {
        throw new HttpError(
          400,
          "invalid_assignee",
          "Every assigned employee must be an active employee in the project's department.",
        );
      }
      assignees.push(employee);
    }
    return assignees;
  }

  /** The stored project in the shape the authorization functions read. */
  const scopeShapeOf = (project) => ({
    department_id: project.department_id,
    team_lead_id: project.team_lead_id,
    assigneeTeamLeadIds: project.assignees.map((assignee) => assignee.team_lead_id),
  });

  return Object.freeze({
    /**
     * A manager or tl creating a project defaults the department to their own, and a tl defaults
     * the lead to themselves (a tl may only create a project they lead) -- the same defaulting the
     * employee create does, and what the frontend form already does client-side. The defaults are
     * applied only when the field is absent: an explicit value is checked, never overridden.
     */
    async createProject(principal, input) {
      assertCanWriteProjectsOrKpis(principal, "projects");

      const isScoped = DEPARTMENT_SCOPED_ROLES.has(principal.role) || TEAM_SCOPED_ROLES.has(principal.role);
      const departmentId = input.department_id ?? (isScoped ? principal.departmentId : undefined);
      if (!departmentId) throw new HttpError(400, "invalid_request", "department_id is required.");

      const teamLeadId = input.team_lead_id === undefined
        ? (TEAM_SCOPED_ROLES.has(principal.role) ? principal.employeeId : null)
        : input.team_lead_id;

      if (teamLeadId !== null) await loadValidLead(teamLeadId, departmentId);
      const assignees = await loadValidAssignees(input.assigned_employee_ids, departmentId);

      assertResultingProjectInScope(principal, {
        department_id: departmentId,
        team_lead_id: teamLeadId,
        assigneeTeamLeadIds: assignees.map((assignee) => assignee.team_lead_id),
      });

      return projectRepository.create({ ...input, department_id: departmentId, team_lead_id: teamLeadId });
    },

    /**
     * Existing scope first, then the resulting project's: a project may be edited only by someone
     * who may manage it as it stands, and only into a state they would still be allowed to hold.
     * The resulting-scope check ALWAYS runs, so a tl who is not the project's lead cannot edit it
     * (they can delete it) -- the callable's behavior. Only newly supplied references are loaded
     * and validated; an unchanged lead or assignee is taken from the stored row, since
     * re-validating stored references is what stranded records in Firestore.
     */
    async updateProject(principal, projectId, changes) {
      assertCanWriteProjectsOrKpis(principal, "projects");

      const existing = await projectRepository.findByIdForWrite(projectId);
      if (!existing) throw new HttpError(404, "not_found", "Project not found.");
      assertCanManageExistingProject(principal, scopeShapeOf(existing));

      const departmentId = changes.department_id ?? existing.department_id;
      const teamLeadId = Object.hasOwn(changes, "team_lead_id") ? changes.team_lead_id : existing.team_lead_id;

      if (Object.hasOwn(changes, "team_lead_id") && teamLeadId !== null) {
        await loadValidLead(teamLeadId, departmentId);
      }

      let assigneeTeamLeadIds = existing.assignees.map((assignee) => assignee.team_lead_id);
      if (Object.hasOwn(changes, "assigned_employee_ids")) {
        const assignees = await loadValidAssignees(changes.assigned_employee_ids, departmentId);
        assigneeTeamLeadIds = assignees.map((assignee) => assignee.team_lead_id);
      }

      assertResultingProjectInScope(principal, {
        department_id: departmentId,
        team_lead_id: teamLeadId,
        assigneeTeamLeadIds,
      });

      const updated = await projectRepository.updateById(projectId, changes);
      if (!updated) throw new HttpError(404, "not_found", "Project not found.");
      return updated;
    },

    /**
     * Soft delete; the actor is recorded. Only the existing project's scope is checked -- there is
     * no resulting project -- which is why a tl who merely has a team member assigned may delete a
     * project they could not edit. The repository refuses (409 project_has_kpis) while live KPIs remain.
     */
    async deleteProject(principal, projectId) {
      assertCanWriteProjectsOrKpis(principal, "projects");

      const existing = await projectRepository.findByIdForWrite(projectId);
      if (!existing) throw new HttpError(404, "not_found", "Project not found.");
      assertCanManageExistingProject(principal, scopeShapeOf(existing));

      await projectRepository.deleteById(projectId, principal.employeeId);
    },
  });
}
