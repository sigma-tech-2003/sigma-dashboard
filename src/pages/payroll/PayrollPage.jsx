// src/pages/payroll/PayrollPage.jsx
import { useState } from "react";
import { Plus, Check, FileText, CreditCard, Wallet, Receipt, Landmark, Gift, Banknote } from "lucide-react";

import "./Payroll.css";
import { T } from "../../theme/theme";
import { fmt, calcTax } from "../../utils/helpers";
import { findRecordById } from "../../services/legacyShape";
import Badge         from "../../components/badge/Badge";
import PersonCell    from "../../components/person-cell/PersonCell";
import PageHeader    from "../../components/page-header/PageHeader";
import Stat          from "../../components/stat/Stat";
import DataTable     from "../../components/data-table/DataTable";
import EmptyState    from "../../components/empty-state/EmptyState";
import IconButton    from "../../components/icon-button/IconButton";
import Modal         from "../../components/modal/Modal";
import Input         from "../../components/input/Input";
import Select        from "../../components/select/Select";
import Btn           from "../../components/btn/Btn";
import FormFeedback from "../../components/form-feedback/FormFeedback";
import { guardedSave } from "../../utils/saveErrors";
import { useToast } from "../../components/toast/toastContext";
import PayslipModal  from "./PayslipModal";
import LoadErrorGate from "../../components/load-error/LoadErrorGate";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const PayrollPageContent = ({ payroll, addPayroll, updatePayrollStatus, employees }) => {
  const toast = useToast();
  const [modal,  setModal]  = useState(false);
  const [slip,   setSlip]   = useState(null);
  const [selEmp, setSelEmp] = useState("");
  const [form,   setForm]   = useState({ month: "April", year: 2025, bonus: 0, deductions: 0 });
  const [processError, setProcessError] = useState("");   // shown inside the Process Payroll form
  const [processing,   setProcessing]   = useState(false);
  const [actionError,  setActionError]  = useState("");   // shown above the table (marking a draft processed)
  const [marking,      setMarking]      = useState(false);

  const openProcess = () => { setProcessError(""); setModal(true); };

  // A failed save keeps the form open and says why; it never looks as if it worked.
  const process = async () => {
    const emp   = findRecordById(employees, selEmp);
    if (!emp || processing) return;
    const gross = emp.basic + emp.allowances + +form.bonus;
    const tax   = Math.round(calcTax(gross));
    const net   = gross - +form.deductions - tax;
    setProcessing(true);
    setProcessError("");
    const result = await guardedSave(() => addPayroll({
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
    }), { fallback: "The payroll record could not be saved. Please try again." });
    setProcessing(false);
    if (!result.ok) {
      setProcessError(result.message);
      return;
    }
    setModal(false);
    toast.success("Payroll processed");
  };

  const markProcessed = async (record) => {
    if (marking) return;
    setMarking(true);
    setActionError("");
    const result = await guardedSave(() => updatePayrollStatus(record.id, "processed"), { fallback: "The payroll record could not be marked as processed. Please try again." });
    setMarking(false);
    if (!result.ok) setActionError(result.message);
    else toast.success("Payroll marked as processed");
  };

  // Preview calculation
  const previewEmp   = selEmp ? findRecordById(employees, selEmp) : null;
  const previewGross = previewEmp ? previewEmp.basic + previewEmp.allowances + +form.bonus : 0;
  const previewTax   = previewEmp ? Math.round(calcTax(previewGross)) : 0;
  const previewNet   = previewEmp ? previewGross - +form.deductions - previewTax : 0;

  const totals = [
    { label: "Gross payroll", value: fmt(payroll.reduce((s, p) => s + (p.basic + p.allowances + p.bonus), 0)), icon: Banknote, color: T.primaryText },
    { label: "Total tax",     value: fmt(payroll.reduce((s, p) => s + p.tax, 0)),                              icon: Landmark, color: T.danger },
    { label: "Net disbursed", value: fmt(payroll.reduce((s, p) => s + p.net, 0)),                              icon: Wallet,   color: T.success },
    { label: "Total bonuses", value: fmt(payroll.reduce((s, p) => s + p.bonus, 0)),                            icon: Gift,     color: T.warning },
  ];
  const processedCount = payroll.filter(p => p.status === "processed").length;
  const draftCount     = payroll.filter(p => p.status === "draft").length;

  return (
    <div>
      <PageHeader
        title="Payroll"
        description={`${processedCount} processed · ${draftCount} ${draftCount === 1 ? "draft" : "drafts"}`}
        actions={<Btn onClick={openProcess}><Plus size={16} aria-hidden="true" />Process payroll</Btn>}
      />

      {actionError && <div style={{ marginBottom: 16 }}><FormFeedback>{actionError}</FormFeedback></div>}

      <div className="stat-grid">
        {totals.map(s => <Stat key={s.label} label={s.label} value={s.value} icon={s.icon} color={s.color} />)}
      </div>

      <DataTable
        label="Payroll records"
        empty={payroll.length === 0 ? (
          <EmptyState icon={Receipt} title="No payroll processed yet" description="Process payroll for an employee and the record, with its payslip, will be listed here.">
            <Btn onClick={openProcess}><Plus size={16} aria-hidden="true" />Process payroll</Btn>
          </EmptyState>
        ) : null}
      >
        <thead>
          <tr>
            <th>Employee</th>
            <th>Period</th>
            <th className="cell-number">Basic</th>
            <th className="cell-number">Allowances</th>
            <th className="cell-number">Bonus</th>
            <th className="cell-number">Deductions</th>
            <th className="cell-number">Tax</th>
            <th className="cell-number">Net pay</th>
            <th>Status</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {payroll.map(p => {
            const emp = employees.find(e => e.id === p.empId);
            return (
              <tr key={p.id}>
                <td data-primary><PersonCell emp={emp} sub={emp?.dept} /></td>
                <td data-label="Period" style={{ whiteSpace: "nowrap" }}>{p.month} {p.year}</td>
                <td data-label="Basic" className="cell-number">{fmt(p.basic)}</td>
                <td data-label="Allowances" className="cell-number">{fmt(p.allowances)}</td>
                <td data-label="Bonus" className="cell-number" style={{ color: p.bonus ? T.success : T.muted }}>{fmt(p.bonus)}</td>
                <td data-label="Deductions" className="cell-number" style={{ color: p.deductions ? T.text : T.muted }}>{fmt(p.deductions)}</td>
                <td data-label="Tax" className="cell-number">{fmt(p.tax)}</td>
                <td data-label="Net pay" className="cell-number" style={{ fontWeight: 600 }}>{fmt(p.net)}</td>
                <td data-label="Status"><Badge s={p.status} /></td>
                <td className="cell-actions">
                  <div className="row-actions">
                    <IconButton icon={FileText} label={`View payslip for ${emp?.name || "employee"}`} onClick={() => setSlip({ ...p, emp })} />
                    {p.status === "draft" && (
                      <IconButton icon={Check} label={`Mark ${emp?.name || "employee"}'s payroll as processed`} onClick={() => markProcessed(p)} disabled={marking} />
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      {modal && (
        <Modal title="Process payroll" onClose={() => setModal(false)}>
          <Select label="Employee" value={selEmp} onChange={e => setSelEmp(e.target.value)}>
            <option value="">Choose an employee…</option>
            {employees.filter(e => e.role === "employee").map(e => (
              <option key={e.id} value={e.id}>{e.name} — {e.pos}</option>
            ))}
          </Select>
          <div className="form-grid">
            <Select label="Month" value={form.month} onChange={e => setForm(p => ({ ...p, month: e.target.value }))}>
              {MONTHS.map(m => <option key={m}>{m}</option>)}
            </Select>
            <Input label="Year"             value={form.year}       onChange={e => setForm(p => ({ ...p, year:       e.target.value }))} type="number" inputMode="numeric" />
            <Input label="Bonus (PKR)"      value={form.bonus}      onChange={e => setForm(p => ({ ...p, bonus:      e.target.value }))} type="number" inputMode="numeric" />
            <Input label="Deductions (PKR)" value={form.deductions} onChange={e => setForm(p => ({ ...p, deductions: e.target.value }))} type="number" inputMode="numeric" />
          </div>

          {previewEmp && (
            <div className="payroll-preview">
              <div className="payroll-preview__title">Payroll preview</div>
              {[
                ["Basic salary", fmt(previewEmp.basic),        T.text],
                ["Allowances",   fmt(previewEmp.allowances),   T.text],
                ["Bonus",        fmt(+form.bonus),             T.success],
                ["Deductions",   `-${fmt(+form.deductions)}`,  T.text],
                ["Income tax",   `-${fmt(previewTax)}`,        T.text],
              ].map(([k, v, c]) => (
                <div key={k} className="payroll-preview__row">
                  <span>{k}</span>
                  <span style={{ color: c }}>{v}</span>
                </div>
              ))}
              <div className="payroll-preview__net">
                <span>Net pay</span>
                <span>{fmt(previewNet)}</span>
              </div>
            </div>
          )}

          <FormFeedback>{processError}</FormFeedback>

          <div className="modal-actions">
            <Btn variant="ghost" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn onClick={process} disabled={!selEmp || processing}><CreditCard size={16} aria-hidden="true" />{processing ? "Processing…" : "Process"}</Btn>
          </div>
        </Modal>
      )}

      {slip && <PayslipModal slip={slip} onClose={() => setSlip(null)} />}
    </div>
  );
};

// A failed load must not look like an empty payroll: say so instead of rendering a table with no rows.
const PayrollPage = (props) => (
  <LoadErrorGate errors={props.dataErrors} required={{ payroll: props.payroll, employees: props.employees }}>
    <PayrollPageContent {...props} />
  </LoadErrorGate>
);

export default PayrollPage;
