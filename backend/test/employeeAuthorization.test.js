import assert from "node:assert/strict";
import test from "node:test";
import {
  PAYROLL_ROLES,
  assertCanDeleteEmployee,
  assertCanUpdateEmployee,
  assertCompensationAuthority,
} from "../src/services/employeeAuthorizationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

const DEPARTMENT = "dept-1";
const OTHER_DEPARTMENT = "dept-2";
const SELF = "emp-self";

const principalFor = (role, overrides = {}) => ({
  userId: "user-id",
  employeeId: SELF,
  role,
  departmentId: DEPARTMENT,
  isTeamLead: role === "tl",
  ...overrides,
});

const employee = (overrides = {}) => ({
  id: "emp-target",
  role: "employee",
  department_id: DEPARTMENT,
  team_lead_id: null,
  basic: 100000,
  allowances: 5000,
  ...overrides,
});

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code;
  }
};

// ---------------------------------------------------------------------------
// Gates preserved verbatim from the Firestore callables
// ---------------------------------------------------------------------------

test("SELF_DELETE_DENIED: no role may delete their own record, not even admin", () => {
  // functions/employeeMutationService.js:418-420
  for (const role of USER_ROLES) {
    const principal = principalFor(role);
    const self = employee({ id: SELF, role });
    assert.equal(
      codeOf(() => assertCanDeleteEmployee(principal, self)),
      "self_delete_denied",
      `${role} must not delete themselves`,
    );
  }
});

test("SELF_ROLE_CHANGE_DENIED: no role may change their own role", () => {
  // functions/employeeMutationService.js:426-428
  for (const role of USER_ROLES) {
    const principal = principalFor(role);
    const self = employee({ id: SELF, role });
    // The requested role must actually differ from the current one, or there is no
    // role change to deny.
    const differentRole = USER_ROLES.find((candidate) => candidate !== role);
    assert.equal(
      codeOf(() => assertCanUpdateEmployee(principal, self, { role: differentRole })),
      "self_role_change_denied",
      `${role} must not change their own role to ${differentRole}`,
    );
  }
});

test("editing your own non-role fields is still allowed", () => {
  // The self-role gate must not accidentally lock someone out of their own profile.
  const principal = principalFor("employee");
  const self = employee({ id: SELF, role: "employee" });
  assert.doesNotThrow(() => assertCanUpdateEmployee(principal, self, { phone: "0300" }));
});

test("PAYROLL_ROLES: only admin and hr may change basic or allowances", () => {
  // functions/employeeMutationService.js:35 and :452-463
  assert.deepEqual([...PAYROLL_ROLES].sort(), ["admin", "hr"]);

  for (const role of USER_ROLES) {
    const principal = principalFor(role);
    const target = employee();
    const allowed = PAYROLL_ROLES.has(role);

    for (const field of ["basic", "allowances"]) {
      const code = codeOf(() =>
        assertCompensationAuthority(principal, target, { [field]: target[field] + 1 }));
      assert.equal(
        code,
        allowed ? null : "compensation_change_denied",
        `${role} changing ${field}`,
      );
    }
  }
});

test("submitting compensation fields unchanged is not a compensation change", () => {
  // A full-object PATCH from a manager must not be rejected just for echoing the values.
  const principal = principalFor("manager");
  const target = employee();
  assert.doesNotThrow(() => assertCompensationAuthority(principal, target, {
    basic: target.basic,
    allowances: target.allowances,
  }));
});

// ---------------------------------------------------------------------------
// Deletion authority -- DELIBERATELY different from auth-matrix.md
// ---------------------------------------------------------------------------

// auth-matrix.md records that Firestore allows deletion only to admin and hr
// (functions/employeeMutationService.js:421-423); manager and tl fall through to a
// denial. The settled decision widens this. Each row below is either "matches Firestore"
// or "deliberate change", and says which.
const DELETION_MATRIX = [
  { actor: "admin",    target: "manager",  sameDept: true,  ofMine: false, allowed: true,  basis: "matches Firestore" },
  { actor: "admin",    target: "employee", sameDept: false, ofMine: false, allowed: true,  basis: "matches Firestore" },
  { actor: "hr",       target: "manager",  sameDept: true,  ofMine: false, allowed: true,  basis: "matches Firestore" },
  { actor: "hr",       target: "admin",    sameDept: true,  ofMine: false, allowed: false, basis: "matches Firestore: hr may not delete admin" },
  { actor: "manager",  target: "employee", sameDept: true,  ofMine: false, allowed: true,  basis: "DELIBERATE CHANGE: Firestore denied manager deletion" },
  { actor: "manager",  target: "tl",       sameDept: true,  ofMine: false, allowed: true,  basis: "DELIBERATE CHANGE" },
  { actor: "manager",  target: "employee", sameDept: false, ofMine: false, allowed: false, basis: "scoped to own department" },
  { actor: "manager",  target: "manager",  sameDept: true,  ofMine: false, allowed: false, basis: "decision D13: managers may not delete managers" },
  { actor: "tl",       target: "employee", sameDept: true,  ofMine: true,  allowed: true,  basis: "DELIBERATE CHANGE: Firestore denied tl deletion" },
  { actor: "tl",       target: "employee", sameDept: true,  ofMine: false, allowed: false, basis: "only members assigned to them" },
  { actor: "tl",       target: "tl",       sameDept: true,  ofMine: false, allowed: false, basis: "tl may only delete employees" },
  { actor: "employee", target: "employee", sameDept: true,  ofMine: false, allowed: false, basis: "employees delete nobody" },
];

