import {
  COMPANY_WIDE_ROLES,
  DEPARTMENT_SCOPED_ROLES,
  TEAM_SCOPED_ROLES,
} from "../utils/roles.js";

export function getEmployeeScope(principal) {
  if (!principal?.employeeId || !principal?.role || !principal?.companyId) return null;
  if (COMPANY_WIDE_ROLES.has(principal.role)) return { type: "company" };
  if (DEPARTMENT_SCOPED_ROLES.has(principal.role) && principal.departmentId) {
    return { type: "department", departmentId: principal.departmentId };
  }
  if (TEAM_SCOPED_ROLES.has(principal.role) && principal.teamId) {
    return { type: "team", teamId: principal.teamId };
  }
  if (principal.role === "employee") return { type: "self", employeeId: principal.employeeId };
  return null;
}
