// src/pages/employees/EmployeesPage.jsx

import { useRef, useState } from "react";
import { Plus, Pencil, Trash2, Check, Eye, KeyRound, Users, SearchX } from "lucide-react";

import "./Employees.css";
import { T }        from "../../theme/theme";
import { fmt, fdate } from "../../utils/helpers";
import { scopeEmployees, assignableRoles, canManageEmployee } from "../../utils/permissions";
import Badge   from "../../components/badge/Badge";
import { resolveBadge } from "../../components/badge/badgeStatuses";
import Avatar  from "../../components/avatar/Avatar";
import PersonCell from "../../components/person-cell/PersonCell";
import PageHeader from "../../components/page-header/PageHeader";
import SearchBar from "../../components/search-bar/SearchBar";
import FilterBar from "../../components/filter-bar/FilterBar";
import DataTable from "../../components/data-table/DataTable";
import EmptyState from "../../components/empty-state/EmptyState";
import IconButton from "../../components/icon-button/IconButton";
import DetailList from "../../components/detail-list/DetailList";
import ConfirmDialog from "../../components/confirm-dialog/ConfirmDialog";
import FormFeedback from "../../components/form-feedback/FormFeedback";
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
  const [deleteTarget, setDeleteTarget] = useState(null);   // the employee awaiting "Remove?" confirmation
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

  const addButton = <Btn onClick={openAdd}><Plus size={16} aria-hidden="true" />Add employee</Btn>;
  const emptyState = scoped.length === 0 ? (
    <EmptyState
      icon={Users}
      title="No employees yet"
      description={myAssignableRoles.length > 0 ? "Add your first employee to start building the team. They will sign in with the temporary password you set." : "Employees you can see will be listed here."}
    >
      {myAssignableRoles.length > 0 && addButton}
    </EmptyState>
  ) : filtered.length === 0 ? (
    <EmptyState icon={SearchX} title="No employees match" description="Nothing matches that search and department. Try different words or clear the filters.">
      <Btn variant="ghost" onClick={() => { setSearch(""); setDeptFilter(""); }}>Clear filters</Btn>
    </EmptyState>
  ) : null;
  const isHrOrAdmin = user.role === "admin" || user.role === "hr";

  // ─────────────────────────────────────────────────────────────────
  return (
    <div>
      <PageHeader
        title="Employees"
        description={`${scoped.filter(e => e.status === "active").length} active · ${scoped.length} total`}
        actions={myAssignableRoles.length > 0 ? addButton : null}
      />

      {notice && (
        <div style={{ marginBottom: 16 }}>
          <FormFeedback status={notice.type === "success" ? "success" : "warning"}>{notice.message}</FormFeedback>
        </div>
      )}

      {/* ── Search + Department filter ──────────────────────────── */}
      <FilterBar>
        <SearchBar value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, department or ID…" />
        <select
          className="select-field employees-filter"
          aria-label="Filter by department"
          value={deptFilter}
          onChange={e => { setDeptFilter(e.target.value); }}
        >
          <option value="">All departments</option>
          {activeDepts.map(d => (
            <option key={d.id} value={d.name}>{d.name}</option>
          ))}
        </select>
        {deptFilter && <Btn variant="ghost" onClick={() => setDeptFilter("")}>Clear filter</Btn>}
      </FilterBar>

      {/* ── Table ──────────────────────────────────────────────── */}
      <DataTable label="Employees" empty={emptyState}>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Department</th>
            <th>Position</th>
            <th className="cell-number">Salary</th>
            <th>Status</th>
            <th>Role</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(emp => (
            <tr key={emp.id}>
              <td data-primary><PersonCell emp={emp} sub={emp.empId} /></td>
              <td data-label="Department" style={{ color: T.mutedLight }}>{emp.dept}</td>
              <td data-label="Position" style={{ color: T.mutedLight }}>{emp.pos}</td>
              <td data-label="Salary" className="cell-number">{fmt(emp.basic)}</td>
              <td data-label="Status"><Badge s={emp.status} /></td>
              <td data-label="Role"><Badge s={emp.role} /></td>
              <td className="cell-actions">
                <div className="row-actions">
                  <IconButton icon={Eye} label={`View ${emp.name || "employee"}`} onClick={() => setViewEmp(emp)} />
                  {(isHrOrAdmin || canManageEmployee(user, emp)) && (
                    <IconButton
                      icon={Pencil}
                      label={`Edit ${emp.name || "employee"}`}
                      disabled={!canonicalEmployeeDocumentId(emp)}
                      onClick={() => openEdit(emp)}
                    />
                  )}
                  {canResetPassword(user, emp) && (
                    <IconButton icon={KeyRound} label={`Reset password for ${emp.name || "employee"}`} onClick={() => openReset(emp)} />
                  )}
                  {isHrOrAdmin && (
                    <IconButton
                      icon={Trash2}
                      variant="danger"
                      label={`Delete ${emp.name || "employee"}`}
                      disabled={deletingEmployeeDocumentId === canonicalEmployeeDocumentId(emp) || !canonicalEmployeeDocumentId(emp)}
                      onClick={() => setDeleteTarget(emp)}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      {deleteTarget && (
        <ConfirmDialog
          title="Remove this employee?"
          message={`${deleteTarget.name || "This employee"} will lose access and be removed from the directory. This cannot be undone.`}
          confirmLabel="Remove employee"
          onConfirm={() => { const target = deleteTarget; setDeleteTarget(null); del(target); }}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {/* ── Add / Edit Modal ─────────────────────────────────────── */}
      {(modal === "add" || modal === "edit") && (
        <Modal title={modal === "add" ? "Add employee" : "Edit employee"} onClose={closeModal} wide>
          <div className="form-grid">
            <Input label="Full name"    value={form.name       || ""} onChange={e => setForm(p => ({ ...p, name:       e.target.value }))} disabled={saving} />
            <Input label="Email"        value={form.email      || ""} onChange={e => setForm(p => ({ ...p, email:      e.target.value }))} type="email" disabled={saving} />
            <Input label="Phone"        value={form.phone      || ""} onChange={e => setForm(p => ({ ...p, phone:      e.target.value }))} type="tel" disabled={saving} />

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
                {!deptLocked && <option value="">Select a department</option>}
                {deptChoices.options.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
                {modal === "add" && deptChoices.canCreate && (
                  <option value={CREATE_DEPARTMENT_VALUE}>Create a new department…</option>
                )}
              </Select>
              {modal === "add" && deptChoices.canCreate && creatingDept && (
                <div className="inline-create">
                  <Input
                    className="inline-create__field"
                    label="New department name"
                    value={newDeptName}
                    onChange={e => { setNewDeptName(e.target.value); setDeptError(""); }}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); createDepartment(); } }}
                    error={deptError || undefined}
                    disabled={saving || deptSaving}
                    autoFocus
                  />
                  <div className="inline-create__actions">
                    <Btn sm onClick={createDepartment} disabled={saving || deptSaving}>
                      {deptSaving ? "Creating…" : "Create"}
                    </Btn>
                    <Btn sm variant="ghost" onClick={resetDepartmentCreation} disabled={deptSaving}>Cancel</Btn>
                  </div>
                </div>
              )}
            </div>

            <Input label="Position"     value={form.pos        || ""} onChange={e => setForm(p => ({ ...p, pos:        e.target.value }))} disabled={saving} />
            <Input label="Basic salary" value={form.basic      || ""} onChange={e => setForm(p => ({ ...p, basic:      e.target.value }))} type="number" inputMode="numeric" disabled={saving || (modal === "edit" && user.role !== "admin" && user.role !== "hr")} />
            <Input label="Allowances"   value={form.allowances || ""} onChange={e => setForm(p => ({ ...p, allowances: e.target.value }))} type="number" inputMode="numeric" disabled={saving || (modal === "edit" && user.role !== "admin" && user.role !== "hr")} />
            <Input label="Join date"    value={form.joinDate   || ""} onChange={e => setForm(p => ({ ...p, joinDate:   e.target.value }))} type="date" disabled={saving} />
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
                <option key={r} value={r}>{resolveBadge(r).label}</option>
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
                label="Team lead (optional)"
                value={form.teamLeadId || ""}
                onChange={e => setForm(p => ({ ...p, teamLeadId: e.target.value }))}
                disabled={saving || !form.dept}
              >
                <option value="">No team lead</option>
                {teamLeadOptions.map(teamLead => (
                  <option key={teamLead.id} value={String(teamLead.id)}>{teamLead.name}</option>
                ))}
              </Select>
            )}
          </div>
          <FormFeedback>{formError}</FormFeedback>
          <div className="modal-actions">
            <Btn variant="ghost" onClick={closeModal} disabled={saving}>Cancel</Btn>
            <Btn onClick={save} disabled={saving}>
              <Check size={16} aria-hidden="true" />
              {saving
                ? modal === "add" ? "Creating…" : "Saving…"
                : modal === "add" ? "Create employee" : "Save changes"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── Reset password modal (D41) ──────────────────────────── */}
      {resetTarget && (
        <Modal title="Reset password" onClose={closeReset}>
          <p className="employees-lede">
            Set a new temporary password for <strong>{resetTarget.name}</strong>. Their
            current sessions end, and they must choose their own password the next time they sign in.
          </p>
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
          <FormFeedback>{resetError}</FormFeedback>
          <div className="modal-actions">
            <Btn variant="ghost" onClick={closeReset} disabled={resetting}>Cancel</Btn>
            <Btn onClick={submitReset} disabled={resetting}>
              <KeyRound size={16} aria-hidden="true" />
              {resetting ? "Resetting…" : "Reset password"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── View Modal ───────────────────────────────────────────── */}
      {viewEmp && (
        <Modal title="Employee profile" onClose={() => setViewEmp(null)}>
          <div className="employees-hero">
            <Avatar emp={viewEmp} size={64} />
            <div className="employees-hero__name">{viewEmp.name}</div>
            <div className="employees-hero__id">{viewEmp.empId}</div>
            <div className="employees-hero__badges">
              <Badge s={viewEmp.status} /><Badge s={viewEmp.role} />
            </div>
          </div>
          <DetailList items={[
            ["Department",   viewEmp.dept],
            ["Position",     viewEmp.pos],
            ["Email",        viewEmp.email],
            ["Phone",        viewEmp.phone],
            ["Basic salary", fmt(viewEmp.basic)],
            ["Allowances",   fmt(viewEmp.allowances)],
            ["Joined",       fdate(viewEmp.joinDate)],
          ]} />
        </Modal>
      )}
    </div>
  );
};

export default EmployeesPage;
