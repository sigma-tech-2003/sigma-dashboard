/* global module */
"use strict";

const MAX_FIREBASE_UID_LENGTH = 128;
const MAX_DOCUMENT_ID_LENGTH = 1500;
const MAX_EMAIL_LENGTH = 254;
const AUTH_LINK_FIELDS = ["employeeId", "createdAt", "updatedAt"];
const EDITABLE_FIELDS = new Set([
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
const PROTECTED_FIELDS = new Set([
  "password", "pass", "uid", "authUid", "firebaseUid", "authLink",
  "id", "docId", "documentId", "_docId", "empId", "employeeId",
  "creator", "creatorId", "creatorUid", "createdBy", "createdByUid",
  "createdAt", "updatedAt", "permissions", "claims", "customClaims",
]);
const ROLES = new Set(["admin", "hr", "manager", "tl", "employee"]);
const ROLE_ASSIGNMENTS = Object.freeze({
  admin: new Set(["admin", "hr", "manager", "tl", "employee"]),
  hr: new Set(["manager", "tl", "employee"]),
  manager: new Set(["tl", "employee"]),
  tl: new Set(["employee"]),
  employee: new Set(),
});
const PAYROLL_ROLES = new Set(["admin", "hr"]);
const SAFE_REASON = /^[A-Z0-9_]{1,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class EmployeeMutationServiceError extends Error {
  constructor(code, reason, message, partialResult = null) {
    super(message);
    this.name = "EmployeeMutationServiceError";
    this.code = code;
    this.reason = reason;
    if (partialResult) this.partialResult = Object.freeze({ ...partialResult });
  }
}

function serviceError(code, reason, message, partialResult) {
  return new EmployeeMutationServiceError(code, reason, message, partialResult);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertDependencies(auth, firestore, logger, clock) {
  const validAuth = auth
    && typeof auth.getUser === "function"
    && typeof auth.getUserByEmail === "function"
    && typeof auth.updateUser === "function"
    && typeof auth.deleteUser === "function";
  const validFirestore = firestore
    && typeof firestore.collection === "function"
    && typeof firestore.runTransaction === "function";
  const validLogger = logger && typeof logger.error === "function";
  if (!validAuth || !validFirestore || !validLogger || typeof clock !== "function") {
    throw serviceError(
      "failed-precondition",
      "INVALID_SERVICE_CONFIGURATION",
      "Employee management is unavailable.",
    );
  }
}

function hasInvalidUidCharacters(uid) {
  return [...uid].some((character) => {
    const codePoint = character.codePointAt(0);
    return /\s/u.test(character) || codePoint < 32 || codePoint === 127;
  });
}

function normalizeCallerUid(value) {
  const uid = typeof value === "string" ? value.trim() : "";
  if (!uid || uid.length > MAX_FIREBASE_UID_LENGTH || hasInvalidUidCharacters(uid)) {
    throw serviceError("unauthenticated", "INVALID_AUTH_IDENTITY", "Authentication is required.");
  }
  return uid;
}

function normalizeDocumentId(value, reason = "INVALID_EMPLOYEE_ID") {
  let id = "";
  if (typeof value === "string") id = value.trim();
  else if (Number.isSafeInteger(value) && value >= 0) id = String(value);
  if (
    !id
    || id.length > MAX_DOCUMENT_ID_LENGTH
    || id.includes("/")
    || id === "."
    || id === ".."
    || [...id].some((character) => character.codePointAt(0) < 32)
  ) {
    throw serviceError("invalid-argument", reason, "A valid employee identifier is required.");
  }
  return id;
}

function normalizeUid(value) {
  if (value == null || value === "") return null;
  const uid = typeof value === "string" ? value.trim() : "";
  if (!uid || uid.length > MAX_FIREBASE_UID_LENGTH || hasInvalidUidCharacters(uid)) {
    throw serviceError(
      "failed-precondition",
      "TARGET_UID_CONFLICT",
      "Employee account linkage is invalid.",
    );
  }
  return uid;
}

function normalizeRequiredText(value, field, maximumLength = 120) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximumLength) {
    throw serviceError("invalid-argument", "INVALID_EMPLOYEE_FIELD", `${field} is invalid.`);
  }
  return text;
}

function normalizeOptionalText(value, field, maximumLength = 120) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") {
    throw serviceError("invalid-argument", "INVALID_EMPLOYEE_FIELD", `${field} is invalid.`);
  }
  const text = value.trim();
  if (text.length > maximumLength) {
    throw serviceError("invalid-argument", "INVALID_EMPLOYEE_FIELD", `${field} is invalid.`);
  }
  return text;
}

