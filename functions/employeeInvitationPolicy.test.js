/* global require */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmployeeInvitationPolicyError,
  buildEmployeeInvitationProfile,
} = require("./employeeInvitationPolicy");

const activeCreator = (role, overrides = {}) => ({
  role,
  status: "active",
  dept: "Engineering",
  ...overrides,
});

const validInput = (overrides = {}) => ({
  name: "  Noor Ahmed  ",
  email: "  NOOR.AHMED@EXAMPLE.COM ",
  phone: "  +92 300 1234567  ",
  dept: "Engineering",
  pos: "  Software Engineer  ",
  basic: "120000.50",
  allowances: "15000",
  joinDate: "2026-08-21",
  role: "employee",
  status: "ACTIVE",
  ...overrides,
});

const existingEmployees = [
  { id: 101, role: "tl", dept: "Engineering", email: "lead@example.com" },
  { id: "202", role: "tl", dept: "Sales", email: "sales.lead@example.com" },
  { id: 303, role: "employee", dept: "Engineering", email: "member@example.com" },
];

function expectPolicyError(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof EmployeeInvitationPolicyError);
    assert.equal(error.name, "EmployeeInvitationPolicyError");
    assert.equal(error.code, code);
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 0);
    return true;
  });
}

test("returns a strictly whitelisted normalized profile without mutating inputs", () => {
  const creator = activeCreator("admin");
  const input = validInput({ teamLeadId: "101" });
  const employees = existingEmployees.map((employee) => ({ ...employee }));
  const creatorBefore = { ...creator };
  const inputBefore = { ...input };
  const employeesBefore = employees.map((employee) => ({ ...employee }));

  const profile = buildEmployeeInvitationProfile(creator, "admin-doc", input, employees);

  assert.deepEqual(profile, {
    name: "Noor Ahmed",
    email: "noor.ahmed@example.com",
    phone: "+92 300 1234567",
    dept: "Engineering",
    pos: "Software Engineer",
    basic: 120000.5,
    allowances: 15000,
    joinDate: "2026-08-21",
    role: "employee",
    status: "active",
    teamLeadId: "101",
  });
  assert.deepEqual(Object.keys(profile), [
    "name",
    "email",
    "phone",
    "dept",
    "pos",
    "basic",
    "allowances",
    "joinDate",
    "role",
    "status",
    "teamLeadId",
  ]);
  assert.deepEqual(creator, creatorBefore);
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(employees, employeesBefore);
});

test("Admin may create every supported role", async (t) => {
  for (const role of ["admin", "hr", "manager", "tl", "employee"]) {
    await t.test(role, () => {
      const profile = buildEmployeeInvitationProfile(
        activeCreator("admin"),
        "admin-doc",
        validInput({ role }),
        existingEmployees,
      );
      assert.equal(profile.role, role);
    });
  }
});

test("HR may create only Manager, Team Lead, and Employee", async (t) => {
  for (const role of ["manager", "tl", "employee"]) {
    await t.test(`allows ${role}`, () => {
      const profile = buildEmployeeInvitationProfile(
        activeCreator("hr"),
        "hr-doc",
        validInput({ role }),
        existingEmployees,
      );
      assert.equal(profile.role, role);
    });
  }
  for (const role of ["admin", "hr"]) {
    await t.test(`rejects ${role}`, () => {
      expectPolicyError(
        () => buildEmployeeInvitationProfile(
          activeCreator("hr"),
          "hr-doc",
          validInput({ role }),
          existingEmployees,
        ),
        "CREATOR_NOT_AUTHORIZED",
      );
    });
  }
});

test("Manager may create only Team Lead and Employee in their own department", () => {
  for (const role of ["tl", "employee"]) {
    const profile = buildEmployeeInvitationProfile(
      activeCreator("manager"),
      "manager-doc",
      validInput({ role, dept: "Engineering" }),
      existingEmployees,
    );
    assert.equal(profile.role, role);
    assert.equal(profile.dept, "Engineering");
  }

  expectPolicyError(
    () => buildEmployeeInvitationProfile(
      activeCreator("manager"),
      "manager-doc",
      validInput({ role: "manager" }),
      existingEmployees,
    ),
    "CREATOR_NOT_AUTHORIZED",
  );
  expectPolicyError(
    () => buildEmployeeInvitationProfile(
      activeCreator("manager"),
      "manager-doc",
      validInput({ dept: "Sales" }),
      existingEmployees,
    ),
    "SCOPE_VIOLATION",
  );
});

