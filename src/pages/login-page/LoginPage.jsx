// src/pages/login-page/LoginPage.jsx
// Signs in against the API (POST /auth/login), then checks the picked role (D37) before the session is published.
// When that succeeds the session store changes and App.jsx swaps this page for the workspace on its own.

import "./LoginPage.css";
import { useRef, useState } from "react";
import { Briefcase } from "lucide-react";
import Input from "../../components/input/Input";
import Btn from "../../components/btn/Btn";
import PageMotion from "../../components/page-motion/PageMotion";
import FormFeedback from "../../components/form-feedback/FormFeedback";
import { signIn, signOutUser } from "../../services/authService";
import {
  AuthSessionError,
  verifyAuthSession,
} from "../../services/authSessionService";
import {
  AUTH_ROLE_ERROR_STORAGE_KEY,
  AUTH_ROLE_STORAGE_KEY,
} from "../../hooks/useAuthSession";

const LOGIN_ROLES = [
  { value: "admin", label: "Admin" },
  { value: "hr", label: "HR" },
  { value: "manager", label: "Manager" },
  { value: "tl", label: "Team lead" },
  { value: "employee", label: "Employee" },
];
const ROLE_REQUIRED_MESSAGE = new AuthSessionError("invalid-argument").message;
const SIGN_IN_FAILURE_MESSAGE = "Unable to sign in. Check your credentials and try again.";
const LEGACY_LINK_ERROR_PREFIX = "legacy-link:";
const LEGACY_ROLE_MISMATCH_CODE = "selected-role-mismatch";
const ROLE_MISMATCH_MESSAGE = new AuthSessionError("permission-denied").message;

const attemptSignOut = () => {
  try {
    return Promise.resolve(signOutUser()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
};

const getStoredRoleError = () => {
  const storedError = sessionStorage.getItem(AUTH_ROLE_ERROR_STORAGE_KEY);
  sessionStorage.removeItem(AUTH_ROLE_ERROR_STORAGE_KEY);
  if (!storedError) return "";
  if (storedError === ROLE_MISMATCH_MESSAGE || storedError === LEGACY_ROLE_MISMATCH_CODE) {
    return ROLE_MISMATCH_MESSAGE;
  }
  if (storedError.startsWith(LEGACY_LINK_ERROR_PREFIX)) {
    return new AuthSessionError("data-integrity").message;
  }
  return new AuthSessionError(storedError).message;
};

const LoginPage = () => {
  const [email,        setEmail]        = useState("");
  const [pass,         setPass]         = useState("");
  const [selectedRole, setSelectedRole] = useState("");
  const [err,          setErr]          = useState(getStoredRoleError);
  const [loading,      setLoading]      = useState(false);
  const loginInFlight = useRef(false);

  const handleLogin = async (event) => {
    event?.preventDefault();
    if (!selectedRole) { setErr(ROLE_REQUIRED_MESSAGE); return; }
    if (!email || !pass) { setErr("Please enter email and password."); return; }
    if (loginInFlight.current) return;

    loginInFlight.current = true;
    setLoading(true);
    setErr("");
    let signedInUser = null;

    try {
      sessionStorage.setItem(AUTH_ROLE_STORAGE_KEY, selectedRole);
      sessionStorage.removeItem(AUTH_ROLE_ERROR_STORAGE_KEY);
      const credential = await signIn(email, pass);
      signedInUser = credential.user;
      const principal = await verifyAuthSession(selectedRole);
      if (principal?.linkage !== "uid" || !principal.employee) {
        throw new AuthSessionError("data-integrity");
      }

      // The session store publishes the user and App.jsx takes over from here.
      // No manual state update needed here.
    } catch (error) {
      const safeMessage = error instanceof AuthSessionError
        ? error.message
        : SIGN_IN_FAILURE_MESSAGE;
      const signOutPromise = signedInUser
        ? attemptSignOut()
        : Promise.resolve();

      try {
        sessionStorage.removeItem(AUTH_ROLE_STORAGE_KEY);
      } catch {
        // Sign-out still proceeds when session storage is unavailable.
      }
      setErr(safeMessage);
      setLoading(false);
      loginInFlight.current = false;
      await signOutPromise;
    }
    // Note: don't setLoading(false) on success — App.jsx will unmount this component
  };

  return (
    <div className="login-page">
      <PageMotion>
      <div className="login-wrapper">

        <div className="login-header">
          <div className="login-logo">
            <Briefcase size={24} aria-hidden="true" />
          </div>
          <h1 className="login-title">Sigma HRM <span>Portal</span></h1>
          <p className="login-subtitle">Human resource management</p>
        </div>

        <form className="login-card" onSubmit={handleLogin} noValidate>
          <h2 className="login-heading">Sign in to your account</h2>

          <div className="login-roles" role="group" aria-label="Sign in as">
            <div className="login-roles__label">Sign in as</div>
            <div className="login-roles__options">
              {LOGIN_ROLES.map((role) => {
                const isActive = selectedRole === role.value;

                return (
                  <button
                    key={role.value}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => {
                      setSelectedRole(role.value);
                      setErr((currentError) =>
                        currentError === ROLE_REQUIRED_MESSAGE ? "" : currentError,
                      );
                    }}
                    className="login-role"
                  >
                    {role.label}
                  </button>
                );
              })}
            </div>
          </div>

          <Input
            label="Email address"
            type="email"
            autoComplete="username"
            placeholder="you@company.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />

          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={pass}
            onChange={e => setPass(e.target.value)}
          />

          <FormFeedback>{err}</FormFeedback>

          <Btn type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Btn>
        </form>

      </div>
      </PageMotion>
    </div>
  );
};

export default LoginPage;
