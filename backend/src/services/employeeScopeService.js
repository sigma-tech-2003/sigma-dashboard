import {
  COMPANY_WIDE_ROLES,
  DEPARTMENT_SCOPED_ROLES,
  TEAM_SCOPED_ROLES,
} from "../utils/roles.js";

/**
 * The five role scopes from docs/schema-design.md section 6.
 *
 *   admin     global      (no predicate)
 *   hr        global      (no predicate)
 *   manager   department  employees.department_id = principal.departmentId
 *   tl        own members employees.team_lead_id = principal.employeeId OR employees.id = principal.employeeId
 *   employee  self        employees.id = principal.employeeId
 *
 * This replaces canReadEmployee (firestore.rules:215-234) and the per-role read plans in
 * src/firebase/useFirestore.js:510-549.
 */
export function getEmployeeScope(principal) {
  if (!principal?.employeeId || !principal?.role) return null;

  if (COMPANY_WIDE_ROLES.has(principal.role)) {
    return { type: "company" };
  }
  if (DEPARTMENT_SCOPED_ROLES.has(principal.role)) {
    if (!principal.departmentId) return null;
    return { type: "department", departmentId: principal.departmentId };
  }
  if (TEAM_SCOPED_ROLES.has(principal.role)) {
    return { type: "team", teamLeadId: principal.employeeId };
  }
  if (principal.role === "employee") {
    return { type: "self", employeeId: principal.employeeId };
  }
  return null;
}

/**
 * Builds a parameterised WHERE fragment for the principal's scope.
 *
 * Returns { text, values, nextParameterIndex }. `text` is "TRUE" for company-wide roles
 * so it can always be concatenated into a WHERE clause without the caller branching.
 * Returns null when the principal has no valid scope; callers must treat that as a denial
 * rather than as "no filter" -- the difference between an unscoped admin and an
 * unrecognised role is the whole point.
 *
 * `startParameterIndex` lets a caller place this fragment after existing placeholders.
 *
 * For leaves, attendance, payroll and kpis, join to employees and pass that alias: section
 * 6 states the same predicate applies via employee_id.
 */
export function buildEmployeeScopeFilter(principal, options = {}) {
  const { alias = "employees", startParameterIndex = 1 } = options;
  const scope = getEmployeeScope(principal);
  if (!scope) return null;

  const column = (name) => `${alias}.${name}`;
  let index = startParameterIndex;

  switch (scope.type) {
    case "company":
      return { text: "TRUE", values: [], nextParameterIndex: index };

    case "department":
      return {
        text: `${column("department_id")} = $${index}`,
        values: [scope.departmentId],
        nextParameterIndex: index + 1,
      };

    case "team": {
      // A team lead sees their members and themselves. Firestore expressed the same pair
      // at firestore.rules:226-231.
      const teamLeadPlaceholder = `$${index}`;
      index += 1;
      const selfPlaceholder = `$${index}`;
      index += 1;
      return {
        text: `(${column("team_lead_id")} = ${teamLeadPlaceholder} OR ${column("id")} = ${selfPlaceholder})`,
        values: [scope.teamLeadId, scope.teamLeadId],
        nextParameterIndex: index,
      };
    }

    case "self":
      return {
        text: `${column("id")} = $${index}`,
        values: [scope.employeeId],
        nextParameterIndex: index + 1,
      };

    default:
      return null;
  }
}

/**
 * True when the principal's scope covers the given employee row. The in-memory twin of
 * buildEmployeeScopeFilter, for authorisation decisions about a row already loaded.
 * Both must agree; the tests assert they do for every role.
 */
export function scopeCoversEmployee(principal, employee) {
  const scope = getEmployeeScope(principal);
  if (!scope || !employee?.id) return false;

  switch (scope.type) {
    case "company":
      return true;
    case "department":
      return employee.department_id === scope.departmentId;
    case "team":
      return employee.team_lead_id === scope.teamLeadId || employee.id === scope.teamLeadId;
    case "self":
      return employee.id === scope.employeeId;
    default:
      return false;
  }
}