test("deletion authority matrix, each cell matching Firestore or a recorded decision", () => {
  for (const row of DELETION_MATRIX) {
    const principal = principalFor(row.actor);
    const target = employee({
      role: row.target,
      department_id: row.sameDept ? DEPARTMENT : OTHER_DEPARTMENT,
      team_lead_id: row.ofMine ? SELF : "other-tl",
    });

    // Deleting a tl additionally requires the replacement flow. Supply a valid one so
    // this matrix isolates deletion AUTHORITY; the replacement rules are covered below.
    const options = row.target === "tl"
      ? {
        members: [employee({ id: "member-1", team_lead_id: target.id })],
        replacementTeamLeadId: "member-1",
      }
      : {};

    const code = codeOf(() => assertCanDeleteEmployee(principal, target, options));
    const label = `${row.actor} deleting ${row.target} (${row.basis})`;

    if (row.allowed) {
      assert.equal(code, null, label);
    } else {
      assert.equal(code, "employee_scope_denied", label);
    }
  }
});

// ---------------------------------------------------------------------------
// Team-lead reassignment -- a service obligation, not a database guarantee
// ---------------------------------------------------------------------------

test("deleting a team lead requires a replacement", () => {
  // employees are soft-deleted (D1), so ON DELETE RESTRICT never fires on this path.
  // Nothing but this check prevents orphaned members.
  const principal = principalFor("manager");
  const target = employee({ id: "tl-1", role: "tl" });
  const members = [
    employee({ id: "m-1", team_lead_id: "tl-1" }),
    employee({ id: "m-2", team_lead_id: "tl-1" }),
  ];

  assert.equal(
    codeOf(() => assertCanDeleteEmployee(principal, target, { members })),
    "team_lead_replacement_required",
  );
});

test("the replacement must be one of that team lead's own members", () => {
  const principal = principalFor("manager");
  const target = employee({ id: "tl-1", role: "tl" });
  const members = [employee({ id: "m-1", team_lead_id: "tl-1" })];

  assert.equal(
    codeOf(() => assertCanDeleteEmployee(principal, target, {
      members,
      replacementTeamLeadId: "outsider",
    })),
    "team_lead_replacement_invalid",
  );
});

test("a valid replacement returns the remaining members to reassign", () => {
  const principal = principalFor("manager");
  const target = employee({ id: "tl-1", role: "tl" });
  const members = [
    employee({ id: "m-1", team_lead_id: "tl-1" }),
    employee({ id: "m-2", team_lead_id: "tl-1" }),
    employee({ id: "m-3", team_lead_id: "tl-1" }),
  ];

  const result = assertCanDeleteEmployee(principal, target, {
    members,
    replacementTeamLeadId: "m-1",
  });

  assert.equal(result.replacementTeamLeadId, "m-1");
  // The promoted member is not reassigned to themselves.
  assert.deepEqual(result.reassignedMemberIds.sort(), ["m-2", "m-3"]);
});

test("deleting a team lead with no members is refused pending decision D16", () => {
  // Reported rather than guessed: there is no member to promote, and whether that should
  // permit deletion outright is undecided.
  const principal = principalFor("manager");
  const target = employee({ id: "tl-1", role: "tl" });
  assert.equal(
    codeOf(() => assertCanDeleteEmployee(principal, target, { members: [] })),
    "team_lead_replacement_undecided",
  );
});

// ---------------------------------------------------------------------------
// Update scoping
// ---------------------------------------------------------------------------

test("a manager cannot move an employee out of their department", () => {
  const principal = principalFor("manager");
  const target = employee();
  assert.equal(
    codeOf(() => assertCanUpdateEmployee(principal, target, { department_id: OTHER_DEPARTMENT })),
    "employee_scope_denied",
  );
});

test("a team lead cannot reassign a member to another team lead", () => {
  // functions/employeeMutationService.js:439-447 requires teamLeadId to equal the
  // principal both before and after.
  const principal = principalFor("tl");
  const target = employee({ team_lead_id: SELF });
  assert.equal(
    codeOf(() => assertCanUpdateEmployee(principal, target, { team_lead_id: "other-tl" })),
    "employee_scope_denied",
  );
  assert.doesNotThrow(() => assertCanUpdateEmployee(principal, target, { team_lead_id: SELF }));
});

test("update role hierarchy matches ROLE_ASSIGNMENTS", () => {
  // functions/employeeMutationService.js:28-34
  const expectations = [
    { actor: "hr", target: "admin", allowed: false },
    { actor: "hr", target: "manager", allowed: true },
    { actor: "manager", target: "tl", allowed: true },
    { actor: "manager", target: "manager", allowed: false },
    { actor: "tl", target: "employee", allowed: true },
    { actor: "tl", target: "tl", allowed: false },
    { actor: "employee", target: "employee", allowed: false },
  ];

  for (const { actor, target, allowed } of expectations) {
    const principal = principalFor(actor);
    const row = employee({ role: target, team_lead_id: actor === "tl" ? SELF : null });
    const code = codeOf(() => assertCanUpdateEmployee(principal, row, { phone: "0300" }));
    assert.equal(
      code,
      allowed ? null : "employee_scope_denied",
      `${actor} updating ${target}`,
    );
  }
});
