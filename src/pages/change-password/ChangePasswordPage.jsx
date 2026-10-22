// src/pages/change-password/ChangePasswordPage.jsx
// The forced first-login screen (D41). Someone with a temporary password set by their creator (or reset by an admin or
// hr) sees ONLY this until they replace it: App.jsx renders it before the workspace, and the server refuses every
// other request for the account in the meantime. Built from the login page's own markup and styles.

import "../login-page/LoginPage.css";
import { useRef, useState } from "react";
import { Briefcase } from "lucide-react";
import Input from "../../components/input/Input";
import Btn from "../../components/btn/Btn";
import FormFeedback from "../../components/form-feedback/FormFeedback";
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

  const handleSubmit = async (event) => {
    event?.preventDefault();
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
    <div className="login-page">
      <div className="login-wrapper">

        <div className="login-header">
          <div className="login-logo">
            <Briefcase size={24} aria-hidden="true" />
          </div>
          <h1 className="login-title">Sigma HRM <span>Portal</span></h1>
          <p className="login-subtitle">Human resource management</p>
        </div>

        <form className="login-card" onSubmit={handleSubmit} noValidate>
          <h2 className="login-heading">Choose your own password</h2>

          <p className="login-lede">
            You signed in with a temporary password that someone else set for you. Choose a password only you
            know to continue.
          </p>

          <Input
            label="Temporary password"
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
            value={current}
            onChange={e => setCurrent(e.target.value)}
          />

          <Input
            label="New password"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            hint="8 to 200 characters."
            value={next}
            onChange={e => setNext(e.target.value)}
          />

          <Input
            label="Confirm new password"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
          />

          <FormFeedback>{err}</FormFeedback>

          <Btn type="submit" disabled={loading}>
            {loading ? "Saving…" : "Change password"}
          </Btn>

          <button
            type="button"
            className="login-link"
            onClick={() => logout()}
            disabled={loading}
          >
            Sign out
          </button>
        </form>

      </div>
    </div>
  );
};

export default ChangePasswordPage;