function normalizeEmail(value) {
  const email = normalizeRequiredText(value, "Employee email", MAX_EMAIL_LENGTH).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw serviceError("invalid-argument", "INVALID_EMAIL", "Employee email is invalid.");
  }
  return email;
}

function normalizeRole(value) {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ROLES.has(role)) {
    throw serviceError("invalid-argument", "INVALID_ROLE", "Employee role is invalid.");
  }
  return role;
}

function normalizeStatus(value) {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (status !== "active" && status !== "inactive") {
    throw serviceError("invalid-argument", "INVALID_STATUS", "Employee status is invalid.");
  }
  return status;
}

function normalizeNumber(value) {
  if ((typeof value !== "number" && typeof value !== "string")
      || (typeof value === "string" && value.trim() === "")) {
    throw serviceError(
      "invalid-argument",
      "INVALID_COMPENSATION",
      "Employee compensation is invalid.",
    );
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw serviceError(
      "invalid-argument",
      "INVALID_COMPENSATION",
      "Employee compensation is invalid.",
    );
  }
  return number;
}

function normalizeDate(value) {
  const date = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw serviceError("invalid-argument", "INVALID_JOIN_DATE", "Employee join date is invalid.");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw serviceError("invalid-argument", "INVALID_JOIN_DATE", "Employee join date is invalid.");
  }
  return date;
}

function normalizeTeamLeadId(value) {
  if (value == null || value === "") return null;
  return normalizeDocumentId(value, "INVALID_TEAM_LEAD_ID");
}

function isTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function currentTimestamp(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw serviceError("internal", "CLOCK_FAILED", "Employee management is unavailable.");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw serviceError("internal", "CLOCK_FAILED", "Employee management is unavailable.");
  }
  return date.toISOString();
}

function assertExactKeys(value, expected, reason) {
  if (!isPlainObject(value)) {
    throw serviceError("invalid-argument", reason, "Employee operation is invalid.");
  }
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw serviceError("invalid-argument", reason, "Employee operation is invalid.");
  }
}

function normalizeUpdates(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw serviceError("invalid-argument", "INVALID_EMPLOYEE_UPDATE", "Employee update is invalid.");
  }
  const normalized = {};
  for (const [field, supplied] of Object.entries(value)) {
    if (PROTECTED_FIELDS.has(field)) {
      throw serviceError(
        "invalid-argument",
        "PROTECTED_EMPLOYEE_FIELD",
        "Protected employee fields cannot be supplied.",
      );
    }
    if (!EDITABLE_FIELDS.has(field)) {
      throw serviceError(
        "invalid-argument",
        "UNSUPPORTED_EMPLOYEE_FIELD",
        "Employee update contains an unsupported field.",
      );
    }
    if (field === "name") normalized.name = normalizeRequiredText(supplied, "Employee name");
    else if (field === "email") normalized.email = normalizeEmail(supplied);
    else if (field === "phone") normalized.phone = normalizeOptionalText(supplied, "Employee phone", 40);
    else if (field === "dept") normalized.dept = normalizeRequiredText(supplied, "Department");
    else if (field === "pos") normalized.pos = normalizeRequiredText(supplied, "Position");
    else if (field === "basic" || field === "allowances") normalized[field] = normalizeNumber(supplied);
    else if (field === "joinDate") normalized.joinDate = normalizeDate(supplied);
    else if (field === "role") normalized.role = normalizeRole(supplied);
    else if (field === "status") normalized.status = normalizeStatus(supplied);
    else if (field === "teamLeadId") normalized.teamLeadId = normalizeTeamLeadId(supplied);
  }
  return Object.freeze(normalized);
}

