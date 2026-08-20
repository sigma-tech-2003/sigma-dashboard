// src/pages/payroll/MyPayslipsPage.jsx
import { useState } from "react";
import { FileText, Eye } from "lucide-react";

import { T } from "../../theme/theme";
import { fmt } from "../../utils/helpers";
import PayslipModal from "./PayslipModal";

const MyPayslipsPage = ({ payroll, employees, user }) => {
  const [slip, setSlip] = useState(null);

  const mine = payroll.filter(p => p.empId === user.id && p.status === "processed");

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 800, color: T.text, marginBottom: 4 }}>My Payslips</div>
      <div style={{ fontSize: 12, color: T.muted, marginBottom: 20 }}>View and download your monthly salary slips</div>

      {mine.length === 0 ? (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 48, textAlign: "center", color: T.muted }}>
          <FileText size={32} style={{ marginBottom: 12, opacity: 0.4 }} /><br />
          No payslips available yet.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 14 }}>
          {mine.map(p => (
            <div key={p.id}
              style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", transition: "all .2s" }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = T.primary)}
              onMouseLeave={e => (e.currentTarget.style.borderColor = T.border)}>
              <div style={{ background: `linear-gradient(135deg,${T.primary}22,${T.purple}22)`, padding: "14px 18px", borderBottom: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{p.month} {p.year}</div>
                <div style={{ fontSize: 11, color: T.muted }}>Salary Period</div>
              </div>
              <div style={{ padding: 16 }}>
                {[
                  ["Gross",    fmt(p.basic + p.allowances + p.bonus), T.text],
                  ["Deductions", fmt(p.deductions + p.tax),           T.danger],
                  ["Net Pay",  fmt(p.net),                            T.success],
                ].map(([k, v, c]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: T.muted }}>{k}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: c }}>{v}</span>
                  </div>
                ))}
                <button
                  onClick={() => setSlip({ ...p, emp: employees.find(e => e.id === p.empId) })}
                  style={{ width: "100%", marginTop: 8, background: T.primaryGlow, border: `1px solid ${T.primary}30`, color: T.primary, padding: "8px 0", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontFamily: "inherit" }}>
                  <Eye size={13} />View & Download
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {slip && <PayslipModal slip={slip} onClose={() => setSlip(null)} />}
    </div>
  );
};

export default MyPayslipsPage;
