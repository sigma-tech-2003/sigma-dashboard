// src/pages/employees/EmployeesPage.jsx

import { useRef, useState } from "react";
import { Plus, Search, Edit, Trash2, Check, Eye, KeyRound } from "lucide-react";

import { T }        from "../../theme/theme";
import { fmt, fdate } from "../../utils/helpers";
import { scopeEmployees, assignableRoles, canManageEmployee } from "../../utils/permissions";
import Badge   from "../../components/badge/Badge";
import Avatar  from "../../components/avatar/Avatar";
import Modal   from "../../components/modal/Modal";
import Input   from "../../components/input/Input";
import Select  from "../../components/select/Select";
import Btn     from "../../components/btn/Btn";
import {
  EmployeeInvitationError,
  inviteEmployee,
  resetEmployeePassword,
} from "../../services/employeeInvitationService";
import { EmployeeMutationError } from "../../services/employeeMutationService";
import {
  CREATE_DEPARTMENT_VALUE,
  createDepartmentMessage,
  departmentOptions,
} from "../../utils/departmentOptions";
import { canResetPassword } from "../../utils/passwordReset";

const removePasswordFields = (employee) => {
  const sanitizedEmployee = { ...employee };
  delete sanitizedEmployee.pass;
  delete sanitizedEmployee.password;
  return sanitizedEmployee;
};

const canonicalEmployeeDocumentId = (employee) => {
  const id = typeof employee?._docId === "string" ? employee._docId.trim() : "";
  if (
    !id
    || id !== employee._docId
    || id.includes("/")
    || id === "."
    || id === ".."
    || [...id].some((character) => character.codePointAt(0) < 32)
  ) {
    return null;
  }
  return id;
};

// D41: there is no setup email or link. Whoever creates an employee sets a temporary password and tells the employee
// themselves; the employee must replace it at first sign-in.
const TEMPORARY_PASSWORD_MESSAGE = "Enter a temporary password of 8 to 200 characters.";
const isValidTemporaryPassword = (value) =>
  typeof value === "string" && value.length >= 8 && value.length <= 200;