function normalizeOperationInput(value) {
  if (!isPlainObject(value)) {
    throw serviceError("invalid-argument", "INVALID_OPERATION_INPUT", "Employee operation is invalid.");
  }
  const operation = typeof value.operation === "string" ? value.operation.trim() : "";
  if (operation !== "update" && operation !== "delete") {
    throw serviceError("invalid-argument", "INVALID_OPERATION", "Employee operation is invalid.");
  }
  const expected = operation === "update"
    ? ["operation", "employeeId", "updates"]
    : ["operation", "employeeId"];
  assertExactKeys(value, expected, "INVALID_OPERATION_SCHEMA");
  return Object.freeze({
    operation,
    employeeId: normalizeDocumentId(value.employeeId),
    updates: operation === "update" ? normalizeUpdates(value.updates) : null,
  });
}

function collectionReference(firestore, name) {
  try {
    const reference = firestore.collection(name);
    if (!reference || typeof reference.doc !== "function" || typeof reference.where !== "function") {
      throw new Error("invalid collection");
    }
    return reference;
  } catch {
    throw serviceError("internal", "COLLECTION_REFERENCE_FAILED", "Employee management is unavailable.");
  }
}

function documentReference(collection, id) {
  try {
    const reference = collection.doc(id);
    if (!reference || typeof reference.id !== "string" || !reference.id) throw new Error("invalid document");
    return reference;
  } catch {
    throw serviceError("internal", "DOCUMENT_REFERENCE_FAILED", "Employee management is unavailable.");
  }
}

function constrainedQuery(collection, field, value) {
  try {
    const query = collection.where(field, "==", value).limit(2);
    if (!query) throw new Error("invalid query");
    return query;
  } catch {
    throw serviceError("internal", "QUERY_BUILD_FAILED", "Employee management is unavailable.");
  }
}

function snapshotData(snapshot, missingReason, invalidReason, missingCode = "not-found") {
  if (!snapshot || snapshot.exists !== true) {
    throw serviceError(missingCode, missingReason, "Employee record was not found.");
  }
  if (typeof snapshot.data !== "function") {
    throw serviceError("failed-precondition", invalidReason, "Stored employee data is invalid.");
  }
  const data = snapshot.data();
  if (!isPlainObject(data)) {
    throw serviceError("failed-precondition", invalidReason, "Stored employee data is invalid.");
  }
  return data;
}

function queryDocuments(snapshot, reason) {
  if (!snapshot || !Array.isArray(snapshot.docs)) {
    throw serviceError("internal", reason, "Employee management is unavailable.");
  }
  return snapshot.docs;
}

function resolveAuthLink(snapshot, expectedEmployeeId, reason = "AUTH_LINK_CONFLICT") {
  const data = snapshotData(snapshot, "AUTH_LINK_MISSING", reason, "failed-precondition");
  const exact = Object.keys(data).length === AUTH_LINK_FIELDS.length
    && AUTH_LINK_FIELDS.every((field) => own(data, field));
  const employeeId = exact ? normalizeDocumentId(data.employeeId, reason) : null;
  if (
    !employeeId
    || (expectedEmployeeId !== null && employeeId !== expectedEmployeeId)
    || !isTimestamp(data.createdAt)
    || !isTimestamp(data.updatedAt)
  ) {
    throw serviceError("failed-precondition", reason, "Employee account linkage is invalid.");
  }
  return employeeId;
}

function storedEmployee(id, data, reason = "TARGET_DATA_INVALID") {
  if (!isPlainObject(data)) {
    throw serviceError("failed-precondition", reason, "Stored employee data is invalid.");
  }
  try {
    const employee = {
      id,
      name: normalizeRequiredText(data.name, "Employee name"),
      email: normalizeEmail(data.email),
      phone: normalizeOptionalText(data.phone, "Employee phone", 40),
      dept: normalizeRequiredText(data.dept, "Department"),
      pos: normalizeRequiredText(data.pos, "Position"),
      basic: normalizeNumber(data.basic),
      allowances: normalizeNumber(data.allowances),
      joinDate: normalizeDate(data.joinDate),
      role: normalizeRole(data.role),
      status: normalizeStatus(data.status),
      teamLeadId: normalizeTeamLeadId(data.teamLeadId),
      uid: normalizeUid(data.uid),
      empId: typeof data.empId === "string" ? data.empId.trim() : "",
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      raw: data,
    };
    if (employee.createdAt != null && !isTimestamp(employee.createdAt)) throw new Error("createdAt");
    if (employee.updatedAt != null && !isTimestamp(employee.updatedAt)) throw new Error("updatedAt");
    return employee;
  } catch (error) {
    if (error instanceof EmployeeMutationServiceError && error.code === "failed-precondition") throw error;
    throw serviceError("failed-precondition", reason, "Stored employee data is invalid.");
  }
}

