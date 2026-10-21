// src/pages/change-password/ChangePasswordPage.jsx
// The forced first-login screen (D41). Someone with a temporary password set by their creator (or reset by an admin or
// hr) sees ONLY this until they replace it: App.jsx renders it before the workspace, and the server refuses every
// other request for the account in the meantime. Built from the login page's own markup and styles.

import "../login-page/LoginPage.css";
import { useRef, useState } from "react";
import { T } from "../../theme/theme";
import { Briefcase } from "lucide-react";
import Input from "../../components/input/Input";
import { useApp } from "../../app/index.js";
import { PasswordChangeError, changeOwnPassword } from "../../services/authService";

const MISMATCH_MESSAGE = "The two new passwords do not match.";

const ChangePasswordPage = () => {
  const { logout } = useApp();
  const [current, setCurrent] = useState("");
  const [next,    setNext]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [err,     setErr]     = useState("");
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const handleSubmit = async () => {
    if (inFlight.current) return;
    if (next !== confirm) { setErr(MISMATCH_MESSAGE); return; }

    inFlight.current = true;
    setLoading(true);
    setErr("");
    try {
      // On success the session store clears the flag and App.jsx unmounts this page for the workspace.
      await changeOwnPassword(current, next);
    } catch (error) {
      setErr(error instanceof PasswordChangeError
        ? error.message
        : "Your password could not be changed. Please try again.");
      setLoading(false);
      inFlight.current = false;
    }
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
            Choose your own password
          </div>

          <div style={{ color: T.muted, fontSize: 13, lineHeight: 1.5 }}>
            You signed in with a temporary password that someone else set for you. Choose a password only you
            know to continue.
          </div>

          <Input
            label="Temporary Password"
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
            value={current}
            onChange={e => setCurrent(e.target.value)}
          />

          <Input
            label="New Password"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            hint="8 to 200 characters."
            value={next}
            onChange={e => setNext(e.target.value)}
          />

          <Input
            label="Confirm New Password"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
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
            onClick={handleSubmit}
            disabled={loading}
            className="login-btn"
            style={{
              background: `linear-gradient(135deg,${T.primary},${T.purple})`,
              color: T.white,
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? "Saving…" : "Change password →"}
          </button>

          <button
            type="button"
            onClick={() => logout()}
            disabled={loading}
            style={{
              background: "none",
              border: "none",
              color: T.muted,
              cursor: "pointer",
              fontSize: 13,
              marginTop: 12,
              padding: 0,
              textDecoration: "underline",
            }}
          >
            Sign out
          </button>
        </div>

      </div>
    </div>
  );
};

export default ChangePasswordPage;
