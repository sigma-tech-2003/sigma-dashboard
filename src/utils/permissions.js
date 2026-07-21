// src/utils/permissions.js
// Central role & permission logic. Roles:
//   admin    — Super Admin: full system access
//   hr       — HR: same as admin except system settings & audit logs
//   manager  — Department Manager: scoped to their own department
//   tl       — Team Lead: scoped to their own department, limited actions
//   employee — Employee: own data only

export const ROLES = {
  ADMIN: "admin",
  HR: "hr",
  MANAGER: "manager",
  TL: "tl",
  EMPLOYEE: "employee",
};

export const ROLE_LABELS = {
  admin: "Super Admin",
  hr: "HR",
  manager: "Manager",
  tl: "Team Lead",
  employee: "Employee",
};

export const isAdminRole   = (role) => role === "admin" || role === "hr";
export const isManagerial  = (role) => ["admin", "hr", "manager", "tl"].includes(role);
export const isDeptScoped  = (role) => role === "manager" || role === "tl";

// ─── Data scoping ────────────────────────────────────────────────────────────
// Which employees can this user see?
//   admin/hr  → everyone
//   manager   → everyone in their own department (all roles within it)
//   tl        → only employees on their own team (matched via teamLeadId),
//               falling back to nothing extra if the field isn't set yet
//   employee  → only themselves
export function scopeEmployees(user, employees) {
  if (isAdminRole(user.role)) return employees;
  if (user.role === "manager") return employees.filter((e) => e.dept === user.dept);
  if (user.role === "tl") return employees.filter((e) => e.teamLeadId === user.id || e.id === user.id);
  return employees.filter((e) => e.id === user.id);
}

// Filter any rows that carry an empId down to what this user may see.
export function scopeByEmployee(user, rows, employees) {
  if (isAdminRole(user.role)) return rows;
  const scopedIds = new Set(scopeEmployees(user, employees).map((e) => String(e.id)));
  return rows.filter((r) => scopedIds.has(String(r.empId)));
}

// Which roles can `user` assign when creating a new employee record?
export function assignableRoles(user) {
  if (user.role === "admin")   return ["admin", "hr", "manager", "tl", "employee"];
  if (user.role === "hr")      return ["manager", "tl", "employee"];
  if (user.role === "manager") return ["tl"];
  if (user.role === "tl")      return ["employee"];
  return [];
}

// ─── Action permissions ──────────────────────────────────────────────────────
const PERMS = {
  manageEmployees:     ["admin", "hr", "manager", "tl"],
  deleteEmployees:     ["admin", "hr"],
  manageDepartments:   ["admin", "hr"],
  manageDesignations:  ["admin", "hr"],
  promoteTL:           ["admin", "hr", "manager"],
  assignManager:       ["admin", "hr"],
  assignTasks:         ["admin", "hr", "manager", "tl"],
  reviewTasks:         ["admin", "hr", "manager", "tl"],
  recommendLeave:      ["tl"],
  approveLeave:        ["admin", "hr", "manager"],
  recommendAttendance: ["tl"],
  approveAttendance:   ["admin", "hr", "manager"],
  manageAttendance:    ["admin", "hr", "manager"],
  managePayroll:       ["admin", "hr"],
  manageKpis:          ["admin", "hr", "manager", "tl"],
  viewReports:         ["admin", "hr", "manager", "tl"],
  viewAnalytics:       ["admin", "hr", "manager"],
  manageAnnouncements: ["admin", "hr", "manager"],
  manageHolidays:      ["admin", "hr"],
  viewAuditLogs:       ["admin"],
  manageSettings:      ["admin"],
};

export const can = (user, action) => (PERMS[action] || []).includes(user?.role);

// Can `user` manage (edit / promote) this specific employee?
//   manager can edit Team Leads within their own department
//   tl can edit employees on their own team
export function canManageEmployee(user, emp) {
  if (isAdminRole(user.role)) return true;
  if (user.role === "manager") return emp.dept === user.dept && emp.role === "tl";
  if (user.role === "tl") return emp.teamLeadId === user.id && emp.role === "employee";
  return false;
}