function resolvePrincipal(snapshot, callerUid, employeeId) {
  const data = snapshotData(snapshot, "PRINCIPAL_NOT_FOUND", "PRINCIPAL_INVALID");
  const principal = storedEmployee(employeeId, data, "PRINCIPAL_INVALID");
  if (principal.uid !== callerUid) {
    throw serviceError(
      "failed-precondition",
      "PRINCIPAL_UID_MISMATCH",
      "Employee account identity is invalid.",
    );
  }
  if (principal.status !== "active") {
    throw serviceError("permission-denied", "PRINCIPAL_INACTIVE", "This account cannot manage employees.");
  }
  if (!ROLE_ASSIGNMENTS[principal.role] || principal.role === "employee") {
    throw serviceError("permission-denied", "ROLE_NOT_ALLOWED", "This account cannot manage employees.");
  }
  return principal;
}

function candidateEmployee(target, updates) {
  const candidate = { ...target, ...updates };
  if (candidate.role !== "employee") candidate.teamLeadId = null;
  return candidate;
}

function assertHierarchy(principal, target, candidate, operation) {
  if (operation === "delete") {
    if (principal.id === target.id) {
      throw serviceError("permission-denied", "SELF_DELETE_DENIED", "Employees cannot delete themselves.");
    }
    if (principal.role === "admin") return;
    if (principal.role === "hr" && ROLE_ASSIGNMENTS.hr.has(target.role)) return;
    throw serviceError("permission-denied", "EMPLOYEE_SCOPE_DENIED", "This employee is outside the authorized scope.");
  }

  if (principal.id === target.id && candidate.role !== target.role) {
    throw serviceError("permission-denied", "SELF_ROLE_CHANGE_DENIED", "Employees cannot change their own role.");
  }
  if (principal.role === "admin") return;
  if (principal.role === "hr") {
    if (ROLE_ASSIGNMENTS.hr.has(target.role) && ROLE_ASSIGNMENTS.hr.has(candidate.role)) return;
  } else if (principal.role === "manager") {
    if (
      ROLE_ASSIGNMENTS.manager.has(target.role)
      && ROLE_ASSIGNMENTS.manager.has(candidate.role)
      && target.dept === principal.dept
      && candidate.dept === principal.dept
    ) return;
  } else if (principal.role === "tl") {
    if (
      target.role === "employee"
      && candidate.role === "employee"
      && target.dept === principal.dept
      && candidate.dept === principal.dept
      && target.teamLeadId === principal.id
      && candidate.teamLeadId === principal.id
    ) return;
  }
  throw serviceError("permission-denied", "EMPLOYEE_SCOPE_DENIED", "This employee is outside the authorized scope.");
}

function assertCompensationAuthority(principal, target, candidate) {
  if (
    !PAYROLL_ROLES.has(principal.role)
    && (candidate.basic !== target.basic || candidate.allowances !== target.allowances)
  ) {
    throw serviceError(
      "permission-denied",
      "COMPENSATION_CHANGE_DENIED",
      "This account cannot change employee compensation.",
    );
  }
}

async function queryInTransaction(transaction, query, reason) {
  try {
    return queryDocuments(await transaction.get(query), reason);
  } catch (error) {
    if (error instanceof EmployeeMutationServiceError) throw error;
    throw serviceError("internal", reason, "Employee management is unavailable.");
  }
}

async function assertDepartment(transaction, departments, department) {
  const documents = await queryInTransaction(
    transaction,
    constrainedQuery(departments, "name", department),
    "DEPARTMENT_LOOKUP_FAILED",
  );
  if (documents.length !== 1) {
    throw serviceError("invalid-argument", "INVALID_DEPARTMENT", "Selected department is invalid.");
  }
  const data = snapshotData(documents[0], "INVALID_DEPARTMENT", "INVALID_DEPARTMENT", "invalid-argument");
  const status = typeof data.status === "string" ? data.status.trim().toLowerCase() : "";
  if (status !== "active") {
    throw serviceError("invalid-argument", "INVALID_DEPARTMENT", "Selected department is invalid.");
  }
}

