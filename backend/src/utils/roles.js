export const USER_ROLES = Object.freeze([
  "admin",
  "hr",
  "manager",
  "tl",
  "employee",
]);

export const COMPANY_WIDE_ROLES = new Set(["admin", "hr"]);
export const DEPARTMENT_SCOPED_ROLES = new Set(["manager"]);
export const TEAM_SCOPED_ROLES = new Set(["tl"]);
