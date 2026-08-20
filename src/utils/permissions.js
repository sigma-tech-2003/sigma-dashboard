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

const isAssignedToProject = (project, employeeId) =>
  Array.isArray(project.assignedEmployeeIds)
  && project.assignedEmployeeIds.some((id) => String(id) === String(employeeId));

const isTeamLeadProject = (user, project, employees) => {
  const teamLeadId = String(user.id);
  if (project.teamLeadId != null && String(project.teamLeadId) === teamLeadId) return true;

  const assignedEmployeeIds = new Set(
    (Array.isArray(project.assignedEmployeeIds) ? project.assignedEmployeeIds : [])
      .map((id) => String(id)),
  );

  return (employees || []).some((employee) =>
    employee.teamLeadId != null
    && String(employee.teamLeadId) === teamLeadId
    && assignedEmployeeIds.has(String(employee.id)),
  );
};

export function scopeProjects(user, projects, employees) {
  if (isAdminRole(user.role)) return projects;
  if (user.role === "manager") {
    return projects.filter((project) => project.department === user.dept);
  }
  if (user.role === "tl") {
    return projects.filter((project) => isTeamLeadProject(user, project, employees));
  }
  if (user.role === "employee") {
    return projects.filter((project) => isAssignedToProject(project, user.id));
  }
  return [];
}

export function canManageProject(user, project, employees) {
  if (isAdminRole(user.role)) return true;
  if (user.role === "manager") return project.department === user.dept;
  if (user.role === "tl") return isTeamLeadProject(user, project, employees);
  return false;
}

const hasProjectId = (kpi) =>
  kpi.projectId != null && String(kpi.projectId).trim() !== "";

export function scopeProjectKpis(user, kpis, projects, employees) {
  if (isAdminRole(user.role)) return kpis;
  if (user.role === "employee") {
    return kpis.filter((kpi) =>
      kpi.empId != null && user.id != null && String(kpi.empId) === String(user.id),
    );
  }

  const visibleProjectIds = new Set(
    scopeProjects(user, projects, employees)
      .filter((project) => project.id != null)
      .map((project) => String(project.id)),
  );
  const legacyKpis = kpis.filter((kpi) => !hasProjectId(kpi));
  const visibleLegacyKpis = new Set(scopeByEmployee(user, legacyKpis, employees));

  return kpis.filter((kpi) =>
    hasProjectId(kpi)
      ? visibleProjectIds.has(String(kpi.projectId))
      : visibleLegacyKpis.has(kpi),
  );
}

export function canRateProjectKpi(user, kpi, projects, employees) {
  if (!["admin", "hr", "manager", "tl"].includes(user.role)) return false;
  if (!hasProjectId(kpi) || kpi.empId == null) return false;

  const project = projects.find((candidate) =>
    candidate.id != null && String(candidate.id) === String(kpi.projectId),
  );
  if (!project) return false;

  const employeeIsAssigned = Array.isArray(project.assignedEmployeeIds)
    && project.assignedEmployeeIds.some((id) => String(id) === String(kpi.empId));

  return employeeIsAssigned && canManageProject(user, project, employees);
}

// Which roles can `user` assign when creating a new employee record?
export function assignableRoles(user) {
  if (user.role === "admin")   return ["admin", "hr", "manager", "tl", "employee"];
  if (user.role === "hr")      return ["manager", "tl", "employee"];
  if (user.role === "manager") return ["tl", "employee"];
  if (user.role === "tl")      return ["employee"];
  return [];
}

// ─── Action permissions ──────────────────────────────────────────────────────
const PERMS = {
  manageEmployees:     ["admin", "hr", "manager", "tl"],
  deleteEmployees:     ["admin", "hr"],
  manageDepartments:   ["admin"],
  manageDesignations:  ["admin", "hr"],
  promoteTL:           ["admin", "hr", "manager"],
  assignManager:       ["admin", "hr"],
  assignTasks:         ["admin", "hr", "manager", "tl"],
  reviewTasks:         ["admin", "hr", "manager", "tl"],
  recommendLeave:      ["tl"],
  approveLeave:        ["admin", "hr", "manager", "tl"],
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
  if (user.role === "admin") return true;
  if (user.role === "hr") return ["manager", "tl", "employee"].includes(emp.role);
  if (user.role === "manager") {
    return emp.dept === user.dept && ["tl", "employee"].includes(emp.role);
  }
  if (user.role === "tl") {
    return emp.dept === user.dept && emp.teamLeadId === user.id && emp.role === "employee";
  }
  return false;
}