async function assertTeamLead(transaction, employees, candidate) {
  if (candidate.role !== "employee" || candidate.teamLeadId === null) return;
  let snapshot;
  try {
    snapshot = await transaction.get(documentReference(employees, candidate.teamLeadId));
  } catch (error) {
    if (error instanceof EmployeeMutationServiceError) throw error;
    throw serviceError("internal", "TEAM_LEAD_READ_FAILED", "Employee management is unavailable.");
  }
  const data = snapshotData(
    snapshot,
    "INVALID_TEAM_LEAD",
    "INVALID_TEAM_LEAD",
    "invalid-argument",
  );
  const teamLead = storedEmployee(candidate.teamLeadId, data, "INVALID_TEAM_LEAD");
  if (teamLead.role !== "tl" || teamLead.status !== "active" || teamLead.dept !== candidate.dept) {
    throw serviceError("invalid-argument", "INVALID_TEAM_LEAD", "Selected Team Lead is invalid.");
  }
}

async function assertUniqueEmail(transaction, employees, targetId, email) {
  const documents = await queryInTransaction(
    transaction,
    constrainedQuery(employees, "email", email),
    "EMAIL_LOOKUP_FAILED",
  );
  if (documents.some((document) => document.id !== targetId)) {
    throw serviceError("already-exists", "EMPLOYEE_EMAIL_EXISTS", "Employee email is already in use.");
  }
}

async function resolveTargetLink(transaction, authLinks, target) {
  const documents = await queryInTransaction(
    transaction,
    constrainedQuery(authLinks, "employeeId", target.id),
    "AUTH_LINK_LOOKUP_FAILED",
  );
  if (target.uid === null) {
    if (documents.length !== 0) {
      throw serviceError("failed-precondition", "TARGET_UID_CONFLICT", "Employee account linkage is invalid.");
    }
    return null;
  }
  if (documents.length !== 1 || documents[0].id !== target.uid) {
    throw serviceError("failed-precondition", "TARGET_UID_CONFLICT", "Employee account linkage is invalid.");
  }
  resolveAuthLink(documents[0], target.id, "TARGET_UID_CONFLICT");
  return documentReference(authLinks, target.uid);
}

function identityVersion(target) {
  return JSON.stringify({
    uid: target.uid,
    email: target.email,
    status: target.status,
    role: target.role,
    dept: target.dept,
    teamLeadId: target.teamLeadId,
    updatedAt: target.updatedAt ?? null,
  });
}

function assertExpectedVersion(target, expectedVersion) {
  if (expectedVersion !== null && identityVersion(target) !== expectedVersion) {
    throw serviceError("aborted", "EMPLOYEE_TRANSACTION_CONFLICT", "The employee changed. Please try again.");
  }
}

async function buildContext({
  transaction,
  collections,
  callerUid,
  input,
  expectedVersion = null,
}) {
  let principalLinkSnapshot;
  try {
    principalLinkSnapshot = await transaction.get(documentReference(collections.authLinks, callerUid));
  } catch {
    throw serviceError("internal", "AUTH_LINK_READ_FAILED", "Employee management is unavailable.");
  }
  const principalId = resolveAuthLink(principalLinkSnapshot, null, "AUTH_LINK_CONFLICT");
  let principalSnapshot;
  let targetSnapshot;
  try {
    principalSnapshot = await transaction.get(documentReference(collections.employees, principalId));
    targetSnapshot = await transaction.get(documentReference(collections.employees, input.employeeId));
  } catch {
    throw serviceError("internal", "EMPLOYEE_READ_FAILED", "Employee management is unavailable.");
  }
  const principal = resolvePrincipal(principalSnapshot, callerUid, principalId);
  const targetData = snapshotData(targetSnapshot, "TARGET_NOT_FOUND", "TARGET_DATA_INVALID");
  const target = storedEmployee(input.employeeId, targetData);
  const candidate = input.operation === "update" ? candidateEmployee(target, input.updates) : target;
  assertExpectedVersion(target, expectedVersion);
  assertHierarchy(principal, target, candidate, input.operation);
  assertCompensationAuthority(principal, target, candidate);
  const targetAuthLink = await resolveTargetLink(transaction, collections.authLinks, target);

  if (input.operation === "update") {
    await assertDepartment(transaction, collections.departments, candidate.dept);
    await assertTeamLead(transaction, collections.employees, candidate);
    await assertUniqueEmail(transaction, collections.employees, target.id, candidate.email);
  }
  return { principal, target, candidate, targetData, targetAuthLink };
}

