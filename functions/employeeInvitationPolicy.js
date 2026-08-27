/* global module */
"use strict";

const ASSIGNABLE_ROLES = Object.freeze({
  admin: ["admin", "hr", "manager", "tl", "employee"],
  hr: ["manager", "tl", "employee"],
  manager: ["tl", "employee"],
  tl: ["employee"],
  employee: [],
});

const ALLOWED_INPUT_FIELDS = new Set([
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

const FORBIDDEN_INPUT_FIELDS = new Set([
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
]);

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

class EmployeeInvitationPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EmployeeInvitationPolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EmployeeInvitationPolicyError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRequiredString(value, maximumLength = 120) {
  if (typeof value !== "string") {
    fail("INVALID_PROFILE", "Employee profile is invalid.");
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    fail("INVALID_PROFILE", "Employee profile is invalid.");
  }
  return normalized;
}

function normalizeOptionalString(value, maximumLength) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") {
    fail("INVALID_PROFILE", "Employee profile is invalid.");
  }

  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    fail("INVALID_PROFILE", "Employee profile is invalid.");
  }
  return normalized;
}

function normalizeEmail(value) {
  const email = normalizeRequiredString(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("INVALID_EMAIL", "Employee email is invalid.");
  }
  return email;
}

function normalizeRole(value) {
  if (typeof value !== "string") {
    fail("INVALID_ROLE", "Employee role is invalid.");
  }

  const role = value.trim().toLowerCase();
  if (!own(ASSIGNABLE_ROLES, role)) {
    fail("INVALID_ROLE", "Employee role is invalid.");
  }
  return role;
}

function normalizeStatus(value) {
  if (typeof value !== "string") {
    fail("INVALID_STATUS", "Employee status is invalid.");
  }

  const status = value.trim().toLowerCase();
  if (status !== "active" && status !== "inactive") {
    fail("INVALID_STATUS", "Employee status is invalid.");
  }
  return status;
}

function normalizeNonNegativeNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    fail("INVALID_NUMERIC_FIELD", "Employee compensation values are invalid.");
  }
  if (typeof value === "string" && value.trim() === "") {
    fail("INVALID_NUMERIC_FIELD", "Employee compensation values are invalid.");
  }

  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    fail("INVALID_NUMERIC_FIELD", "Employee compensation values are invalid.");
  }
  return normalized;
}

function normalizeDate(value) {
  if (typeof value !== "string") {
    fail("INVALID_DATE", "Employee join date is invalid.");
  }

  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail("INVALID_DATE", "Employee join date is invalid.");
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    fail("INVALID_DATE", "Employee join date is invalid.");
  }
  return date;
}

function normalizeId(value) {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    fail("INVALID_ARGUMENT", "Invitation context is invalid.");
  }
  return String(value).trim();
}

function assertInputFields(input) {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_INPUT_FIELDS.has(key)) {
      fail("FORBIDDEN_FIELD", "Employee profile contains a protected field.");
    }
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      fail("UNSUPPORTED_FIELD", "Employee profile contains an unsupported field.");
    }
  }
}

function normalizeExistingId(record) {
  if (!record || (typeof record.id !== "string" && typeof record.id !== "number")) {
    return null;
  }
  const id = String(record.id).trim();
  return id || null;
}

function hasDuplicateEmail(existingEmployees, email) {
  return existingEmployees.some((record) =>
    isPlainObject(record)
    && typeof record.email === "string"
    && record.email.trim().toLowerCase() === email,
  );
}

function resolveTeamLead(existingEmployees, teamLeadId, department) {
  return existingEmployees.find((record) =>
    isPlainObject(record)
    && normalizeExistingId(record) === teamLeadId
    && typeof record.role === "string"
    && record.role.trim().toLowerCase() === "tl"
    && typeof record.dept === "string"
    && record.dept.trim() === department,
  );
}

function buildEmployeeInvitationProfile(
  creatorEmployee,
  creatorDocumentId,
  invitationInput,
  existingEmployees,
) {
  if (
    !isPlainObject(creatorEmployee)
    || !isPlainObject(invitationInput)
    || !Array.isArray(existingEmployees)
  ) {
    fail("INVALID_ARGUMENT", "Invitation context is invalid.");
  }

  const creatorId = normalizeId(creatorDocumentId);
  const creatorRole = normalizeRole(creatorEmployee.role);
  if (typeof creatorEmployee.status !== "string"
      || creatorEmployee.status.trim().toLowerCase() !== "active") {
    fail("CREATOR_NOT_ACTIVE", "Creator is not active.");
  }

  assertInputFields(invitationInput);

  const role = normalizeRole(invitationInput.role);
  if (!ASSIGNABLE_ROLES[creatorRole].includes(role)) {
    fail("CREATOR_NOT_AUTHORIZED", "Creator cannot create this employee role.");
  }

  const creatorIsScoped = creatorRole === "manager" || creatorRole === "tl";
  const creatorDepartment = creatorIsScoped
    ? normalizeRequiredString(creatorEmployee.dept)
    : null;
  let department;

  if (creatorIsScoped) {
    if (own(invitationInput, "dept")
        && normalizeRequiredString(invitationInput.dept) !== creatorDepartment) {
      fail("SCOPE_VIOLATION", "Employee assignment is outside the creator's scope.");
    }
    department = creatorDepartment;
  } else {
    department = normalizeRequiredString(invitationInput.dept);
  }

  const email = normalizeEmail(invitationInput.email);
  if (hasDuplicateEmail(existingEmployees, email)) {
    fail("DUPLICATE_EMAIL", "An employee with this email already exists.");
  }

  let teamLeadId;
  const suppliedTeamLeadId = own(invitationInput, "teamLeadId")
    && invitationInput.teamLeadId != null
    && String(invitationInput.teamLeadId).trim() !== "";

  if (creatorRole === "tl") {
    if (suppliedTeamLeadId && normalizeId(invitationInput.teamLeadId) !== creatorId) {
      fail("SCOPE_VIOLATION", "Employee assignment is outside the creator's scope.");
    }
    teamLeadId = creatorId;
  } else if (suppliedTeamLeadId) {
    if (role !== "employee") {
      fail("INVALID_TEAM_LEAD", "Selected Team Lead is invalid.");
    }

    teamLeadId = normalizeId(invitationInput.teamLeadId);
    if (!resolveTeamLead(existingEmployees, teamLeadId, department)) {
      fail("INVALID_TEAM_LEAD", "Selected Team Lead is invalid.");
    }
  }

  const profile = {
    name: normalizeRequiredString(invitationInput.name),
    email,
    phone: normalizeOptionalString(invitationInput.phone, 40),
    dept: department,
    pos: normalizeRequiredString(invitationInput.pos),
    basic: normalizeNonNegativeNumber(invitationInput.basic),
    allowances: normalizeNonNegativeNumber(invitationInput.allowances),
    joinDate: normalizeDate(invitationInput.joinDate),
    role,
    status: normalizeStatus(invitationInput.status),
  };

  if (teamLeadId !== undefined) profile.teamLeadId = teamLeadId;
  return profile;
}

module.exports = {
  EmployeeInvitationPolicyError,
  buildEmployeeInvitationProfile,
};
