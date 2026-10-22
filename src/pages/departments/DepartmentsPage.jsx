// src/pages/departments/DepartmentsPage.jsx

import { useState } from "react";
import { Plus, Pencil, Trash2, Eye, Check, Building2, SearchX } from "lucide-react";

import "./Departments.css";
import { T } from "../../theme/theme";
import { fdate }  from "../../utils/helpers";
import Badge      from "../../components/badge/Badge";
import PersonCell from "../../components/person-cell/PersonCell";
import PageHeader from "../../components/page-header/PageHeader";
import SearchBar  from "../../components/search-bar/SearchBar";
import FilterBar  from "../../components/filter-bar/FilterBar";
import DataTable  from "../../components/data-table/DataTable";
import EmptyState from "../../components/empty-state/EmptyState";
import IconButton from "../../components/icon-button/IconButton";
import DetailList from "../../components/detail-list/DetailList";
import ConfirmDialog from "../../components/confirm-dialog/ConfirmDialog";
import Modal      from "../../components/modal/Modal";
import Input      from "../../components/input/Input";
import Select     from "../../components/select/Select";
import Textarea   from "../../components/textarea/Textarea";
import Btn        from "../../components/btn/Btn";
import FormFeedback from "../../components/form-feedback/FormFeedback";
import { guardedSave } from "../../utils/saveErrors";
import { useToast } from "../../components/toast/toastContext";

