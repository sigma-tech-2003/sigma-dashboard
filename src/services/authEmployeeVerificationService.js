import {
  EmployeeEmailDataIntegrityError,
  EmployeeUidDataIntegrityError,
  findEmployeeByEmail,
  findEmployeeByUid,
} from "./firestoreService";
import { ROLES } from "../utils/permissions";

const MAX_FIREBASE_UID_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(Object.values(ROLES));

const VERIFICATION_ERROR_MESSAGES = Object.freeze({
  "missing-selected-role": "Select a valid role before signing in.",
  "invalid-firebase-identity": "The authenticated account details are invalid.",
  "unlinked-account": "No employee profile is linked to this account.",
  "uid-email-conflict": "The authenticated account does not match its employee profile.",
  "inactive-account": "This employee account is inactive. Contact an administrator.",
  "selected-role-mismatch": "These credentials do not belong to the selected role.",
  "data-integrity": "Employee account data could not be verified. Contact an administrator.",
  "verification-unavailable": "Employee account verification is temporarily unavailable.",
});

export class AuthEmployeeVerificationError extends Error {
  constructor(code) {
    const safeCode = Object.prototype.hasOwnProperty.call(VERIFICATION_ERROR_MESSAGES, code)
      ? code
      : "verification-unavailable";
    super(VERIFICATION_ERROR_MESSAGES[safeCode]);
    this.name = "AuthEmployeeVerificationError";
    this.code = safeCode;
  }
}

const fail = (code) => {
  throw new AuthEmployeeVerificationError(code);
};

const hasInvalidUidCharacters = (uid) => [...uid].some((character) => {
  const codePoint = character.codePointAt(0);
  return /\s/u.test(character) || codePoint < 32 || codePoint === 127;
});

const normalizeFirebaseUid = (uid) => {
  const normalizedUid = typeof uid === "string" ? uid.trim() : "";

  if (
    !normalizedUid ||
    normalizedUid.length > MAX_FIREBASE_UID_LENGTH ||
    hasInvalidUidCharacters(normalizedUid)
  ) {
    fail("invalid-firebase-identity");
  }

  return normalizedUid;
};

const normalizeFirebaseEmail = (email) => {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

  if (
    !normalizedEmail ||
    normalizedEmail.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(normalizedEmail)
  ) {
    fail("invalid-firebase-identity");
  }

  return normalizedEmail;
};

const validateSelectedRole = (selectedRole) => {
  if (typeof selectedRole !== "string" || !VALID_ROLES.has(selectedRole)) {
    fail("missing-selected-role");
  }

  return selectedRole;
};

const isDataIntegrityError = (error) =>
  error instanceof EmployeeUidDataIntegrityError ||
  error instanceof EmployeeEmailDataIntegrityError;

const safeLookup = async (lookup, value) => {
  try {
    return await lookup(value);
  } catch (error) {
    if (isDataIntegrityError(error)) fail("data-integrity");
    fail("verification-unavailable");
  }
};

const isEmployeeRecord = (employee) =>
  employee !== null && typeof employee === "object" && !Array.isArray(employee);

const normalizeEmployeeEmail = (email) => {
  if (typeof email !== "string") return null;
  const normalizedEmail = email.trim().toLowerCase();
  return EMAIL_PATTERN.test(normalizedEmail) ? normalizedEmail : null;
};

const verifyEmployeeRecord = (employee, authenticatedEmail, selectedRole) => {
  if (!isEmployeeRecord(employee)) fail("data-integrity");

  if (normalizeEmployeeEmail(employee.email) !== authenticatedEmail) {
    fail("uid-email-conflict");
  }
  if (typeof employee.status !== "string" || employee.status.trim().toLowerCase() !== "active") {
    fail("inactive-account");
  }
  if (employee.role !== selectedRole) fail("selected-role-mismatch");
};

const hasEmployeeUidLink = (employee) =>
  employee.uid !== undefined &&
  employee.uid !== null &&
  String(employee.uid).trim() !== "";

export async function verifyAuthenticatedEmployee(firebaseUser, selectedRole) {
  const verifiedRole = validateSelectedRole(selectedRole);
  const uid = normalizeFirebaseUid(firebaseUser?.uid);
  const email = normalizeFirebaseEmail(firebaseUser?.email);

  const uidEmployee = await safeLookup(findEmployeeByUid, uid);
  if (uidEmployee) {
    verifyEmployeeRecord(uidEmployee, email, verifiedRole);
    return { employee: uidEmployee, linkage: "uid" };
  }

  const emailEmployee = await safeLookup(findEmployeeByEmail, email);
  if (!emailEmployee) fail("unlinked-account");
  if (!isEmployeeRecord(emailEmployee)) fail("data-integrity");
  if (hasEmployeeUidLink(emailEmployee)) fail("uid-email-conflict");

  verifyEmployeeRecord(emailEmployee, email, verifiedRole);
  return { employee: emailEmployee, linkage: "legacy-email" };
}
