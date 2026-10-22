// src/pages/payroll/PayslipModal.jsx
import { Printer } from "lucide-react";
import { T } from "../../theme/theme";
import { fmt } from "../../utils/helpers";
import Modal from "../../components/modal/Modal";
import Btn from "../../components/btn/Btn";
import PersonCell from "../../components/person-cell/PersonCell";
import { escapeHtml } from "../../utils/escapeHtml";
import "./Payroll.css";

// The print window is written as HTML and shares this app's origin, so everything from the database that goes into it
// is escaped first: an employee named "<img onerror=…>" must print as text, not run.
const PayslipModal = ({ slip, onClose }) => {
  const print = () => {
    const w = window.open("", "_blank");
    if (!w) return;
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
      <div class="header"><h2>Sigma HRM Portal</h2><h3>Salary slip — ${escapeHtml(slip.month)} ${escapeHtml(slip.year)}</h3></div>
      <div class="grid">
        <div class="box"><div class="box-label">Employee</div><div class="box-val">${escapeHtml(slip.emp?.name || "—")}</div></div>
        <div class="box"><div class="box-label">Department</div><div class="box-val">${escapeHtml(slip.emp?.dept || "—")}</div></div>
        <div class="box"><div class="box-label">Position</div><div class="box-val">${escapeHtml(slip.emp?.pos || "—")}</div></div>
        <div class="box"><div class="box-label">Employee ID</div><div class="box-val">${escapeHtml(slip.emp?.empId || "—")}</div></div>
      </div>
      <div class="row"><span>Basic salary</span><span>PKR ${slip.basic.toLocaleString()}</span></div>
      <div class="row"><span>Allowances</span><span>PKR ${slip.allowances.toLocaleString()}</span></div>
      <div class="row"><span>Bonus</span><span>PKR ${slip.bonus.toLocaleString()}</span></div>
      <div class="row"><span>Deductions</span><span style="color:#ef4444">- PKR ${slip.deductions.toLocaleString()}</span></div>
      <div class="row"><span>Income tax</span><span style="color:#ef4444">- PKR ${slip.tax.toLocaleString()}</span></div>
      <div class="row total"><span>Net pay</span><span>PKR ${slip.net.toLocaleString()}</span></div>
      <p style="font-size:11px;color:#aaa;margin-top:24px;text-align:center">This is a system-generated payslip. No signature required.</p>
    </body></html>`);
    w.document.close();
    w.print();
  };

  const rows = [
    ["Basic salary",     fmt(slip.basic),            T.text],
    ["Allowances",       fmt(slip.allowances),       T.text],
    ["Bonus",            fmt(slip.bonus),            T.success],
    ["Deductions",       `-${fmt(slip.deductions)}`, T.text],
    ["Income tax (est.)", `-${fmt(slip.tax)}`,       T.text],
  ];

  return (
    <Modal title={`Payslip — ${slip.month} ${slip.year}`} onClose={onClose}>
      <div className="payslip-who">
        <PersonCell emp={slip.emp} sub={[slip.emp?.pos, slip.emp?.dept, slip.emp?.empId].filter(Boolean).join(" · ")} size={40} />
      </div>

      {rows.map(([k, v, c]) => (
        <div key={k} className="payslip-row">
          <span>{k}</span>
          <span style={{ color: c }}>{v}</span>
        </div>
      ))}

      <div className="payslip-net">
        <span>Net pay</span>
        <span>{fmt(slip.net)}</span>
      </div>

      <p className="payslip-foot">System-generated payslip. No signature required.</p>

      <div className="modal-actions">
        <Btn variant="ghost" onClick={onClose}>Close</Btn>
        <Btn onClick={print}><Printer size={16} aria-hidden="true" />Print or save as PDF</Btn>
      </div>
    </Modal>
  );
};

export default PayslipModal;