function sanitizedEmployee(employee) {
  const result = {
    id: employee.id,
    name: employee.name,
    email: employee.email,
    phone: employee.phone,
    dept: employee.dept,
    pos: employee.pos,
    basic: employee.basic,
    allowances: employee.allowances,
    joinDate: employee.joinDate,
    role: employee.role,
    status: employee.status,
    empId: employee.empId,
    createdAt: employee.createdAt ?? null,
    updatedAt: employee.updatedAt ?? null,
  };
  if (employee.teamLeadId !== null) result.teamLeadId = employee.teamLeadId;
  return result;
}

function adminCode(error) {
  return typeof error?.code === "string" ? error.code : "";
}

async function loadAuthIdentity(auth, target, allowMissing = false) {
  if (target.uid === null) return null;
  let user;
  try {
    user = await auth.getUser(target.uid);
  } catch (error) {
    if (allowMissing && adminCode(error) === "auth/user-not-found") {
      return {
        uid: target.uid,
        email: target.email,
        disabled: target.status !== "active",
        missing: true,
      };
    }
    throw serviceError("failed-precondition", "TARGET_AUTH_CONFLICT", "Employee authentication data is invalid.");
  }
  const uid = typeof user?.uid === "string" ? user.uid.trim() : "";
  const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
  if (uid !== target.uid || email !== target.email || Boolean(user.disabled) !== (target.status !== "active")) {
    throw serviceError("failed-precondition", "TARGET_AUTH_CONFLICT", "Employee authentication data is invalid.");
  }
  return { uid, email, disabled: Boolean(user.disabled) };
}

async function assertAuthEmailAvailable(auth, email, targetUid) {
  try {
    const user = await auth.getUserByEmail(email);
    if (!user || user.uid !== targetUid) {
      throw serviceError("already-exists", "AUTH_EMAIL_EXISTS", "Employee email is already in use.");
    }
  } catch (error) {
    if (error instanceof EmployeeMutationServiceError) throw error;
    if (adminCode(error) === "auth/user-not-found") return;
    throw serviceError("internal", "AUTH_EMAIL_LOOKUP_FAILED", "Employee management is unavailable.");
  }
}

async function updateAuthIdentity(auth, identity, candidate) {
  if (!identity) return false;
  const updates = {};
  if (candidate.email !== identity.email) updates.email = candidate.email;
  const disabled = candidate.status !== "active";
  if (disabled !== identity.disabled) updates.disabled = disabled;
  if (Object.keys(updates).length === 0) return false;
  if (own(updates, "email")) await assertAuthEmailAvailable(auth, updates.email, identity.uid);
  try {
    await auth.updateUser(identity.uid, updates);
  } catch (error) {
    if (adminCode(error) === "auth/email-already-exists") {
      throw serviceError("already-exists", "AUTH_EMAIL_EXISTS", "Employee email is already in use.");
    }
    throw serviceError("internal", "AUTH_UPDATE_FAILED", "Employee identity could not be updated.");
  }
  return true;
}

function safeLog(logger, reason, event = "employee_mutation_failed") {
  try {
    logger.error("Employee mutation service failed.", {
      event,
      reason: typeof reason === "string" && SAFE_REASON.test(reason) ? reason : "UNEXPECTED_ERROR",
    });
  } catch {
    // Logging must never replace the safe operation error.
  }
}

async function compensateAuth(auth, identity, logger) {
  try {
    await auth.updateUser(identity.uid, { email: identity.email, disabled: identity.disabled });
    return true;
  } catch {
    safeLog(logger, "AUTH_COMPENSATION_FAILED", "employee_auth_compensation_failed");
    return false;
  }
}

function transactionError(error, logger) {
  if (error instanceof EmployeeMutationServiceError) {
    if (error.code === "internal") safeLog(logger, error.reason);
    return error;
  }
  const code = error?.code;
  if (code === "aborted" || code === 10) {
    return serviceError("aborted", "EMPLOYEE_TRANSACTION_CONFLICT", "The employee changed. Please try again.");
  }
  safeLog(logger, "EMPLOYEE_TRANSACTION_FAILED");
  return serviceError("internal", "EMPLOYEE_TRANSACTION_FAILED", "Employee management is unavailable.");
}

