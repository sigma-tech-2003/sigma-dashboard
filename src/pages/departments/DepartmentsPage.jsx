// src/pages/departments/DepartmentsPage.jsx

import { useState } from "react";
import { Plus, Search, Edit, Trash2, Eye, Check, Building2 } from "lucide-react";

import { T }      from "../../theme/theme";
import { fdate }  from "../../utils/helpers";
import Badge      from "../../components/badge/Badge";
import Avatar     from "../../components/avatar/Avatar";
import Modal      from "../../components/modal/Modal";
import Input      from "../../components/input/Input";
import Select     from "../../components/select/Select";
import Btn        from "../../components/btn/Btn";

const DepartmentsPage = ({
  user,
  departments,
  employees,
  addDepartment,
  updateDepartment,
  deleteDepartment,
}) => {
  const [search,    setSearch]    = useState("");
  const [modal,     setModal]     = useState(null);   // "add" | "edit" | "view" | null
  const [selected,  setSelected]  = useState(null);
  const [form,      setForm]      = useState({});
  const [saving,    setSaving]    = useState(false);
  const [deleteErr, setDeleteErr] = useState("");

  const isAdmin = user.role === "admin";

  // ── Helpers ──────────────────────────────────────────────────────
  const empCount  = (deptName) => employees.filter(e => e.dept === deptName).length;
  const getManager = (managerId) =>
    employees.find(e => String(e.id) === String(managerId));

  // Pre-compute for view modal (safe when selected is null)
  const viewManager  = selected ? getManager(selected.managerId) : null;
  const viewDeptEmps = selected ? employees.filter(e => e.dept === selected.name) : [];

  // ── Filtered list ─────────────────────────────────────────────────
  const filtered = departments.filter(d =>
    (d.name        || "").toLowerCase().includes(search.toLowerCase()) ||
    (d.description || "").toLowerCase().includes(search.toLowerCase())
  );

  // ── Handlers ─────────────────────────────────────────────────────
  const openAdd  = ()     => { setForm({ status: "Active" }); setDeleteErr(""); setModal("add");  };
  const openEdit = (dept) => { setForm({ ...dept });           setDeleteErr(""); setModal("edit"); };
  const openView = (dept) => { setSelected(dept);                                setModal("view"); };

  const save = async () => {
    if (!form.name?.trim()) return;
    setSaving(true);
    try {
      modal === "add"
        ? await addDepartment(form)
        : await updateDepartment(form.id, form);
      setModal(null);
    } finally {
      setSaving(false);
    }
  };

  const del = async (dept) => {
    const count = empCount(dept.name);
    if (count > 0) {
      setDeleteErr(
        `"${dept.name}" cannot be deleted — ${count} employee${count > 1 ? "s are" : " is"} still assigned. Move them to another department first.`
      );
      return;
    }
    if (window.confirm(`Delete department "${dept.name}"?`)) {
      await deleteDepartment(dept.id);
      setDeleteErr("");
    }
  };

  // ─────────────────────────────────────────────────────────────────
  return (
    <div>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>Departments</div>
          <div style={{ fontSize: 12, color: T.muted }}>
            {departments.filter(d => d.status === "Active").length} active · {departments.length} total
          </div>
        </div>
        {isAdmin && (
          <Btn onClick={openAdd}><Plus size={14} />Add Department</Btn>
        )}
      </div>

      {/* ── Delete error banner ─────────────────────────────────── */}
      {deleteErr && (
        <div style={{ background: T.dangerGlow, border: `1px solid ${T.danger}30`, color: T.danger, borderRadius: 10, padding: "10px 16px", marginBottom: 16, fontSize: 13 }}>
          {deleteErr}
        </div>
      )}

      {/* ── Search ─────────────────────────────────────────────── */}
      <div style={{ position: "relative", marginBottom: 16, maxWidth: 320 }}>
        <Search size={14} color={T.muted} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search departments…"
          style={{ width: "100%", background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px 8px 32px", color: T.text, fontSize: 13, outline: "none" }}
        />
      </div>

      {/* ── Table ──────────────────────────────────────────────── */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {["Department Name", "Manager", "Total Employees", "Status", "Actions"].map(h => (
                  <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: 0.8, whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: "40px 16px", textAlign: "center", color: T.muted, fontSize: 13 }}>
                    {departments.length === 0
                      ? "No departments yet. Click \"Add Department\" to create one."
                      : "No departments match your search."}
                  </td>
                </tr>
              ) : filtered.map(dept => {
                const mgr   = getManager(dept.managerId);
                const count = empCount(dept.name);
                return (
                  <tr
                    key={dept.id}
                    style={{ borderBottom: `1px solid ${T.border}`, transition: "background .15s" }}
                    onMouseEnter={e => (e.currentTarget.style.background = T.cardHover)}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    {/* Name + icon */}
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 10, background: `${T.primary}20`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          <Building2 size={15} color={T.primary} />
                        </div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{dept.name}</div>
                          <div style={{ fontSize: 11, color: T.muted, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dept.description || "—"}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Manager */}
                    <td style={{ padding: "12px 16px" }}>
                      {mgr ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <Avatar emp={mgr} size={26} />
                          <span style={{ fontSize: 13, color: T.mutedLight }}>{mgr.name}</span>
                        </div>
                      ) : (
                        <span style={{ fontSize: 13, color: T.muted }}>—</span>
                      )}
                    </td>

                    {/* Count */}
                    <td style={{ padding: "12px 16px" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{count}</span>
                      <span style={{ fontSize: 11, color: T.muted, marginLeft: 4 }}>
                        {count === 1 ? "employee" : "employees"}
                      </span>
                    </td>

                    {/* Status */}
                    <td style={{ padding: "12px 16px" }}>
                      <Badge s={dept.status === "Active" ? "active" : "inactive"} />
                    </td>

                    {/* Actions */}
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => openView(dept)}
                          style={{ background: T.primaryGlow, border: "none", color: T.primary, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}
                        >
                          <Eye size={13} />
                        </button>
                        {isAdmin && (
                          <>
                            <button
                              onClick={() => openEdit(dept)}
                              style={{ background: "#f0a50015", border: "none", color: T.warning, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}
                            >
                              <Edit size={13} />
                            </button>
                            <button
                              onClick={() => del(dept)}
                              style={{ background: T.dangerGlow, border: "none", color: T.danger, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
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

      {/* ── Add / Edit Modal ─────────────────────────────────────── */}
      {(modal === "add" || modal === "edit") && (
        <Modal
          title={modal === "add" ? "Add Department" : "Edit Department"}
          onClose={() => setModal(null)}
          wide
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Input
              label="Department Name"
              value={form.name || ""}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            />
            <Select
              label="Manager"
              value={String(form.managerId || "")}
              onChange={e => setForm(p => ({ ...p, managerId: e.target.value }))}
            >
              <option value="">— Select Manager —</option>
              {employees
                .filter(e => e.status === "active")
                .map(e => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.pos}
                  </option>
                ))}
            </Select>
          </div>

          {/* Description — full width */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, color: "#5a7499", marginBottom: 6, fontWeight: 600 }}>
              Description
            </label>
            <textarea
              value={form.description || ""}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              rows={3}
              placeholder="Brief description of this department…"
              style={{ width: "100%", background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "9px 12px", color: T.text, fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }}
            />
          </div>

          <Select
            label="Status"
            value={form.status || "Active"}
            onChange={e => setForm(p => ({ ...p, status: e.target.value }))}
          >
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </Select>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Btn variant="ghost" onClick={() => setModal(null)}>Cancel</Btn>
            <Btn onClick={save} disabled={saving || !form.name?.trim()}>
              <Check size={13} />
              {saving ? "Saving…" : modal === "add" ? "Add Department" : "Save Changes"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── View Modal ───────────────────────────────────────────── */}
      {modal === "view" && selected && (
        <Modal title="Department Details" onClose={() => setModal(null)} wide>

          {/* Header */}
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: `${T.primary}20`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
              <Building2 size={24} color={T.primary} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.text }}>{selected.name}</div>
            {selected.description && (
              <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>{selected.description}</div>
            )}
            <div style={{ marginTop: 8 }}>
              <Badge s={selected.status === "Active" ? "active" : "inactive"} />
            </div>
          </div>

          {/* Details rows */}
          {[
            ["Manager",         viewManager?.name || "—"],
            ["Total Employees", `${viewDeptEmps.length} employee${viewDeptEmps.length !== 1 ? "s" : ""}`],
            ["Status",          selected.status],
            ["Created Date",    fdate(selected.createdAt)],
          ].map(([k, v]) => (
            <div
              key={k}
              style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${T.border}` }}
            >
              <span style={{ fontSize: 12, color: T.muted,  fontWeight: 600 }}>{k}</span>
              <span style={{ fontSize: 13, color: T.text,   fontWeight: 500 }}>{v}</span>
            </div>
          ))}

          {/* Employee list */}
          {viewDeptEmps.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 12 }}>
                Employees ({viewDeptEmps.length})
              </div>
              {viewDeptEmps.map(emp => (
                <div
                  key={emp.id}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}
                >
                  <Avatar emp={emp} size={34} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{emp.name}</div>
                    <div style={{ fontSize: 11, color: T.muted }}>{emp.pos}</div>
                  </div>
                  <Badge s={emp.status} />
                </div>
              ))}
            </div>
          )}

          {viewDeptEmps.length === 0 && (
            <div style={{ marginTop: 20, textAlign: "center", color: T.muted, fontSize: 13, padding: "20px 0" }}>
              No employees assigned to this department yet.
            </div>
          )}
        </Modal>
      )}

    </div>
  );
};

export default DepartmentsPage;
