// src/pages/leave/LeavePage.jsx
import { useState } from "react";
import { Plus, Check, X } from "lucide-react";

import { T } from "../../theme/theme";
import { fdate } from "../../utils/helpers";
import Badge       from "../../components/badge/Badge";
import Avatar      from "../../components/avatar/Avatar";
import Modal       from "../../components/modal/Modal";
import Input       from "../../components/input/Input";
import Select      from "../../components/select/Select";
import Btn         from "../../components/btn/Btn";
import ProgressBar from "../../components/ProgressBar/ProgressBar";

const LeavePage = ({ leaves, addLeave, updateLeaveStatus, employees, user, leaveBalances }) => {
  const [modal, setModal] = useState(false);
  const [form,  setForm]  = useState({ type: "Annual" });

  const isAdmin = user.role !== "employee";
  const visible  = isAdmin ? leaves : leaves.filter(l => l.empId === user.id);
  const myBal    = leaveBalances[user.id] || {};

  const applyLeave = async () => {
    const days = Math.max(1, Math.round((new Date(form.end) - new Date(form.start)) / 86400000) + 1);
    await addLeave({
      id:      Date.now(),
      empId:   user.id,
      type:    form.type,
      start:   form.start,
      end:     form.end,
      days,
      reason:  form.reason,
      status:  "pending",
      applied: new Date().toISOString().split("T")[0],
    });
    setModal(false);
    setForm({ type: "Annual" });
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>Leave Management</div>
          <div style={{ fontSize: 12, color: T.muted }}>{isAdmin ? "All employee requests" : "Your leave overview"}</div>
        </div>
        {!isAdmin && (
          <Btn onClick={() => setModal(true)}><Plus size={14} />Apply for Leave</Btn>
        )}
      </div>

      {/* Employee: leave balance cards */}
      {!isAdmin && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          {Object.entries(myBal).map(([type, bal]) => (
            <div key={type} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, flex: "1 1 140px", minWidth: 140 }}>
              <div style={{ fontSize: 11, color: T.muted, fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.8 }}>{type} Leave</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: T.text }}>{bal.r}</div>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 8 }}>of {bal.t} days remaining</div>
              <ProgressBar value={bal.r} max={bal.t} color={bal.r > 5 ? T.success : T.warning} />
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {[isAdmin && "Employee", "Type", "Period", "Days", "Reason", "Applied", "Status", isAdmin && "Action"]
                  .filter(Boolean)
                  .map(h => (
                    <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: 0.8, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(l => {
                const emp = employees.find(e => e.id === l.empId);
                return (
                  <tr key={l.id}
                    style={{ borderBottom: `1px solid ${T.border}`, transition: "background .15s" }}
                    onMouseEnter={e => (e.currentTarget.style.background = T.cardHover)}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                    {isAdmin && (
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {emp && <Avatar emp={emp} size={28} />}
                          <span style={{ fontSize: 13, color: T.text, fontWeight: 600 }}>{emp?.name}</span>
                        </div>
                      </td>
                    )}
                    <td style={{ padding: "12px 16px" }}>
                      <span style={{ background: `${T.primary}15`, color: T.primary, padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{l.type}</span>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: 12, color: T.mutedLight, whiteSpace: "nowrap" }}>{fdate(l.start)} → {fdate(l.end)}</td>
                    <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 700, color: T.text }}>{l.days}d</td>
                    <td style={{ padding: "12px 16px", fontSize: 12, color: T.muted, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.reason}</td>
                    <td style={{ padding: "12px 16px", fontSize: 11, color: T.muted, whiteSpace: "nowrap" }}>{fdate(l.applied)}</td>
                    <td style={{ padding: "12px 16px" }}><Badge s={l.status} /></td>
                    {isAdmin && (
                      <td style={{ padding: "12px 16px" }}>
                        {l.status === "pending" ? (
                          <div style={{ display: "flex", gap: 6 }}>
                            <button onClick={() => updateLeaveStatus(l.id, "approved")} style={{ background: T.successGlow, border: "none", color: T.success, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}><Check size={13} /></button>
                            <button onClick={() => updateLeaveStatus(l.id, "rejected")} style={{ background: T.dangerGlow,  border: "none", color: T.danger,  padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}><X    size={13} /></button>
                          </div>
                        ) : <span style={{ fontSize: 11, color: T.muted }}>Done</span>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && (
          <div style={{ padding: 32, textAlign: "center", color: T.muted, fontSize: 13 }}>No leave requests found.</div>
        )}
      </div>

      {/* Apply Leave Modal */}
      {modal && (
        <Modal title="Apply for Leave" onClose={() => setModal(false)}>
          <Select label="Leave Type" value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}>
            <option>Annual</option>
            <option>Sick</option>
            <option>Casual</option>
            <option>Maternity</option>
            <option>Emergency</option>
          </Select>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
            <Input label="Start Date" type="date" value={form.start || ""} onChange={e => setForm(p => ({ ...p, start: e.target.value }))} />
            <Input label="End Date"   type="date" value={form.end   || ""} onChange={e => setForm(p => ({ ...p, end:   e.target.value }))} />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, color: T.muted, marginBottom: 6, fontWeight: 600 }}>Reason</label>
            <textarea
              value={form.reason || ""}
              onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
              rows={3}
              style={{ width: "100%", background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "9px 12px", color: T.text, fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit" }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Btn variant="ghost" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn onClick={applyLeave} disabled={!form.start || !form.end || !form.reason}>
              <Check size={13} />Submit Request
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default LeavePage;
