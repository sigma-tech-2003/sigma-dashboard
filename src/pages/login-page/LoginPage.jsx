import "./LoginPage.css";
import { useState } from "react";
import { T } from "../../theme/theme";
import { Briefcase } from "lucide-react";
import Input from "../../components/input/Input";

const LoginPage = ({ onLogin, employees }) => {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const demos = [
    { label: "Admin", email: "admin@hrm.com", pass: "admin123", color: T.purple },
    { label: "HR", email: "hr@hrm.com", pass: "hr123", color: T.secondary },
    { label: "Emp", email: "emp@hrm.com", pass: "emp123", color: T.primary },
  ];

  const handleLogin = () => {
    console.log("Employees:", employees);
    setLoading(true);
    setErr("");
    setTimeout(() => {
      const u = employees.find(e => e.email === email && e.pass === pass);
      if (u) onLogin(u);
      else setErr("Invalid credentials. Try demo accounts below.");
      setLoading(false);
    }, 600);
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
            <Briefcase size={24} color="#fff" />
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
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
          }}
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
            onClick={handleLogin}
            disabled={loading}
            className="login-btn"
            style={{
              background: `linear-gradient(135deg,${T.primary},${T.purple})`,
              color: "#fff",
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? "Signing in…" : "Sign In →"}
          </button>
        </div>

        <div
          className="demo-box"
          style={{
            background: T.surface,
            border: `1px solid ${T.border}`,
          }}
        >
          <div className="demo-title" style={{ color: T.muted }}>
            Quick Demo Access
          </div>

          <div className="demo-buttons">
            {demos.map(d => (
              <button
                key={d.label}
                onClick={() => {
                  setEmail(d.email);
                  setPass(d.pass);
                }}
                className="demo-btn"
                style={{
                  background: `${d.color}14`,
                  border: `1px solid ${d.color}30`,
                  color: d.color,
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
};

export default LoginPage;