// src/pages/leave/LeavePage.jsx
import { useState } from "react";
import { Plus, Check, X, CalendarDays, Ban } from "lucide-react";

import { T } from "../../theme/theme";
import { fdate } from "../../utils/helpers";
import { can, scopeByEmployee } from "../../utils/permissions";
import { usageCards } from "../../utils/leaveUsage";
import Badge       from "../../components/badge/Badge";
import PersonCell  from "../../components/person-cell/PersonCell";
import PageHeader  from "../../components/page-header/PageHeader";
import Stat        from "../../components/stat/Stat";
import DataTable   from "../../components/data-table/DataTable";
import EmptyState  from "../../components/empty-state/EmptyState";
import IconButton  from "../../components/icon-button/IconButton";
import ConfirmDialog from "../../components/confirm-dialog/ConfirmDialog";
import Modal       from "../../components/modal/Modal";
import Input       from "../../components/input/Input";
import Select      from "../../components/select/Select";
import Textarea    from "../../components/textarea/Textarea";
import Btn         from "../../components/btn/Btn";
import FormFeedback from "../../components/form-feedback/FormFeedback";
import { guardedSave, leaveDatesError } from "../../utils/saveErrors";
import { useToast } from "../../components/toast/toastContext";

const LeavePage = ({ leaves, addLeave, updateLeaveStatus, cancelLeave, employees, user, leaveBalances }) => {
  const toast = useToast();
  const [modal, setModal] = useState(false);
  const [form,  setForm]  = useState({ type: "Annual" });
  const [applyError,    setApplyError]    = useState("");   // inside the Apply for Leave form
  const [applying,      setApplying]      = useState(false);
  const [decisionError, setDecisionError] = useState("");   // above the table (approve / reject / cancel)
  const [deciding,      setDeciding]      = useState(false);
  const [flash,         setFlash]         = useState(null); // the row just decided, highlighted for a moment
  const [cancelling,    setCancelling]    = useState(null); // the request awaiting "Cancel this request?" confirmation

  const canApproveLeave = can(user, "approveLeave");
  // Admin/HR see all requests; manager sees their dept; tl sees their team;
  // employee sees only their own.
  const visible  = canApproveLeave
    ? scopeByEmployee(user, leaves, employees).filter(l => user.role !== "tl" || String(l.empId) !== String(user.id))
    : leaves.filter(l => l.empId === user.id);
  const myBal    = leaveBalances[user.id] || {};

  const openApply = () => { setApplyError(""); setModal(true); };

  // A failed request keeps the form open and says why; it never looks as if it was sent.
  const applyLeave = async () => {
    if (applying) return;
    const datesError = leaveDatesError(form.start, form.end);
    if (datesError) {
      setApplyError(datesError);
      return;
    }
    const days = Math.max(1, Math.round((new Date(form.end) - new Date(form.start)) / 86400000) + 1);
    setApplying(true);
    setApplyError("");
    const result = await guardedSave(() => addLeave({
      id:      Date.now(),
      empId:   user.id,
      type:    form.type,
      start:   form.start,
      end:     form.end,
      days,
      reason:  form.reason,
      status:  "pending",
      applied: new Date().toISOString().split("T")[0],
    }), { fallback: "The leave request could not be sent. Please try again." });
    setApplying(false);
    if (!result.ok) {
      setApplyError(result.message);
      return;
    }
    setModal(false);
    setForm({ type: "Annual" });
    toast.success("Leave request sent");
  };

  const decide = async (id, status) => {
    if (deciding) return;
    setDeciding(true);
    setDecisionError("");
    const result = await guardedSave(() => updateLeaveStatus(id, status), { fallback: "The decision could not be saved. Please try again." });
    setDeciding(false);
    if (!result.ok) setDecisionError(result.message);
    else {
      toast.success(status === "approved" ? "Leave approved" : "Leave rejected");
      setFlash(id);
      setTimeout(() => setFlash((current) => (current === id ? null : current)), 1400);
    }
  };

  // An employee withdrawing their own pending request. The server refuses it if it was decided in the meantime.
  const cancelRequest = async () => {
    if (deciding || !cancelling) return;
    setDeciding(true);
    setDecisionError("");
    const result = await guardedSave(() => cancelLeave(cancelling.id), { fallback: "The request could not be cancelled. Please try again." });
    setDeciding(false);
    setCancelling(null);
    if (!result.ok) setDecisionError(result.message);
    else toast.success("Leave request cancelled");
  };

  const applyButton = <Btn onClick={openApply}><Plus size={16} aria-hidden="true" />Apply for leave</Btn>;

  return (
    <div>
      <PageHeader
        title="Leave"
        description={canApproveLeave ? "Requests from your employees" : "Your leave overview"}
        actions={!canApproveLeave ? applyButton : null}
      />

      {decisionError && <div style={{ marginBottom: 16 }}><FormFeedback>{decisionError}</FormFeedback></div>}

      {/* Employee: leave usage cards (D40: there are no entitlements, so only days taken) */}
      {!canApproveLeave && (
        <div className="stat-grid stat-grid--compact">
          {usageCards(myBal).map(({ type, days, year }) => (
            <Stat key={type} label={`${type} leave`} value={days} sub={`days taken in ${year}`} icon={CalendarDays} color={T.primaryText} />
          ))}
        </div>
      )}

      <DataTable
        label="Leave requests"
        empty={visible.length === 0 ? (
          canApproveLeave ? (
            <EmptyState icon={CalendarDays} title="No leave requests" description="When someone on your team asks for leave, the request will be listed here for you to approve or reject." />
          ) : (
            <EmptyState icon={CalendarDays} title="You haven't asked for leave yet" description="Requests you send are listed here with their status, and your manager is asked to decide.">
              {applyButton}
            </EmptyState>
          )
        ) : null}
      >
        <thead>
          <tr>
            {canApproveLeave && <th>Employee</th>}
            <th>Type</th>
            <th>Period</th>
            <th className="cell-number">Days</th>
            <th>Reason</th>
            <th>Applied</th>
            <th>Status</th>
            <th>{canApproveLeave ? "Decision" : <span className="sr-only">Actions</span>}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map(l => {
            const emp = employees.find(e => e.id === l.empId);
            const mine = String(l.empId) === String(user.id);
            return (
              <tr key={l.id} className={flash === l.id ? "row-flash" : undefined}>
                {canApproveLeave && <td data-primary><PersonCell emp={emp} /></td>}
                <td data-label="Type" {...(!canApproveLeave && { "data-primary": true })} style={{ fontWeight: 500 }}>{l.type}</td>
                <td data-label="Period">{fdate(l.start)} → {fdate(l.end)}</td>
                <td data-label="Days" className="cell-number">{l.days}</td>
                <td data-label="Reason" className="cell-truncate" title={l.reason} style={{ color: T.mutedLight }}>{l.reason}</td>
                <td data-label="Applied" style={{ whiteSpace: "nowrap", color: T.mutedLight }}>{fdate(l.applied)}</td>
                <td data-label="Status"><Badge s={l.status} /></td>
                {canApproveLeave ? (
                  <td className="cell-actions">
                    {l.status === "pending" && mine ? (
                      <span style={{ color: T.muted, fontSize: 12 }}>Your own request</span>
                    ) : l.status === "pending" ? (
                      <div className="row-actions">
                        <IconButton icon={Check} label={`Approve leave for ${emp?.name || "employee"}`} onClick={() => decide(l.id, "approved")} disabled={deciding} />
                        <IconButton icon={X} variant="danger" label={`Reject leave for ${emp?.name || "employee"}`} onClick={() => decide(l.id, "rejected")} disabled={deciding} />
                      </div>
                    ) : null}
                  </td>
                ) : (
                  <td className="cell-actions">
                    {mine && l.status === "pending" && (
                      <IconButton icon={Ban} variant="danger" label={`Cancel your ${l.type} leave request`} onClick={() => setCancelling(l)} disabled={deciding} />
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      {cancelling && (
        <ConfirmDialog
          title="Cancel this request?"
          message={`Your ${cancelling.type} leave request for ${fdate(cancelling.start)} to ${fdate(cancelling.end)} will be withdrawn. You can apply again at any time.`}
          confirmLabel="Cancel request"
          cancelLabel="Keep request"
          onConfirm={cancelRequest}
          onClose={() => setCancelling(null)}
        />
      )}

      {/* Apply Leave Modal */}
      {modal && (
        <Modal title="Apply for leave" onClose={() => setModal(false)}>
          <Select label="Leave type" value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}>
            <option>Annual</option>
            <option>Sick</option>
            <option>Casual</option>
            <option>Maternity</option>
            <option>Emergency</option>
          </Select>
          <div className="form-grid">
            <Input label="Start date" type="date" value={form.start || ""} onChange={e => setForm(p => ({ ...p, start: e.target.value }))} />
            <Input label="End date"   type="date" value={form.end   || ""} onChange={e => setForm(p => ({ ...p, end:   e.target.value }))} />
          </div>
          <Textarea
            label="Reason"
            value={form.reason || ""}
            onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
            rows={3}
          />
          <FormFeedback>{applyError}</FormFeedback>

          <div className="modal-actions">
            <Btn variant="ghost" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn onClick={applyLeave} disabled={!form.start || !form.end || !form.reason || applying}>
              <Check size={16} aria-hidden="true" />{applying ? "Sending…" : "Submit request"}
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default LeavePage;