const DepartmentsPage = ({
  user,
  departments,
  employees,
  addDepartment,
  updateDepartment,
  deleteDepartment,
}) => {
  const toast = useToast();
  const [search,    setSearch]    = useState("");
  const [modal,     setModal]     = useState(null);   // "add" | "edit" | "view" | null
  const [selected,  setSelected]  = useState(null);
  const [form,      setForm]      = useState({});
  const [saving,    setSaving]    = useState(false);
  const [deleteErr, setDeleteErr] = useState("");
  const [saveError, setSaveError] = useState("");
  const [deleting,  setDeleting]  = useState(null);   // the department awaiting "Delete?" confirmation

  const isAdmin = user.role === "admin";

  // ── Helpers ──────────────────────────────────────────────────────
  const empCount  = (deptName) => employees.filter(e => e.dept === deptName).length;
  const getManager = (managerId) =>
    employees.find(e => String(e.id) === String(managerId));

  // Pre-compute for view modal (safe when selected is null)
  const viewManager  = selected ? getManager(selected.managerId) : null;
  const viewDeptEmps = selected ? employees.filter(e => e.dept === selected.name) : [];

  // A department's manager must already work in it (the API refuses anyone else), so only its own people are offered.
  // A new department has nobody yet; a manager is chosen once someone works in it.
  const editedDepartmentName = departments.find(d => String(d.id) === String(form.id))?.name;
  const managerChoices = modal === "edit"
    ? employees.filter(e => e.status === "active" && e.dept === editedDepartmentName)
    : [];

  // ── Filtered list ─────────────────────────────────────────────────
  const filtered = departments.filter(d =>
    (d.name        || "").toLowerCase().includes(search.toLowerCase()) ||
    (d.description || "").toLowerCase().includes(search.toLowerCase())
  );

  // ── Handlers ─────────────────────────────────────────────────────
  const openAdd  = ()     => { setForm({ status: "Active" }); setDeleteErr(""); setSaveError(""); setModal("add");  };
  const openEdit = (dept) => { setForm({ ...dept });           setDeleteErr(""); setSaveError(""); setModal("edit"); };
  const openView = (dept) => { setSelected(dept);                                setModal("view"); };

  // A failed save keeps the form open and says why; it never looks as if it worked.
  const save = async () => {
    if (!form.name?.trim() || saving) return;
    setSaving(true);
    setSaveError("");
    const result = await guardedSave(
      () => (modal === "add" ? addDepartment(form) : updateDepartment(form.id, form)),
      { fallback: "The department could not be saved. Please try again." },
    );
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    setModal(null);
    toast.success(modal === "add" ? "Department added" : "Department saved");
  };

  // Deleting asks first, in a dialog. A department that still has people cannot be deleted, so that is said up front.
  const requestDelete = (dept) => {
    const count = empCount(dept.name);
    if (count > 0) {
      setDeleteErr(
        `"${dept.name}" cannot be deleted — ${count} employee${count > 1 ? "s are" : " is"} still assigned. Move them to another department first.`
      );
      return;
    }
    setDeleteErr("");
    setDeleting(dept);
  };

  const del = async () => {
    const dept = deleting;
    if (!dept) return;
    setDeleting(null);
    const result = await guardedSave(() => deleteDepartment(dept.id), { fallback: `"${dept.name}" could not be deleted. Please try again.` });
    setDeleteErr(result.ok ? "" : result.message);
    if (result.ok) toast.success("Department deleted");
  };

  const addButton = <Btn onClick={openAdd}><Plus size={16} aria-hidden="true" />Add department</Btn>;
  const emptyState = departments.length === 0 ? (
    <EmptyState
      icon={Building2}
      title="No departments yet"
      description={isAdmin ? "Departments group your people and give each team a manager. Add the first one to get started." : "Departments will be listed here once an administrator creates them."}
    >
      {isAdmin && addButton}
    </EmptyState>
  ) : filtered.length === 0 ? (
    <EmptyState icon={SearchX} title="No departments match your search" description={`Nothing matches "${search}". Check the spelling or clear the search.`}>
      <Btn variant="ghost" onClick={() => setSearch("")}>Clear search</Btn>
    </EmptyState>
  ) : null;

  // ─────────────────────────────────────────────────────────────────
  return (
    <div>
      <PageHeader
        title="Departments"
        description={`${departments.filter(d => d.status === "Active").length} active · ${departments.length} total`}
        actions={isAdmin ? addButton : null}
      />

      {deleteErr && <div style={{ marginBottom: 16 }}><FormFeedback>{deleteErr}</FormFeedback></div>}

      <FilterBar>
        <SearchBar value={search} onChange={e => setSearch(e.target.value)} placeholder="Search departments…" />
      </FilterBar>

      <DataTable label="Departments" empty={emptyState}>
        <thead>
          <tr>
            <th>Department</th>
            <th>Manager</th>
            <th>People</th>
            <th>Status</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(dept => {
            const mgr   = getManager(dept.managerId);
            const count = empCount(dept.name);
            return (
              <tr key={dept.id}>
                <td data-primary>
                  <div className="dept-name">
                    <span className="dept-icon"><Building2 size={16} color={T.primaryText} aria-hidden="true" /></span>
                    <div className="dept-name__text">
                      <span style={{ fontWeight: 500 }}>{dept.name}</span>
                      {dept.description && <span className="cell-sub cell-truncate">{dept.description}</span>}
                    </div>
                  </div>
                </td>
                <td data-label="Manager">{mgr ? <PersonCell emp={mgr} size={28} /> : <span style={{ color: T.muted }}>—</span>}</td>
                <td data-label="People" className="cell-number">{count} {count === 1 ? "employee" : "employees"}</td>
                <td data-label="Status"><Badge s={dept.status === "Active" ? "active" : "inactive"} /></td>
                <td className="cell-actions">
                  <div className="row-actions">
                    <IconButton icon={Eye} label={`View ${dept.name}`} onClick={() => openView(dept)} />
                    {isAdmin && (
                      <>
                        <IconButton icon={Pencil} label={`Edit ${dept.name}`} onClick={() => openEdit(dept)} />
                        <IconButton icon={Trash2} variant="danger" label={`Delete ${dept.name}`} onClick={() => requestDelete(dept)} />
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      {deleting && (
        <ConfirmDialog
          title="Delete this department?"
          message={`"${deleting.name}" will be removed. This cannot be undone.`}
          confirmLabel="Delete department"
          onConfirm={del}
          onClose={() => setDeleting(null)}
        />
      )}

      {/* ── Add / Edit Modal ─────────────────────────────────────── */}
      {(modal === "add" || modal === "edit") && (
        <Modal
          title={modal === "add" ? "Add department" : "Edit department"}
          onClose={() => setModal(null)}
          wide
        >
          <div className="form-grid">
            <Input
              label="Department name"
              value={form.name || ""}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            />
            <Select
              label="Manager"
              hint={modal === "add" ? "Add the department first; a manager is chosen once someone works in it." : undefined}
              value={String(form.managerId || "")}
              onChange={e => setForm(p => ({ ...p, managerId: e.target.value }))}
            >
              <option value="">No manager</option>
              {managerChoices
                .map(e => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.pos}
                  </option>
                ))}
            </Select>
            <Textarea
              className="form-grid__full"
              label="Description"
              value={form.description || ""}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              rows={3}
              placeholder="A short description of this department"
            />
            <Select
              label="Status"
              value={form.status || "Active"}
              onChange={e => setForm(p => ({ ...p, status: e.target.value }))}
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </Select>
          </div>

          <FormFeedback>{saveError}</FormFeedback>

          <div className="modal-actions">
            <Btn variant="ghost" onClick={() => setModal(null)}>Cancel</Btn>
            <Btn onClick={save} disabled={saving || !form.name?.trim()}>
              <Check size={16} aria-hidden="true" />
              {saving ? "Saving…" : modal === "add" ? "Add department" : "Save changes"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── View Modal ───────────────────────────────────────────── */}
      {modal === "view" && selected && (
        <Modal title="Department details" onClose={() => setModal(null)} wide>
          <div className="dept-hero">
            <span className="dept-icon dept-icon--lg"><Building2 size={24} color={T.primaryText} aria-hidden="true" /></span>
            <div className="dept-hero__name">{selected.name}</div>
            {selected.description && <div className="dept-hero__description">{selected.description}</div>}
            <Badge s={selected.status === "Active" ? "active" : "inactive"} />
          </div>

          <DetailList items={[
            ["Manager",       viewManager?.name || "—"],
            ["People",        `${viewDeptEmps.length} employee${viewDeptEmps.length !== 1 ? "s" : ""}`],
            ["Status",        selected.status],
            ["Created",       fdate(selected.createdAt)],
          ]} />

          {viewDeptEmps.length > 0 ? (
            <div className="dept-people">
              <div className="dept-people__title">People ({viewDeptEmps.length})</div>
              {viewDeptEmps.map(emp => (
                <div key={emp.id} className="dept-people__row">
                  <PersonCell emp={emp} sub={emp.pos} />
                  <Badge s={emp.status} />
                </div>
              ))}
            </div>
          ) : (
            <div className="dept-people__none">No employees are assigned to this department yet.</div>
          )}
        </Modal>
      )}
    </div>
  );
};

export default DepartmentsPage;
