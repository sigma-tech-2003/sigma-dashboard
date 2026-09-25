import { HttpError } from "../utils/httpError.js";
import { DEPARTMENT_SCOPED_ROLES, TEAM_SCOPED_ROLES } from "../utils/roles.js";
import {
  assertCanCreateEmployee,
  assertCanDeleteEmployee,
  assertCanUpdateEmployee,
} from "./employeeAuthorizationService.js";

/**
 * Orchestrates employee create/update/delete: resolves the few things authorization alone
 * doesn't (scope defaults on create, the team-lead role/department invariant D18 flags as
 * unenforced anywhere else), then calls employeeAuthorizationService's unmodified
 * assertCanCreateEmployee/assertCanUpdateEmployee/assertCanDeleteEmployee, then the
 * repository. Authorization decisions themselves live entirely in that service, not here.
 */

/**
 * D18: "only employee-role people may have a team lead" is flagged as a cross-table
 * invariant nothing enforces yet (no CHECK constraint can span employees and users). This is
 * that enforcement, at the one layer that can see both the resolved role and team_lead_id
 * together before either is written.
 */
function assertTeamLeadOnlyForEmployees(role, teamLeadId) {
  if (teamLeadId != null && role !== "employee") {
    throw new HttpError(400, "invalid_team_lead", "Only an employee-role record may have a team lead.");
  }
}

/**
 * D18's other unenforced invariant: "team lead must have role tl". Also checks the
 * candidate is in the same department, matching employees_team_lead_department_foreign_key
 * (composite FK) -- this is a friendlier 400 ahead of that constraint, not a replacement
 * for it; the FK remains the backstop if this is ever bypassed.
 */
async function assertValidTeamLead(employeeRepository, teamLeadId, departmentId) {
  if (teamLeadId == null) return;
  const candidate = await employeeRepository.findById(teamLeadId);
  if (!candidate || candidate.role !== "tl" || candidate.department_id !== departmentId) {
    throw new HttpError(
      400,
      "invalid_team_lead",
      "team_lead_id must reference an existing team lead in the same department.",
    );
  }
}

export function createEmployeeMutationService({ employeeRepository }) {
  /**
   * A manager/tl creating an employee defaults department_id (and, for a tl, team_lead_id)
   * to their own scope when omitted -- employeeInvitationPolicy.js's `creatorIsScoped`
   * behavior. assertCanCreateEmployee then rejects an explicit value that disagrees with
   * that scope; it does not default anything itself.
   */
  function resolveCreateAttributes(principal, input) {
    const isScoped = DEPARTMENT_SCOPED_ROLES.has(principal.role) || TEAM_SCOPED_ROLES.has(principal.role);
    const departmentId = input.department_id ?? (isScoped ? principal.departmentId : undefined);
    if (!departmentId) {
      throw new HttpError(400, "invalid_request", "department_id is required.");
    }

    const teamLeadId = TEAM_SCOPED_ROLES.has(principal.role)
      ? (input.team_lead_id ?? principal.employeeId)
      : (input.team_lead_id ?? null);

    return { ...input, department_id: departmentId, team_lead_id: teamLeadId };
  }

  return Object.freeze({
    /**
     * Creates the employee plus their user row (status invited, no password -- see
     * employeeRepository.js). employment_status is never caller-settable here: it always
     * starts 'active' (the column default), matching that a brand new hire cannot
     * sensibly start terminated or on leave.
     */
    async createEmployee(principal, input) {
      const attributes = resolveCreateAttributes(principal, input);

      assertCanCreateEmployee(principal, attributes);
      assertTeamLeadOnlyForEmployees(attributes.role, attributes.team_lead_id);
      await assertValidTeamLead(employeeRepository, attributes.team_lead_id, attributes.department_id);

      return employeeRepository.create({
        email: attributes.email,
        role: attributes.role,
        fullName: attributes.full_name,
        phone: attributes.phone ?? null,
        departmentId: attributes.department_id,
        positionTitle: attributes.position_title,
        joinedOn: attributes.joined_on,
        basic: attributes.basic,
        allowances: attributes.allowances,
        teamLeadId: attributes.team_lead_id,
      });
    },

    async updateEmployee(principal, employeeId, changes) {
      const target = await employeeRepository.findById(employeeId);
      // assertCanUpdateEmployee throws its own 404 when target is null -- no need to
      // duplicate that check here.
      assertCanUpdateEmployee(principal, target, changes);

      const touchesTeamLeadInvariant = Object.hasOwn(changes, "team_lead_id")
        || Object.hasOwn(changes, "role")
        || Object.hasOwn(changes, "department_id");

      if (touchesTeamLeadInvariant) {
        const nextRole = Object.hasOwn(changes, "role") ? changes.role : target.role;
        const nextTeamLeadId = Object.hasOwn(changes, "team_lead_id") ? changes.team_lead_id : target.team_lead_id;
        const nextDepartmentId = Object.hasOwn(changes, "department_id") ? changes.department_id : target.department_id;

        assertTeamLeadOnlyForEmployees(nextRole, nextTeamLeadId);
        await assertValidTeamLead(employeeRepository, nextTeamLeadId, nextDepartmentId);
      }

      return employeeRepository.updateById(employeeId, changes);
    },

    async deleteEmployee(principal, employeeId, options = {}) {
      const target = await employeeRepository.findById(employeeId);
      const members = target?.role === "tl" ? await employeeRepository.findTeamMembers(employeeId) : [];

      const { replacementTeamLeadId, reassignedMemberIds } = assertCanDeleteEmployee(principal, target, {
        members,
        replacementTeamLeadId: options.replacementTeamLeadId ?? null,
      });

      await employeeRepository.deleteById(employeeId, { replacementTeamLeadId, reassignedMemberIds });
    },
  });
}