async function runContextTransaction(firestore, options, writer, logger) {
  try {
    return await firestore.runTransaction(async (transaction) => {
      if (!transaction || typeof transaction.get !== "function") {
        throw serviceError("internal", "INVALID_TRANSACTION", "Employee management is unavailable.");
      }
      const context = await buildContext({ transaction, ...options });
      return writer ? writer(transaction, context) : context;
    });
  } catch (error) {
    throw transactionError(error, logger);
  }
}

async function deleteAuthUser(auth, uid) {
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (adminCode(error) === "auth/user-not-found") return false;
    throw serviceError("internal", "AUTH_DELETE_FAILED", "Employee account cleanup could not be completed.");
  }
  return true;
}

function createEmployeeMutationService({ auth, firestore, logger, clock }) {
  assertDependencies(auth, firestore, logger, clock);

  return {
    async manageEmployee(callerUid, untrustedInput) {
      const uid = normalizeCallerUid(callerUid);
      const input = normalizeOperationInput(untrustedInput);
      const collections = {
        authLinks: collectionReference(firestore, "authLinks"),
        employees: collectionReference(firestore, "employees"),
        departments: collectionReference(firestore, "departments"),
      };
      const options = { collections, callerUid: uid, input };
      const preview = await runContextTransaction(firestore, options, null, logger);
      const expectedVersion = identityVersion(preview.target);

      if (input.operation === "delete") {
        let authAccountDeleted = false;
        if (preview.target.uid !== null) {
          await loadAuthIdentity(auth, preview.target, true);
          authAccountDeleted = await deleteAuthUser(auth, preview.target.uid);
        }
        try {
          return await runContextTransaction(
            firestore,
            { ...options, expectedVersion },
            (transaction, context) => {
              if (typeof transaction.delete !== "function") {
                throw serviceError("internal", "INVALID_TRANSACTION", "Employee management is unavailable.");
              }
              transaction.delete(documentReference(collections.employees, context.target.id));
              if (context.targetAuthLink) transaction.delete(context.targetAuthLink);
              return {
                employeeId: context.target.id,
                deleted: true,
                authAccountDeleted,
              };
            },
            logger,
          );
        } catch (error) {
          if (preview.target.uid !== null) {
            throw serviceError(
              "failed-precondition",
              "DELETE_PARTIAL_CLEANUP",
              "Login access was revoked, but employee cleanup must be retried.",
              { employeeId: input.employeeId, accessRevoked: true, cleanupPending: true },
            );
          }
          throw error;
        }
      }

      const authIdentity = await loadAuthIdentity(auth, preview.target);
      const authChanged = await updateAuthIdentity(auth, authIdentity, preview.candidate);
      try {
        const timestamp = currentTimestamp(clock);
        return await runContextTransaction(
          firestore,
          { ...options, expectedVersion },
          (transaction, context) => {
            if (typeof transaction.set !== "function") {
              throw serviceError("internal", "INVALID_TRANSACTION", "Employee management is unavailable.");
            }
            const nextData = {
              ...context.targetData,
              name: context.candidate.name,
              email: context.candidate.email,
              phone: context.candidate.phone,
              dept: context.candidate.dept,
              pos: context.candidate.pos,
              basic: context.candidate.basic,
              allowances: context.candidate.allowances,
              joinDate: context.candidate.joinDate,
              role: context.candidate.role,
              status: context.candidate.status,
              updatedAt: timestamp,
            };
            if (context.candidate.teamLeadId === null) delete nextData.teamLeadId;
            else nextData.teamLeadId = context.candidate.teamLeadId;
            transaction.set(documentReference(collections.employees, context.target.id), nextData);
            return sanitizedEmployee({
              ...context.candidate,
              createdAt: context.target.createdAt,
              updatedAt: timestamp,
            });
          },
          logger,
        );
      } catch (error) {
        if (authChanged && !(await compensateAuth(auth, authIdentity, logger))) {
          throw serviceError(
            "failed-precondition",
            "AUTH_COMPENSATION_FAILED",
            "Employee identity cleanup must be retried.",
            { employeeId: input.employeeId, firestoreUpdated: false, authCleanupPending: true },
          );
        }
        throw error;
      }
    },
  };
}

module.exports = {
  EmployeeMutationServiceError,
  createEmployeeMutationService,
};
