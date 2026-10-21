// Who is offered "Reset password" on the Employees page (D41). This only decides whether to SHOW the control: the
// API enforces the same rule (employeeAuthorizationService.assertCanResetPassword) and is the authority.
//
//   admin  anyone but themselves
//   hr     manager, tl, employee (never an admin or another hr)
//   others nobody
//
// The rule is the role-assignment table the create form already follows (permissions.assignableRoles).

const RESETTABLE_ROLES = Object.freeze({
  admin: new Set(["admin", "hr", "manager", "tl", "employee"]),
  hr: new Set(["manager", "tl", "employee"]),
});

export function canResetPassword(user, employee) {
  if (!user || !employee) return false;
  if (user.id != null && user.id === employee.id) return false;
  return RESETTABLE_ROLES[user.role]?.has(employee.role) === true;
}