test("Manager department is forced from trusted creator data when omitted", () => {
  const input = validInput();
  delete input.dept;
  const profile = buildEmployeeInvitationProfile(
    activeCreator("manager"),
    "manager-doc",
    input,
    existingEmployees,
  );
  assert.equal(profile.dept, "Engineering");
});

test("Team Lead may create only an Employee in their department and assigns their document ID", () => {
  const profile = buildEmployeeInvitationProfile(
    activeCreator("tl"),
    101,
    validInput({ teamLeadId: "101" }),
    existingEmployees,
  );
  assert.equal(profile.role, "employee");
  assert.equal(profile.dept, "Engineering");
  assert.equal(profile.teamLeadId, "101");

  expectPolicyError(
    () => buildEmployeeInvitationProfile(
      activeCreator("tl"),
      101,
      validInput({ teamLeadId: 202 }),
      existingEmployees,
    ),
    "SCOPE_VIOLATION",
  );
  expectPolicyError(
    () => buildEmployeeInvitationProfile(
      activeCreator("tl"),
      101,
      validInput({ dept: "Sales" }),
      existingEmployees,
    ),
    "SCOPE_VIOLATION",
  );
  expectPolicyError(
    () => buildEmployeeInvitationProfile(
      activeCreator("tl"),
      101,
      validInput({ role: "tl" }),
      existingEmployees,
    ),
    "CREATOR_NOT_AUTHORIZED",
  );
});

test("Team Lead scope is enforced even when department and team are omitted", () => {
  const input = validInput();
  delete input.dept;
  delete input.teamLeadId;
  const profile = buildEmployeeInvitationProfile(
    activeCreator("tl"),
    "tl-document-id",
    input,
    existingEmployees,
  );
  assert.equal(profile.dept, "Engineering");
  assert.equal(profile.teamLeadId, "tl-document-id");
});

test("Employee cannot create any role", () => {
  expectPolicyError(
    () => buildEmployeeInvitationProfile(
      activeCreator("employee"),
      "employee-doc",
      validInput(),
      existingEmployees,
    ),
    "CREATOR_NOT_AUTHORIZED",
  );
});

test("inactive and malformed creators are rejected", () => {
  for (const status of ["inactive", "suspended", "", null]) {
    expectPolicyError(
      () => buildEmployeeInvitationProfile(
        activeCreator("admin", { status }),
        "admin-doc",
        validInput(),
        existingEmployees,
      ),
      "CREATOR_NOT_ACTIVE",
    );
  }
  expectPolicyError(
    () => buildEmployeeInvitationProfile(null, "admin-doc", validInput(), existingEmployees),
    "INVALID_ARGUMENT",
  );
  expectPolicyError(
    () => buildEmployeeInvitationProfile(activeCreator("admin"), "", validInput(), existingEmployees),
    "INVALID_ARGUMENT",
  );
});

test("Admin, HR, and Manager Team Lead assignments require a real Team Lead in the candidate department", () => {
  for (const creator of [activeCreator("admin"), activeCreator("hr"), activeCreator("manager")]) {
    const profile = buildEmployeeInvitationProfile(
      creator,
      "creator-doc",
      validInput({ teamLeadId: "101" }),
      existingEmployees,
    );
    assert.equal(profile.teamLeadId, "101");

    for (const teamLeadId of ["missing", "303", "202"]) {
      expectPolicyError(
        () => buildEmployeeInvitationProfile(
          creator,
          "creator-doc",
          validInput({ teamLeadId }),
          existingEmployees,
        ),
        "INVALID_TEAM_LEAD",
      );
    }
  }
});

test("Team Lead ID comparisons normalize mixed numeric and string values", () => {
  const profile = buildEmployeeInvitationProfile(
    activeCreator("admin"),
    "admin-doc",
    validInput({ teamLeadId: "101" }),
    [{ id: 101, role: "TL", dept: "Engineering", email: "lead@example.com" }],
  );
  assert.equal(profile.teamLeadId, "101");
});

