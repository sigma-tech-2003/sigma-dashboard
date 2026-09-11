import { HttpError } from "../utils/httpError.js";
import { scopeCoversEmployee } from "./employeeScopeService.js";

/** Only these roles may change basic or allowances. From employeeMutationService.js:35. */
export const PAYROLL_ROLES = new Set(["admin", "hr"]);

/** Compensation fields, gated by PAYROLL_ROLES. */
export const COMPENSATION_FIELDS = Object.freeze(["basic", "allowances"]);

/**
 * Which roles each role may act on. Preserved verbatim from ROLE_ASSIGNMENTS at
 * functions/employeeMutationService.js:28-34.
 */
const ROLE_ASSIGNMENTS = Object.freeze({
  admin: new Set(["admin", "hr", "manager", "tl", "employee"]),
  hr: new Set(["manager", "tl", "employee"]),
  manager: new Set(["tl", "employee"]),
  tl: new Set(["employee"]),
  employee: new Set(),
});

/**
 * Deletion authority. AMENDED from Firestore, where only admin and HR could delete at all
 * (employeeMutationService.js:421-423) and manager/tl fell through to a denial.
 *
 *   admin    anyone but themselves
 *   hr       manager, tl, employee
 *   manager  tl and employee in their own department   <- new
 *   tl       employees assigned to them                <- new
 *   employee nobody
 */
const DELETABLE_ROLES = Object.freeze({
  admin: new Set(["admin", "hr", "manager", "tl", "employee"]),
  hr: new Set(["manager", "tl", "employee"]),
  manager: new Set(["tl", "employee"]),
  tl: new Set(["employee"]),
  employee: new Set(),
});

const denied = (code, message) => new HttpError(403, code, message);

function assertActingRoleKnown(principal) {
  if (!principal?.role || !ROLE_ASSIGNMENTS[principal.role]) {
    throw denied("role_not_allowed", "This account cannot manage employees.");
  }
  if (!principal.employeeId) {
    throw denied("role_not_allowed", "This account is not linked to an employee record.");
  }
}

/**
 * Compensation gate. Firestore raised COMPENSATION_CHANGE_DENIED at
 * employeeMutationService.js:452-463; the name and the meaning are preserved.
 */
export function assertCompensationAuthority(principal, target, changes) {
  if (PAYROLL_ROLES.has(principal.role)) return;

  const changed = COMPENSATION_FIELDS.filter((field) => {
    if (!Object.hasOwn(changes, field)) return false;
    return Number(changes[field]) !== Number(target?.[field]);
  });

  if (changed.length > 0) {
    throw denied(
      "compensation_change_denied",
      `Only admin and hr may change ${changed.join(" and ")}.`,
    );
  }
}

/**
 * Update authority.
 *
 * Preserved verbatim from Firestore: SELF_ROLE_CHANGE_DENIED
 * (employeeMutationService.js:426-428) and the compensation gate. The role hierarchy and
 * department/team scoping match assertHierarchy (:426-447).
 */
export function assertCanUpdateEmployee(principal, target, changes = {}) {
  assertActingRoleKnown(principal);
  if (!target?.id) throw new HttpError(404, "not_found", "Employee not found.");

  const nextRole = Object.hasOwn(changes, "role") ? changes.role : target.role;

  // SELF_ROLE_CHANGE_DENIED -- nobody may change their own role, including an admin.
  if (principal.employeeId === target.id && nextRole !== target.role) {
    throw denied("self_role_change_denied", "You cannot change your own role.");
  }

  // Editing your own non-role fields is allowed; the scope check below would otherwise
  // deny a manager editing their own phone number.
  const editingSelf = principal.employeeId === target.id;

  if (!editingSelf) {
    const assignable = ROLE_ASSIGNMENTS[principal.role];
    if (!assignable.has(target.role) || !assignable.has(nextRole)) {
      throw denied("employee_scope_denied", "You cannot manage an employee with this role.");
    }
    if (!scopeCoversEmployee(principal, target)) {
      throw denied("employee_scope_denied", "This employee is outside your scope.");
    }
    // A manager may not move an employee out of their department, and a tl may not
    // reassign a member away from themselves.
    if (Object.hasOwn(changes, "department_id")
      && principal.role === "manager"
      && changes.department_id !== principal.departmentId) {
      throw denied("employee_scope_denied", "You cannot move an employee out of your department.");
    }
    if (Object.hasOwn(changes, "team_lead_id")
      && principal.role === "tl"
      && changes.team_lead_id !== principal.employeeId) {
      throw denied("employee_scope_denied", "You cannot reassign a member to another team lead.");
    }
  }

  assertCompensationAuthority(principal, target, changes);
}

/**
 * Deletion authority, including the team-lead reassignment obligation.
 *
 * `members` is every employee whose team_lead_id is the target, already scoped to live
 * rows by the caller.
 *
 * IMPORTANT: employees are soft-deleted (decision D1), and ON DELETE RESTRICT does not
 * fire on an UPDATE that sets deleted_at. The foreign key
 * employees_team_lead_department_foreign_key therefore does NOT protect this path. The
 * reassignment requirement below is the only thing preventing orphaned members, which is
 * why it is enforced here rather than left to the database.
 */
export function assertCanDeleteEmployee(principal, target, options = {}) {
  const { members = [], replacementTeamLeadId = null } = options;

  assertActingRoleKnown(principal);
  if (!target?.id) throw new HttpError(404, "not_found", "Employee not found.");

  // SELF_DELETE_DENIED -- preserved from employeeMutationService.js:418-420.
  if (principal.employeeId === target.id) {
    throw denied("self_delete_denied", "You cannot delete your own employee record.");
  }

  const deletable = DELETABLE_ROLES[principal.role];
  if (!deletable.has(target.role)) {
    throw denied("employee_scope_denied", "You cannot delete an employee with this role.");
  }
  if (!scopeCoversEmployee(principal, target)) {
    throw denied("employee_scope_denied", "This employee is outside your scope.");
  }

  if (target.role !== "tl") return { replacementTeamLeadId: null, reassignedMemberIds: [] };

  // Deleting a team lead requires a replacement drawn from that lead's own members.
  const liveMembers = members.filter((member) => member.id !== target.id);

  if (liveMembers.length === 0) {
    // A team lead with no members has nobody to orphan and nobody to promote. Decision
    // D16 is still open, so this is refused rather than guessed at.
    throw new HttpError(
      409,
      "team_lead_replacement_undecided",
      "Deleting a team lead with no members is not yet defined (decision D16).",
    );
  }

  if (!replacementTeamLeadId) {
    throw new HttpError(
      400,
      "team_lead_replacement_required",
      "Deleting a team lead requires a replacement chosen from their own members.",
    );
  }

  const replacement = liveMembers.find((member) => member.id === replacementTeamLeadId);
  if (!replacement) {
    throw denied(
      "team_lead_replacement_invalid",
      "The replacement team lead must be one of this team lead's own members.",
    );
  }

  return {
    replacementTeamLeadId,
    reassignedMemberIds: liveMembers
      .filter((member) => member.id !== replacementTeamLeadId)
      .map((member) => member.id),
  };
}

export const roleAssignments = ROLE_ASSIGNMENTS;
export const deletableRoles = DELETABLE_ROLES;
