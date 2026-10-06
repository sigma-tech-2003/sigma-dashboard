import { HttpError } from "../utils/httpError.js";
import { assertCanWriteKpiFor, assertCanWriteKpis } from "./kpiAuthorizationService.js";

/**
 * Orchestrates KPI create/update/delete and rating (D29). Who may write is entirely
 * kpiAuthorizationService.js. What this owns is what a column cannot express: that a new KPI's
 * employee is an eligible assignee, and that the project and employee exist.
 *
 * Deliberately NOT here: the self-rating ban, the legacy-KPI rating ban, and the rating range. They
 * are database constraints (kpis_no_self_rating, kpis_legacy_not_rateable, kpis_rating_range), and
 * kpiRepository.js turns their violations into clean errors. Duplicating them in this layer is
 * what D29 rules out, and would stop the database from being the thing that provably refuses them.
 */
export function createKpiMutationService({ kpiRepository, projectRepository, employeeRepository }) {
  /** A loaded project in the shape the authorization functions read. */
  const projectScopeShape = (project) => ({
    department_id: project.department_id,
    team_lead_id: project.team_lead_id,
    assigneeTeamLeadIds: project.assignees.map((assignee) => assignee.team_lead_id),
  });

  /** An existing KPI (from findByIdForWrite) as the authorization context. */
  const contextOf = (kpi) => ({
    project: kpi.project_id
      ? {
        department_id: kpi.project_department_id,
        team_lead_id: kpi.project_team_lead_id,
        assigneeTeamLeadIds: kpi.project_assignee_team_lead_ids,
      }
      : null,
    employee: {
      id: kpi.employee_id,
      department_id: kpi.employee_department_id,
      team_lead_id: kpi.employee_team_lead_id,
    },
  });

  /** The existing KPI, authorized for this principal, or the error that explains why not. */
  async function loadAuthorizedKpi(principal, kpiId) {
    const existing = await kpiRepository.findByIdForWrite(kpiId);
    if (!existing) throw new HttpError(404, "not_found", "KPI not found.");
    assertCanWriteKpiFor(principal, contextOf(existing));
    return existing;
  }

  return Object.freeze({
    /**
     * D29: a project is required (no new legacy KPIs), and the employee must be active, an
     * `employee`-role person, in the project's department, and an assignee of it. That eligibility
     * is checked HERE, at create only; later edits and ratings rely on scope and on the database. The
     * assignment itself is confirmed under a lock by kpiRepository.create. Scope is checked before
     * eligibility, so a caller out of scope learns nothing about an employee's status.
     */
    async createKpi(principal, input) {
      assertCanWriteKpis(principal);

      const project = await projectRepository.findByIdForWrite(input.project_id);
      if (!project) throw new HttpError(400, "invalid_project", "project_id does not reference an existing project.");

      const employee = await employeeRepository.findById(input.employee_id);
      if (!employee) throw new HttpError(400, "invalid_employee", "employee_id does not reference an existing employee.");

      assertCanWriteKpiFor(principal, {
        project: projectScopeShape(project),
        employee: { id: employee.id, department_id: employee.department_id, team_lead_id: employee.team_lead_id },
      });

      if (
        employee.employment_status !== "active"
        || employee.role !== "employee"
        || employee.department_id !== project.department_id
      ) {
        throw new HttpError(
          400,
          "employee_not_eligible",
          "A KPI's employee must be an active employee in the project's department.",
        );
      }

      return kpiRepository.create(input);
    },

    /** Progress fields only; the schema has already refused employee_id, project_id and the rating. */
    async updateKpi(principal, kpiId, changes) {
      assertCanWriteKpis(principal);
      await loadAuthorizedKpi(principal, kpiId);

      const updated = await kpiRepository.updateById(kpiId, changes);
      if (!updated) throw new HttpError(404, "not_found", "KPI not found.");
      return updated;
    },

    /**
     * The rater is the acting principal and the time is the database's, never the client's. This
     * authorizes and hands off; the database decides whether the rating is allowed at all. A legacy
     * KPI and a self-rating therefore reach it and come back as 409 / 403 from the constraints.
     */
    async rateKpi(principal, kpiId, { rating }) {
      assertCanWriteKpis(principal);
      await loadAuthorizedKpi(principal, kpiId);

      const rated = await kpiRepository.rate(kpiId, { rating, ratedByEmployeeId: principal.employeeId });
      if (!rated) throw new HttpError(404, "not_found", "KPI not found.");
      return rated;
    },

    /** Soft delete; the actor is recorded. No eligibility or status check. */
    async deleteKpi(principal, kpiId) {
      assertCanWriteKpis(principal);
      await loadAuthorizedKpi(principal, kpiId);

      await kpiRepository.deleteById(kpiId, principal.employeeId);
    },
  });
}
