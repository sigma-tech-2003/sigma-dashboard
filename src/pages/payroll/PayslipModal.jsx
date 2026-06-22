// src/pages/payroll/PayslipModal.jsx
import { Printer } from "lucide-react";
import { T } from "../../theme/theme";
import { fmt } from "../../utils/helpers";
import Modal from "../../components/modal/Modal";
import Btn from "../../components/btn/Btn";

const PayslipModal = ({ slip, onClose }) => {
  const print = () => {
    const w = window.open("", "_blank");
    w.document.write(`
      <html><head><title>Payslip</title>
      <style>
        body{font-family:Arial,sans-serif;padding:32px;color:#111;max-width:600px;margin:0 auto}
        h2{font-size:22px;margin-bottom:4px}
        h3{margin-bottom:16px;color:#555;font-size:13px;font-weight:400}
        .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:13px}
        .total{font-size:15px;font-weight:700;color:#1d6fec;padding:10px 0}
        .header{background:#05080f;color:#fff;padding:20px 24px;border-radius:8px;margin-bottom:24px}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
        .box{background:#f8f9fa;padding:12px;border-radius:6px;font-size:12px}
        .box-label{color:#888;margin-bottom:4px}
        .box-val{font-weight:700;font-size:14px}
      </style></head><body>
      <div class="header"><h2>SIGMA HRM Portal</h2><h3>Salary Slip — ${slip.month} ${slip.year}</h3></div>
      <div class="grid">
        <div class="box"><div class="box-label">Employee</div><div class="box-val">${slip.emp?.name || "—"}</div></div>
        <div class="box"><div class="box-label">Department</div><div class="box-val">${slip.emp?.dept || "—"}</div></div>
        <div class="box"><div class="box-label">Position</div><div class="box-val">${slip.emp?.pos || "—"}</div></div>
        <div class="box"><div class="box-label">Employee ID</div><div class="box-val">${slip.emp?.empId || "—"}</div></div>
      </div>
      <div class="row"><span>Basic Salary</span><span>PKR ${slip.basic.toLocaleString()}</span></div>
      <div class="row"><span>Allowances</span><span>PKR ${slip.allowances.toLocaleString()}</span></div>
      <div class="row"><span>Bonus</span><span>PKR ${slip.bonus.toLocaleString()}</span></div>
      <div class="row"><span>Deductions</span><span style="color:#ef4444">- PKR ${slip.deductions.toLocaleString()}</span></div>
      <div class="row"><span>Income Tax</span><span style="color:#ef4444">- PKR ${slip.tax.toLocaleString()}</span></div>
      <div class="row total"><span>Net Pay</span><span>PKR ${slip.net.toLocaleString()}</span></div>
      <p style="font-size:11px;color:#aaa;margin-top:24px;text-align:center">This is a system-generated payslip. No signature required.</p>
    </body></html>`);
    w.document.close();
    w.print();
  };

  return (
    <Modal title={`Payslip — ${slip.month} ${slip.year}`} onClose={onClose}>
      {/* Header banner */}
      <div style={{ background: `linear-gradient(135deg,${T.primary},${T.purple})`, borderRadius: 10, padding: 16, marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{slip.emp?.name}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.7)" }}>{slip.emp?.pos} · {slip.emp?.dept}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.7)", marginTop: 2 }}>{slip.emp?.empId}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.7)" }}>Period</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>{slip.month} {slip.year}</div>
        </div>
      </div>

      {/* Breakdown rows */}
      {[
        ["Basic Salary", fmt(slip.basic), T.text],
        ["Allowances", fmt(slip.allowances), T.text],
        ["Bonus", fmt(slip.bonus), T.success],
        ["Deductions", `-${fmt(slip.deductions)}`, T.danger],
        ["Income Tax (est)", `-${fmt(slip.tax)}`, T.danger],
      ].map(([k, v, c]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
          <span style={{ fontSize: 13, color: T.muted }}>{k}</span>
          <span style={{ fontSize: 13, color: c, fontWeight: 600 }}>{v}</span>
        </div>
      ))}

      {/* Net pay */}
      <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", background: T.successGlow, border: `1px solid ${T.success}30`, borderRadius: 10, marginTop: 14 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Net Pay</span>
        <span style={{ fontSize: 18, fontWeight: 800, color: T.success }}>{fmt(slip.net)}</span>
      </div>

      <div style={{ fontSize: 10, color: T.muted, textAlign: "center", marginTop: 12 }}>
        System generated payslip · No signature required
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 16 }}>
        <Btn variant="ghost" onClick={onClose}>Close</Btn>
        <Btn onClick={print}><Printer size={13} />Print / Download</Btn>
      </div>
    </Modal>
  );
};

export default PayslipModal;
