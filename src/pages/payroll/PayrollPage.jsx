// src/pages/payroll/PayrollPage.jsx
import { useState } from "react";
import { Plus, Check, FileText, CreditCard } from "lucide-react";

import { T } from "../../theme/theme";
import { fmt, calcTax } from "../../utils/helpers";
import Badge         from "../../components/badge/Badge";
import Avatar        from "../../components/avatar/Avatar";
import Modal         from "../../components/modal/Modal";
import Input         from "../../components/input/Input";
import Select        from "../../components/select/Select";
import Btn           from "../../components/btn/Btn";
import PayslipModal  from "./PayslipModal";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const PayrollPage = ({ payroll, addPayroll, updatePayrollStatus, employees, user }) => {
  const [modal,  setModal]  = useState(false);
  const [slip,   setSlip]   = useState(null);
  const [selEmp, setSelEmp] = useState("");
  const [form,   setForm]   = useState({ month: "April", year: 2025, bonus: 0, deductions: 0 });

  const process = async () => {
    const emp   = employees.find(e => e.id === +selEmp);
    if (!emp) return;
    const gross = emp.basic + emp.allowances + +form.bonus;
    const tax   = Math.round(calcTax(gross));
    const net   = gross - +form.deductions - tax;
    await addPayroll({
      id:         Date.now(),
      empId:      emp.id,
      month:      form.month,
      year:       +form.year,
      basic:      emp.basic,
      allowances: emp.allowances,
      bonus:      +form.bonus,
      deductions: +form.deductions,
      tax,
      net,
      status:     "processed",
    });
    setModal(false);
  };

  // Preview calculation
  const previewEmp   = selEmp ? employees.find(e => e.id === +selEmp) : null;
  const previewGross = previewEmp ? previewEmp.basic + previewEmp.allowances + +form.bonus : 0;
  const previewTax   = previewEmp ? Math.round(calcTax(previewGross)) : 0;
  const previewNet   = previewEmp ? previewGross - +form.deductions - previewTax : 0;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>Payroll</div>
          <div style={{ fontSize: 12, color: T.muted }}>
            {payroll.filter(p => p.status === "processed").length} processed · {payroll.filter(p => p.status === "draft").length} drafts
          </div>
        </div>
        <Btn variant="outline" onClick={() => setModal(true)}><Plus size={14} />Process Payroll</Btn>
      </div>

      {/* Summary stat cards */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        {[
          { label: "Gross Payroll", val: fmt(payroll.reduce((s, p) => s + (p.basic + p.allowances + p.bonus), 0)), color: T.primary },
          { label: "Total Tax",     val: fmt(payroll.reduce((s, p) => s + p.tax, 0)),                              color: T.danger  },
          { label: "Net Disbursed", val: fmt(payroll.reduce((s, p) => s + p.net, 0)),                              color: T.success },
          { label: "Total Bonuses", val: fmt(payroll.reduce((s, p) => s + p.bonus, 0)),                            color: T.warning },
        ].map(s => (
          <div key={s.label} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "16px 20px", flex: "1 1 160px", minWidth: 150 }}>
            <div style={{ fontSize: 11, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {["Employee","Period","Basic","Allowances","Bonus","Deductions","Tax","Net Pay","Status","Action"].map(h => (
                  <th key={h} style={{ padding: "12px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: 0.8, whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payroll.map(p => {
                const emp = employees.find(e => e.id === p.empId);
                return (
                  <tr key={p.id}
                    style={{ borderBottom: `1px solid ${T.border}`, transition: "background .15s" }}
                    onMouseEnter={e => (e.currentTarget.style.background = T.cardHover)}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                    <td style={{ padding: "11px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {emp && <Avatar emp={emp} size={28} />}
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{emp?.name}</div>
                          <div style={{ fontSize: 10, color: T.muted }}>{emp?.dept}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "11px 14px", fontSize: 12, color: T.mutedLight, whiteSpace: "nowrap" }}>{p.month} {p.year}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, color: T.text }}>{fmt(p.basic)}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, color: T.text }}>{fmt(p.allowances)}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, color: p.bonus      ? T.success : T.muted }}>{fmt(p.bonus)}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, color: p.deductions ? T.danger  : T.muted }}>{fmt(p.deductions)}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, color: T.danger }}>{fmt(p.tax)}</td>
                    <td style={{ padding: "11px 14px", fontSize: 12, fontWeight: 800, color: T.success }}>{fmt(p.net)}</td>
                    <td style={{ padding: "11px 14px" }}><Badge s={p.status} /></td>
                    <td style={{ padding: "11px 14px" }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => setSlip({ ...p, emp })}
                          style={{ background: T.primaryGlow, border: "none", color: T.primary, padding: "5px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                          <FileText size={12} />Slip
                        </button>
                        {p.status === "draft" && (
                          <button
                            onClick={() => updatePayrollStatus(p.id, "processed")}
                            style={{ background: T.successGlow, border: "none", color: T.success, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}>
                            <Check size={12} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Process Payroll Modal */}
      {modal && (
        <Modal title="Process Payroll" onClose={() => setModal(false)}>
          <Select label="Select Employee" value={selEmp} onChange={e => setSelEmp(e.target.value)}>
            <option value="">Choose employee…</option>
            {employees.filter(e => e.role === "employee").map(e => (
              <option key={e.id} value={e.id}>{e.name} — {e.pos}</option>
            ))}
          </Select>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
            <Select label="Month" value={form.month} onChange={e => setForm(p => ({ ...p, month: e.target.value }))}>
              {MONTHS.map(m => <option key={m}>{m}</option>)}
            </Select>
            <Input label="Year"             value={form.year}       onChange={e => setForm(p => ({ ...p, year:       e.target.value }))} type="number" />
            <Input label="Bonus (PKR)"      value={form.bonus}      onChange={e => setForm(p => ({ ...p, bonus:      e.target.value }))} type="number" />
            <Input label="Deductions (PKR)" value={form.deductions} onChange={e => setForm(p => ({ ...p, deductions: e.target.value }))} type="number" />
          </div>

          {/* Preview */}
          {previewEmp && (
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: T.muted, fontWeight: 700, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.8 }}>Payroll Preview</div>
              {[
                ["Basic Salary", fmt(previewEmp.basic),        T.text],
                ["Allowances",   fmt(previewEmp.allowances),   T.text],
                ["Bonus",        fmt(+form.bonus),              T.success],
                ["Deductions",   `-${fmt(+form.deductions)}`,  T.danger],
                ["Income Tax",   `-${fmt(previewTax)}`,        T.danger],
              ].map(([k, v, c]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 12, color: T.muted }}>{k}</span>
                  <span style={{ fontSize: 12, color: c, fontWeight: 600 }}>{v}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", marginTop: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Net Pay</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: T.success }}>{fmt(previewNet)}</span>
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Btn variant="ghost" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn onClick={process} disabled={!selEmp}><CreditCard size={13} />Process</Btn>
          </div>
        </Modal>
      )}

      {slip && <PayslipModal slip={slip} onClose={() => setSlip(null)} />}
    </div>
  );
};

export default PayrollPage;
