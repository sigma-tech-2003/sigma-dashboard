import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { auth } from "../firebase/firebaseConfig";

const PASSWORD_SETUP_ERROR_MESSAGES = {
  "invalid-email": "Enter a valid email address.",
  "too-many-requests": "Too many requests. Please wait and try again.",
  unavailable: "Unable to connect. Check your connection and try again.",
  "unauthorized-domain":
    "Password setup emails are not authorized for this application.",
  "operation-not-allowed": "Password setup emails are not enabled.",
  internal: "Password setup email could not be sent. Please try again.",
};

const FIREBASE_PASSWORD_SETUP_ERROR_CODES = {
  "auth/invalid-email": "invalid-email",
  "auth/too-many-requests": "too-many-requests",
  "auth/network-request-failed": "unavailable",
  "auth/unauthorized-domain": "unauthorized-domain",
  "auth/app-not-authorized": "unauthorized-domain",
  "auth/operation-not-allowed": "operation-not-allowed",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class EmployeePasswordSetupError extends Error {
  constructor(code) {
    const safeCode = PASSWORD_SETUP_ERROR_MESSAGES[code] ? code : "internal";
    super(PASSWORD_SETUP_ERROR_MESSAGES[safeCode]);
    this.name = "EmployeePasswordSetupError";
    this.code = safeCode;
  }
}

const normalizeEmployeeEmail = (email) => {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

  if (!normalizedEmail || !EMAIL_PATTERN.test(normalizedEmail)) {
    throw new EmployeePasswordSetupError("invalid-email");
  }

  return normalizedEmail;
};

export const observeAuthState = (callback) => onAuthStateChanged(auth, callback);

export const signIn = (email, password) =>
  signInWithEmailAndPassword(auth, email, password);

export const signOutUser = () => signOut(auth);

export const sendEmployeePasswordSetupEmail = async (email) => {
  const normalizedEmail = normalizeEmployeeEmail(email);

  try {
    await sendPasswordResetEmail(auth, normalizedEmail);
    return { sent: true };
  } catch (error) {
    const firebaseCode = typeof error?.code === "string" ? error.code : "";
    const safeCode = FIREBASE_PASSWORD_SETUP_ERROR_CODES[firebaseCode] ?? "internal";
    throw new EmployeePasswordSetupError(safeCode);
  }
};