const EmployeesPage = ({
  employees, updateEmployee, deleteEmployee,
  departments,  // ← new: for dropdown + filter
  addDepartment,
  user,
}) => {
  const [search,     setSearch]     = useState("");
  const [deptFilter, setDeptFilter] = useState("");   // ← new: dept filter
  const [modal,      setModal]      = useState(null); // "add" | "edit" | null
  const [viewEmp,    setViewEmp]    = useState(null);
  const [form,       setForm]       = useState({});
  const [saving,     setSaving]     = useState(false);
  const [formError,  setFormError]  = useState("");
  const [notice,     setNotice]     = useState(null);
  const [resetTarget,   setResetTarget]   = useState(null);  // the employee whose password is being reset
  const [resetPassword,   setResetPassword]   = useState("");
  const [resetting,       setResetting]       = useState(false);
  const [resetError,      setResetError]      = useState("");
  const [creatingDept,    setCreatingDept]    = useState(false); // the inline "Create department" field is open
  const [newDeptName,     setNewDeptName]     = useState("");
  const [deptSaving,      setDeptSaving]      = useState(false);
  const [deptError,       setDeptError]       = useState("");
  const [editEmployeeDocumentId, setEditEmployeeDocumentId] = useState(null);
  const [deletingEmployeeDocumentId, setDeletingEmployeeDocumentId] = useState(null);
  const saveInFlight = useRef(false);
  const resetInFlight = useRef(false);
  const deptInFlight = useRef(false);
  const deleteInFlight = useRef(new Set());

  // Active departments for dropdown
  const activeDepts = departments.filter(d => d.status === "Active");

  // Role-scoped base list — admin/hr see everyone, manager sees their dept,
  // tl sees their team, employee (shouldn't land here) sees only self.
  const scoped = scopeEmployees(user, employees);

  // Which roles can this user assign to a new/edited employee?
  const myAssignableRoles = assignableRoles(user);

  // What the department dropdown offers this role (D42): admin can also create one, HR sees a hint,
  // manager/TL get their own department as the single, locked option.
  const deptChoices = departmentOptions(user, departments, form.dept);

  // Manager/TL are locked to their own department when adding people
  const deptLocked = deptChoices.locked;

  const teamLeadOptions = employees.filter(employee =>
    employee.role === "tl" &&
    employee.dept === (deptLocked ? user.dept : form.dept)
  );

  // ── Filtered list (search + dept filter) ─────────────────────────
  const filtered = scoped.filter(e => {
    const matchSearch =
      (e.name  || "").toLowerCase().includes(search.toLowerCase()) ||
      (e.dept  || "").toLowerCase().includes(search.toLowerCase()) ||
      (e.empId || "").toLowerCase().includes(search.toLowerCase());
    const matchDept = deptFilter === "" || e.dept === deptFilter;
    return matchSearch && matchDept;
  });

  // ── Handlers ─────────────────────────────────────────────────────
  const resetDepartmentCreation = () => {
    setCreatingDept(false);
    setNewDeptName("");
    setDeptError("");
  };

  const openAdd = () => {
    setFormError("");
    setNotice(null);
    resetDepartmentCreation();
    setForm({
      role:       myAssignableRoles[0] || "employee",
      status:     "active",
      allowances: 0,
      temporaryPassword: "",
      dept:       deptLocked ? user.dept : "",
      ...(user.role === "tl" ? { teamLeadId: user.id } : {}),
    });
    setModal("add");
  };
  const openEdit = (emp) => {
    const employeeDocumentId = canonicalEmployeeDocumentId(emp);
    if (!employeeDocumentId) {
      setNotice({
        type: "warning",
        message: "This employee record cannot be changed because its canonical identifier is unavailable.",
      });
      return;
    }
    setFormError("");
    resetDepartmentCreation();
    setForm(removePasswordFields(emp));
    setEditEmployeeDocumentId(employeeDocumentId);
    setModal("edit");
  };

  const closeModal = () => {
    if (saving) return;
    setModal(null);
    setFormError("");
    setEditEmployeeDocumentId(null);
    resetDepartmentCreation();
  };

  // D42: admin creates a department without leaving the form, and it becomes the selected one.
  const createDepartment = async () => {
    const name = newDeptName.trim();
    if (!name) { setDeptError("Enter a department name."); return; }
    if (deptInFlight.current) return;

    deptInFlight.current = true;
    setDeptSaving(true);
    setDeptError("");
    try {
      await addDepartment({ name, description: "", status: "Active" });
      setForm(p => ({ ...p, dept: name, teamLeadId: "" }));
      resetDepartmentCreation();
    } catch (error) {
      setDeptError(createDepartmentMessage(error, name));
    } finally {
      deptInFlight.current = false;
      setDeptSaving(false);
    }
  };

  // D41: admin or hr give an existing employee a new temporary password.
  const openReset = (emp) => {
    const employeeDocumentId = canonicalEmployeeDocumentId(emp);
    if (!employeeDocumentId) {
      setNotice({
        type: "warning",
        message: "This employee's password cannot be reset because its canonical identifier is unavailable.",
      });
      return;
    }
    setResetError("");
    setResetPassword("");
    setResetTarget({ id: employeeDocumentId, name: emp.name });
  };

  const closeReset = () => {
    if (resetting) return;
    setResetTarget(null);
    setResetPassword("");
    setResetError("");
  };

  const submitReset = async () => {
    if (resetInFlight.current || !resetTarget) return;
    if (!isValidTemporaryPassword(resetPassword)) { setResetError(TEMPORARY_PASSWORD_MESSAGE); return; }

    resetInFlight.current = true;
    setResetting(true);
    setResetError("");
    try {
      await resetEmployeePassword(resetTarget.id, resetPassword);
      setNotice({
        type: "success",
        message: `Password reset for ${resetTarget.name || "the employee"}. Give them the temporary password yourself; they must choose their own the next time they sign in, and their current sessions have ended.`,
      });
      setResetTarget(null);
      setResetPassword("");
    } catch (error) {
      setResetError(error instanceof EmployeeInvitationError
        ? error.message
        : "The password could not be reset. Please try again.");
    } finally {
      resetInFlight.current = false;
      setResetting(false);
    }
  };

  const editableEmployeeProfile = () => {
    const role = String(form.role || "").trim().toLowerCase();
    const updates = {
      name: String(form.name || "").trim(),
      email: String(form.email || "").trim().toLowerCase(),
      phone: String(form.phone || "").trim(),
      dept: String(deptLocked ? user.dept : form.dept || "").trim(),
      pos: String(form.pos || "").trim(),
      joinDate: String(form.joinDate || "").trim(),
      role,
      status: String(form.status || "active").trim().toLowerCase(),
      teamLeadId: role === "employee"
        ? user.role === "tl" ? user.id : form.teamLeadId || null
        : null,
    };
    if (user.role === "admin" || user.role === "hr") {
      updates.basic = Number(form.basic);
      updates.allowances = Number(form.allowances);
    }
    return updates;
  };

  const invitationProfile = () => {
    const lockedDepartment = deptLocked ? user.dept : form.dept;
    const role = String(form.role || myAssignableRoles[0] || "employee").trim().toLowerCase();
    const status = String(form.status || "active").trim().toLowerCase();
    const profile = {
      name: String(form.name || "").trim(),
      email: String(form.email || "").trim().toLowerCase(),
      phone: String(form.phone || "").trim(),
      dept: String(lockedDepartment || "").trim(),
      pos: String(form.pos || "").trim(),
      basic: Number(form.basic || 0),
      allowances: Number(form.allowances || 0),
      joinDate: String(form.joinDate || "").trim(),
      role,
      status,
      // As typed: a password is never trimmed.
      temporaryPassword: String(form.temporaryPassword || ""),
    };
    const teamLeadId = user.role === "tl" ? user.id : form.teamLeadId;

    if (role === "employee" && teamLeadId != null && String(teamLeadId).trim()) {
      profile.teamLeadId = String(teamLeadId).trim();
    }

    return profile;
  };

  const finishInvitation = (nextNotice) => {
    setModal(null);
    setForm({});
    setFormError("");
    setNotice(nextNotice);
  };

  const save = async () => {
    if (saveInFlight.current) return;

    saveInFlight.current = true;
    setSaving(true);
    setFormError("");
    try {
      if (modal === "add") {
        const profile = invitationProfile();

        if (!isValidTemporaryPassword(profile.temporaryPassword)) {
          setFormError(TEMPORARY_PASSWORD_MESSAGE);
          return;
        }

        try {
          await inviteEmployee(profile);
        } catch (error) {
          const message = error instanceof EmployeeInvitationError
            ? error.message
            : "The employee could not be created.";
          setFormError(message);
          return;
        }

        finishInvitation(profile.status === "inactive"
          ? {
              type: "warning",
              message: "Inactive employee account created in a disabled state. It cannot sign in until the employee is made active.",
            }
          : {
              type: "success",
              message: `Employee account created. Give ${profile.name || "the employee"} the temporary password you set; they must choose their own the first time they sign in.`,
            });
        return;
      } else {
        if (!editEmployeeDocumentId) {
          setFormError("This employee record cannot be changed because its canonical identifier is unavailable.");
          return;
        }
        try {
          await updateEmployee(editEmployeeDocumentId, editableEmployeeProfile());
        } catch (error) {
          const message = error instanceof EmployeeMutationError
            ? error.message
            : "Employee changes could not be saved. Please try again.";
          setFormError(message);
          return;
        }
      }
      setModal(null);
      setEditEmployeeDocumentId(null);
      setNotice({ type: "success", message: "Employee changes saved successfully." });
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const del = async (employee) => {
    const employeeDocumentId = canonicalEmployeeDocumentId(employee);
    if (!employeeDocumentId) {
      setNotice({
        type: "warning",
        message: "This employee record cannot be removed because its canonical identifier is unavailable.",
      });
      return;
    }
    if (deleteInFlight.current.has(employeeDocumentId)) return;
    if (!window.confirm("Remove this employee?")) return;

    deleteInFlight.current.add(employeeDocumentId);
    setDeletingEmployeeDocumentId(employeeDocumentId);
    try {
      await deleteEmployee(employeeDocumentId);
      setNotice({ type: "success", message: "Employee removed successfully." });
    } catch (error) {
      const partialCleanup = error instanceof EmployeeMutationError
        && error.partialCleanup?.kind === "delete"
        && error.partialCleanup.accessRevoked === true;
      setNotice({
        type: "warning",
        message: partialCleanup
          ? "Employee access was revoked, but final account cleanup is still pending. Please retry the removal later."
          : error instanceof EmployeeMutationError
            ? error.message
            : "Employee removal could not be completed. Please try again.",
      });
    } finally {
      deleteInFlight.current.delete(employeeDocumentId);
      setDeletingEmployeeDocumentId((current) =>
        current === employeeDocumentId ? null : current);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  return (
    <div>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>Employees</div>
          <div style={{ fontSize: 12, color: T.muted }}>
            {scoped.filter(e => e.status === "active").length} active · {scoped.length} total
          </div>
        </div>
        {myAssignableRoles.length > 0 && <Btn onClick={openAdd}><Plus size={14} />Add Employee</Btn>}
      </div>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 16,
            padding: "12px 14px",
            borderRadius: 8,
            border: `1px solid ${notice.type === "success" ? T.success : T.warning}`,
            background: notice.type === "success" ? T.successGlow : T.warningTint,
            color: notice.type === "success" ? T.success : T.warning,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <span style={{ overflowWrap: "anywhere" }}>{notice.message}</span>
        </div>
      )}

      {/* ── Search + Department filter ──────────────────────────── */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>

        {/* Search */}
        <div style={{ position: "relative", flex: 1, minWidth: 200, maxWidth: 320 }}>
          <Search size={14} color={T.muted} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, dept, ID…"
            style={{ width: "100%", background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px 8px 32px", color: T.text, fontSize: 13, outline: "none" }}
          />
        </div>

        {/* Department filter dropdown ← new */}
        <select
          value={deptFilter}
          onChange={e => { setDeptFilter(e.target.value); }}
          style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px", color: deptFilter ? T.text : T.muted, fontSize: 13, outline: "none", minWidth: 190, cursor: "pointer" }}
        >
          <option value="">All Departments</option>
          {activeDepts.map(d => (
            <option key={d.id} value={d.name}>{d.name}</option>
          ))}
        </select>

        {/* Clear filter — only shown when active */}
        {deptFilter && (
          <button
            onClick={() => setDeptFilter("")}
            style={{ background: T.dangerGlow, border: "none", color: T.danger, padding: "8px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
          >
            Clear filter
          </button>
        )}
      </div>

      {/* ── Table ──────────────────────────────────────────────── */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {["Employee", "Dept", "Position", "Salary", "Status", "Role", "Action"].map(h => (
                  <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: 0.8, whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: "40px 16px", textAlign: "center", color: T.muted, fontSize: 13 }}>
                    No employees match your search.
                  </td>
                </tr>
              ) : filtered.map(emp => (
                <tr
                  key={emp.id}
                  style={{ borderBottom: `1px solid ${T.border}`, transition: "background .15s" }}
                  onMouseEnter={e => (e.currentTarget.style.background = T.cardHover)}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Avatar emp={emp} size={34} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{emp.name}</div>
                        <div style={{ fontSize: 11, color: T.muted }}>{emp.empId}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 13, color: T.mutedLight }}>{emp.dept}</td>
                  <td style={{ padding: "12px 16px", fontSize: 13, color: T.mutedLight }}>{emp.pos}</td>
                  <td style={{ padding: "12px 16px", fontSize: 13, color: T.text, fontWeight: 600 }}>{fmt(emp.basic)}</td>
                  <td style={{ padding: "12px 16px" }}><Badge s={emp.status} /></td>
                  <td style={{ padding: "12px 16px" }}><Badge s={emp.role}   /></td>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => setViewEmp(emp)} style={{ background: T.primaryGlow, border: "none", color: T.primary, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}><Eye    size={13} /></button>
                      {(user.role === "admin" || user.role === "hr" || canManageEmployee(user, emp)) && (
                        <button
                          onClick={() => openEdit(emp)}
                          aria-label={`Edit ${emp.name || "employee"}`}
                          title={canonicalEmployeeDocumentId(emp)
                            ? "Edit employee"
                            : "Canonical employee identifier unavailable"}
                          style={{ background: T.warningTint, border: "none", color: T.warning, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}
                        ><Edit size={13} /></button>
                      )}
                      {canResetPassword(user, emp) && (
                        <button
                          onClick={() => openReset(emp)}
                          aria-label={`Reset password for ${emp.name || "employee"}`}
                          title="Reset password"
                          style={{ background: T.primaryGlow, border: "none", color: T.primary, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}
                        ><KeyRound size={13} /></button>
                      )}
                      {(user.role === "admin" || user.role === "hr") && (
                        <button
                          onClick={() => del(emp)}
                          disabled={deletingEmployeeDocumentId === canonicalEmployeeDocumentId(emp)}
                          aria-label={`Delete ${emp.name || "employee"}`}
                          title={canonicalEmployeeDocumentId(emp)
                            ? "Delete employee"
                            : "Canonical employee identifier unavailable"}
                          style={{ background: T.dangerGlow, border: "none", color: T.danger, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}
                        ><Trash2 size={13} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Add / Edit Modal ─────────────────────────────────────── */}
      {(modal === "add" || modal === "edit") && (
        <Modal title={modal === "add" ? "Add Employee" : "Edit Employee"} onClose={closeModal} wide>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Input label="Full Name"    value={form.name       || ""} onChange={e => setForm(p => ({ ...p, name:       e.target.value }))} disabled={saving} />
            <Input label="Email"        value={form.email      || ""} onChange={e => setForm(p => ({ ...p, email:      e.target.value }))} type="email" disabled={saving} />
            <Input label="Phone"        value={form.phone      || ""} onChange={e => setForm(p => ({ ...p, phone:      e.target.value }))} disabled={saving} />

            {/* Department (D42): admin can also create one here; HR sees a hint; manager/TL are locked to their own. */}
            <div>
              <Select
                label="Department"
                value={deptLocked ? (deptChoices.options[0]?.value ?? "") : creatingDept ? CREATE_DEPARTMENT_VALUE : form.dept || ""}
                onChange={e => {
                  if (e.target.value === CREATE_DEPARTMENT_VALUE) { setCreatingDept(true); setDeptError(""); return; }
                  setCreatingDept(false);
                  setForm(p => ({ ...p, dept: e.target.value, teamLeadId: "" }));
                }}
                disabled={deptLocked || saving}
                hint={deptChoices.hint || undefined}
              >
                {!deptLocked && <option value="">— Select Department —</option>}
                {deptChoices.options.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
                {modal === "add" && deptChoices.canCreate && (
                  <option value={CREATE_DEPARTMENT_VALUE}>+ Create department…</option>
                )}
              </Select>
              {modal === "add" && deptChoices.canCreate && creatingDept && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <Input
                      label="New department name"
                      value={newDeptName}
                      onChange={e => { setNewDeptName(e.target.value); setDeptError(""); }}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); createDepartment(); } }}
                      error={deptError || undefined}
                      disabled={saving || deptSaving}
                      autoFocus
                    />
                  </div>
                  <div style={{ display: "flex", gap: 6, paddingTop: 22 }}>
                    <Btn sm onClick={createDepartment} disabled={saving || deptSaving}>
                      {deptSaving ? "Creating…" : "Create"}
                    </Btn>
                    <Btn sm variant="ghost" onClick={resetDepartmentCreation} disabled={deptSaving}>Cancel</Btn>
                  </div>
                </div>
              )}
            </div>

            <Input label="Position"     value={form.pos        || ""} onChange={e => setForm(p => ({ ...p, pos:        e.target.value }))} disabled={saving} />
            <Input label="Basic Salary" value={form.basic      || ""} onChange={e => setForm(p => ({ ...p, basic:      e.target.value }))} type="number" disabled={saving || (modal === "edit" && user.role !== "admin" && user.role !== "hr")} />
            <Input label="Allowances"   value={form.allowances || ""} onChange={e => setForm(p => ({ ...p, allowances: e.target.value }))} type="number" disabled={saving || (modal === "edit" && user.role !== "admin" && user.role !== "hr")} />
            <Input label="Join Date"    value={form.joinDate   || ""} onChange={e => setForm(p => ({ ...p, joinDate:   e.target.value }))} type="date" disabled={saving} />
            {/* Role choices depend on who's creating/editing — a manager can
                only make Team Leads, a TL can only add Employees, etc. */}
            <Select
              label="Role"
              value={form.role || myAssignableRoles[0] || "employee"}
              onChange={e => setForm(p => modal === "add"
                ? {
                    ...p,
                    role: e.target.value,
                    ...(e.target.value === "employee" ? {} : { teamLeadId: "" }),
                  }
                : { ...p, role: e.target.value })}
              disabled={saving}
            >
              {myAssignableRoles.map(r => (
                <option key={r} value={r}>{r === "hr" ? "HR" : r === "tl" ? "Team Lead" : r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </Select>
            <Select label="Status" value={form.status || "active"} onChange={e => setForm(p => ({ ...p, status: e.target.value }))} disabled={saving}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
            {modal === "add" && (
              <Input
                label="Temporary password"
                value={form.temporaryPassword || ""}
                onChange={e => setForm(p => ({ ...p, temporaryPassword: e.target.value }))}
                autoComplete="off"
                hint="8 to 200 characters. Tell the employee yourself; they must replace it at first sign-in."
                disabled={saving}
              />
            )}
            {modal === "add" && form.role === "employee" && user.role !== "tl" && (
              <Select
                label="Team Lead (optional)"
                value={form.teamLeadId || ""}
                onChange={e => setForm(p => ({ ...p, teamLeadId: e.target.value }))}
                disabled={saving || !form.dept}
              >
                <option value="">— No Team Lead —</option>
                {teamLeadOptions.map(teamLead => (
                  <option key={teamLead.id} value={String(teamLead.id)}>{teamLead.name}</option>
                ))}
              </Select>
            )}
          </div>
          {formError && (
            <div
              role="alert"
              style={{
                marginTop: 8,
                padding: "10px 12px",
                borderRadius: 8,
                background: T.dangerGlow,
                color: T.danger,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {formError}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Btn variant="ghost" onClick={closeModal} disabled={saving}>Cancel</Btn>
            <Btn onClick={save} disabled={saving}>
              <Check size={13} />
              {saving
                ? modal === "add" ? "Creating…" : "Saving…"
                : modal === "add" ? "Create Employee" : "Save Changes"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── Reset password modal (D41) ──────────────────────────── */}
      {resetTarget && (
        <Modal title="Reset Password" onClose={closeReset}>
          <div style={{ fontSize: 13, color: T.mutedLight, lineHeight: 1.5, marginBottom: 12 }}>
            Set a new temporary password for <strong style={{ color: T.text }}>{resetTarget.name}</strong>. Their
            current sessions end, and they must choose their own password the next time they sign in.
          </div>
          <Input
            label="Temporary password"
            value={resetPassword}
            onChange={e => { setResetPassword(e.target.value); setResetError(""); }}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submitReset(); } }}
            autoComplete="off"
            hint="8 to 200 characters. Tell the employee yourself."
            disabled={resetting}
            autoFocus
          />
          {resetError && (
            <div
              role="alert"
              style={{
                marginTop: 8,
                padding: "10px 12px",
                borderRadius: 8,
                background: T.dangerGlow,
                color: T.danger,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {resetError}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Btn variant="ghost" onClick={closeReset} disabled={resetting}>Cancel</Btn>
            <Btn onClick={submitReset} disabled={resetting}>
              <KeyRound size={13} />
              {resetting ? "Resetting…" : "Reset password"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── View Modal ───────────────────────────────────────────── */}
      {viewEmp && (
        <Modal title="Employee Profile" onClose={() => setViewEmp(null)}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <Avatar emp={viewEmp} size={64} />
            <div style={{ fontSize: 18, fontWeight: 800, color: T.text, marginTop: 10 }}>{viewEmp.name}</div>
            <div style={{ fontSize: 12, color: T.muted }}>{viewEmp.empId}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, justifyContent: "center" }}>
              <Badge s={viewEmp.status} /><Badge s={viewEmp.role} />
            </div>
          </div>
          {[
            ["Department",   viewEmp.dept],
            ["Position",     viewEmp.pos],
            ["Email",        viewEmp.email],
            ["Phone",        viewEmp.phone],
            ["Basic Salary", fmt(viewEmp.basic)],
            ["Allowances",   fmt(viewEmp.allowances)],
            ["Join Date",    fdate(viewEmp.joinDate)],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 12, color: T.muted, fontWeight: 600 }}>{k}</span>
              <span style={{ fontSize: 13, color: T.text,  fontWeight: 500 }}>{v}</span>
            </div>
          ))}
        </Modal>
      )}

    </div>
  );
};

export default EmployeesPage;