test("Team Lead assignment is rejected for non-Employee candidates", () => {
  expectPolicyError(
    () => buildEmployeeInvitationProfile(
      activeCreator("admin"),
      "admin-doc",
      validInput({ role: "manager", teamLeadId: 101 }),
      existingEmployees,
    ),
    "INVALID_TEAM_LEAD",
  );
});

test("emails are normalized and duplicate emails are rejected case-insensitively", () => {
  const profile = buildEmployeeInvitationProfile(
    activeCreator("admin"),
    "admin-doc",
    validInput({ email: "  New.User@Example.COM  " }),
    existingEmployees,
  );
  assert.equal(profile.email, "new.user@example.com");

  expectPolicyError(
    () => buildEmployeeInvitationProfile(
      activeCreator("admin"),
      "admin-doc",
      validInput({ email: " MEMBER@EXAMPLE.COM " }),
      existingEmployees,
    ),
    "DUPLICATE_EMAIL",
  );
});

test("malformed required profile fields are rejected", () => {
  const cases = [
    ["name", ""],
    ["name", 42],
    ["email", "not-an-email"],
    ["email", "a@b"],
    ["dept", ""],
    ["pos", "   "],
    ["joinDate", "21-08-2026"],
    ["joinDate", "2026-02-30"],
    ["role", "owner"],
    ["status", "pending"],
    ["status", null],
    ["phone", { number: "123" }],
  ];

  for (const [field, value] of cases) {
    assert.throws(
      () => buildEmployeeInvitationProfile(
        activeCreator("admin"),
        "admin-doc",
        validInput({ [field]: value }),
        existingEmployees,
      ),
      EmployeeInvitationPolicyError,
    );
  }
});

test("malformed or negative compensation values are rejected", () => {
  for (const [field, value] of [
    ["basic", -1],
    ["allowances", "-0.01"],
    ["basic", "not-a-number"],
    ["allowances", ""],
    ["basic", null],
  ]) {
    expectPolicyError(
      () => buildEmployeeInvitationProfile(
        activeCreator("admin"),
        "admin-doc",
        validInput({ [field]: value }),
        existingEmployees,
      ),
      "INVALID_NUMERIC_FIELD",
    );
  }
});

test("protected client fields are rejected", () => {
  for (const field of [
    "password",
    "pass",
    "uid",
    "authUid",
    "firebaseUid",
    "id",
    "docId",
    "documentId",
    "_docId",
    "empId",
    "employeeId",
    "creator",
    "creatorId",
    "creatorUid",
    "createdBy",
    "createdById",
    "inviterId",
    "invitedBy",
    "createdAt",
    "updatedAt",
    "emailVerified",
    "disabled",
    "claims",
    "customClaims",
    "permissions",
    "isAdmin",
  ]) {
    expectPolicyError(
      () => buildEmployeeInvitationProfile(
        activeCreator("admin"),
        "admin-doc",
        validInput({ [field]: "injected" }),
        existingEmployees,
      ),
      "FORBIDDEN_FIELD",
    );
  }
});

test("unknown fields are rejected instead of being copied", () => {
  expectPolicyError(
    () => buildEmployeeInvitationProfile(
      activeCreator("admin"),
      "admin-doc",
      validInput({ unexpected: true }),
      existingEmployees,
    ),
    "UNSUPPORTED_FIELD",
  );
});

test("invalid invitation containers and employee collections are rejected", () => {
  expectPolicyError(
    () => buildEmployeeInvitationProfile(activeCreator("admin"), "admin-doc", null, existingEmployees),
    "INVALID_ARGUMENT",
  );
  expectPolicyError(
    () => buildEmployeeInvitationProfile(activeCreator("admin"), "admin-doc", validInput(), null),
    "INVALID_ARGUMENT",
  );
  expectPolicyError(
    () => buildEmployeeInvitationProfile(activeCreator("admin"), "admin-doc", [], existingEmployees),
    "INVALID_ARGUMENT",
  );
});
