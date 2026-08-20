// src/pages/login-page/LoginPage.jsx
// ✅ Now uses Firebase Auth (signInWithEmailAndPassword)
//    No more local employees array check. No more onLogin / employees props.
//    When login succeeds, App.jsx onAuthStateChanged fires automatically.

import "./LoginPage.css";
import { useState } from "react";
import { T } from "../../theme/theme";
import { Briefcase } from "lucide-react";
import Input from "../../components/input/Input";
import { signIn, signOutUser } from "../../services/authService";
import { findEmployeeByEmail } from "../../services/firestoreService";
import {
  AUTH_ROLE_ERROR_STORAGE_KEY,
  AUTH_ROLE_MISMATCH_MESSAGE,
  AUTH_ROLE_STORAGE_KEY,
} from "../../hooks/useAuthSession";

const LOGIN_ROLES = [
  { value: "admin", label: "Admin" },
  { value: "hr", label: "HR" },
  { value: "manager", label: "Manager" },
  { value: "tl", label: "Team Lead" },
  { value: "employee", label: "Employee" },
];
const ROLE_REQUIRED_MESSAGE = "Please select a role before signing in.";

const getStoredRoleError = () => {
  const storedError = sessionStorage.getItem(AUTH_ROLE_ERROR_STORAGE_KEY);
  sessionStorage.removeItem(AUTH_ROLE_ERROR_STORAGE_KEY);
  return storedError === AUTH_ROLE_MISMATCH_MESSAGE ? storedError : "";
};

const LoginPage = () => {
  const [email,        setEmail]        = useState("");
  const [pass,         setPass]         = useState("");
  const [selectedRole, setSelectedRole] = useState("");
  const [err,          setErr]          = useState(getStoredRoleError);
  const [loading,      setLoading]      = useState(false);

  const handleLogin = async () => {
    if (!selectedRole) { setErr(ROLE_REQUIRED_MESSAGE); return; }
    if (!email || !pass) { setErr("Please enter email and password."); return; }
    setLoading(true);
    setErr("");
    sessionStorage.setItem(AUTH_ROLE_STORAGE_KEY, selectedRole);
    sessionStorage.removeItem(AUTH_ROLE_ERROR_STORAGE_KEY);
    try {
      const credential = await signIn(email, pass);
      const employee = await findEmployeeByEmail(credential.user.email);

      if (!employee || employee.role !== selectedRole) {
        const signOutPromise = signOutUser();
        sessionStorage.removeItem(AUTH_ROLE_STORAGE_KEY);
        setErr(AUTH_ROLE_MISMATCH_MESSAGE);
        setLoading(false);
        await signOutPromise.catch(() => {});
        return;
      }

      // ✅ App.jsx onAuthStateChanged will detect this login and set the user.
      // No manual state update needed here.
    } catch {
      sessionStorage.removeItem(AUTH_ROLE_STORAGE_KEY);
      setErr("Invalid email or password.");
      setLoading(false);
    }
    // Note: don't setLoading(false) on success — App.jsx will unmount this component
  };

  return (
    <div className="login-page" style={{ background: T.bg }}>
      <div className="login-wrapper">

        <div className="login-header">
          <div
            className="login-logo"
            style={{
              background: `linear-gradient(135deg,${T.primary},${T.purple})`,
              boxShadow: `0 8px 32px ${T.primaryGlow}`,
            }}
          >
            <Briefcase size={24} color={T.white} />
          </div>

          <div className="login-title" style={{ color: T.text }}>
            SIGMA HRM <span style={{ color: T.primary }}>Portal</span>
          </div>

          <div className="login-subtitle" style={{ color: T.muted }}>
            Human Resource Management System
          </div>
        </div>

        <div
          className="login-card"
          style={{ background: T.card, border: `1px solid ${T.border}` }}
        >
          <div className="login-heading" style={{ color: T.text }}>
            Sign in to your account
          </div>

          <Input
            label="Email Address"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />

          <Input
            label="Password"
            type="password"
            placeholder="••••••••"
            value={pass}
            onChange={e => setPass(e.target.value)}
          />

          {err && (
            <div
              className="login-error"
              role="alert"
              style={{
                background: T.dangerGlow,
                border: `1px solid ${T.danger}30`,
                color: T.danger,
              }}
            >
              {err}
            </div>
          )}

          <button
            type="button"
            onClick={handleLogin}
            disabled={loading}
            className="login-btn"
            style={{
              background: `linear-gradient(135deg,${T.primary},${T.purple})`,
              color: T.white,
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? "Signing in…" : "Sign In →"}
          </button>
        </div>

        <div
          className="demo-box"
          style={{ background: T.surface, border: `1px solid ${T.border}` }}
        >
          <div className="demo-title" style={{ color: T.muted }}>
            Select your role
          </div>

          <div
            className="demo-buttons"
            role="group"
            aria-label="Select your role"
            style={{ flexWrap: "wrap" }}
          >
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
                  className="demo-btn"
                  style={{
                    flex: "1 1 112px",
                    background: isActive ? T.primaryTint : T.card,
                    border: `1px solid ${isActive ? T.primary : T.border}`,
                    color: isActive ? T.primary : T.mutedLight,
                    boxShadow: isActive ? `0 0 0 2px ${T.primaryGlow}` : "none",
                    transition: "all 0.15s ease",
                  }}
                >
                  {role.label}
                </button>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
};

export default LoginPage;
