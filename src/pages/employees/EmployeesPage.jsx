// src/pages/employees/EmployeesPage.jsx

import { useState } from "react";
import { Plus, Search, Edit, Trash2, Check, Eye } from "lucide-react";

import { T }        from "../../theme/theme";
import { fmt, fdate } from "../../utils/helpers";
import { scopeEmployees, assignableRoles, canManageEmployee } from "../../utils/permissions";
import Badge   from "../../components/badge/Badge";
import Avatar  from "../../components/avatar/Avatar";
import Modal   from "../../components/modal/Modal";
import Input   from "../../components/input/Input";
import Select  from "../../components/select/Select";
import Btn     from "../../components/btn/Btn";

const EmployeesPage = ({
  employees, addEmployee, updateEmployee, deleteEmployee,
  departments,  // ← new: for dropdown + filter
  user,
}) => {
  const [search,     setSearch]     = useState("");
  const [deptFilter, setDeptFilter] = useState("");   // ← new: dept filter
  const [modal,      setModal]      = useState(null); // "add" | "edit" | null
  const [viewEmp,    setViewEmp]    = useState(null);
  const [form,       setForm]       = useState({});
  const [saving,     setSaving]     = useState(false);

  // Active departments for dropdown
  const activeDepts = departments.filter(d => d.status === "Active");

  // Role-scoped base list — admin/hr see everyone, manager sees their dept,
  // tl sees their team, employee (shouldn't land here) sees only self.
  const scoped = scopeEmployees(user, employees);

  // Which roles can this user assign to a new/edited employee?
  const myAssignableRoles = assignableRoles(user);

  // Manager/TL are locked to their own department when adding people
  const deptLocked = user.role === "manager" || user.role === "tl";

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
  const openAdd = () => {
    setForm({
      role:       myAssignableRoles[0] || "employee",
      status:     "active",
      allowances: 0,
      dept:       deptLocked ? user.dept : "",
      ...(user.role === "tl" ? { teamLeadId: user.id } : {}),
    });
    setModal("add");
  };
  const openEdit = (emp) => { setForm({ ...emp }); setModal("edit"); };

  const save = async () => {
    setSaving(true);
    try {
      // Manager/TL can never assign outside their own dept/team, regardless
      // of what the form state holds.
      const locked = deptLocked ? { dept: user.dept } : {};
      if (user.role === "tl") locked.teamLeadId = user.id;

      if (modal === "add") {
        const id     = Date.now();
        const newEmp = {
          ...form,
          ...locked,
          id,
          empId:      `EMP-${String(employees.length + 1).padStart(3, "0")}`,
          basic:      +form.basic      || 0,
          allowances: +form.allowances || 0,
        };
        await addEmployee(newEmp);
      } else {
        await updateEmployee(form.id, { ...form, ...locked, basic: +form.basic, allowances: +form.allowances });
      }
      setModal(null);
    } finally {
      setSaving(false);
    }
  };

  const del = async (id) => {
    if (window.confirm("Remove this employee?")) await deleteEmployee(id);
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
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
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
                        <button onClick={() => openEdit(emp)} style={{ background: "#f0a50015", border: "none", color: T.warning, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}><Edit   size={13} /></button>
                      )}
                      {(user.role === "admin" || user.role === "hr") && (
                        <button onClick={() => del(emp.id)}   style={{ background: T.dangerGlow, border: "none", color: T.danger,  padding: "5px 8px", borderRadius: 6, cursor: "pointer" }}><Trash2 size={13} /></button>
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
        <Modal title={modal === "add" ? "Add Employee" : "Edit Employee"} onClose={() => setModal(null)} wide>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Input label="Full Name"    value={form.name       || ""} onChange={e => setForm(p => ({ ...p, name:       e.target.value }))} />
            <Input label="Email"        value={form.email      || ""} onChange={e => setForm(p => ({ ...p, email:      e.target.value }))} type="email" />
            <Input label="Phone"        value={form.phone      || ""} onChange={e => setForm(p => ({ ...p, phone:      e.target.value }))} />

            {/* Department — now a dropdown from Firestore ← changed */}
            <Select
              label="Department"
              value={form.dept || ""}
              onChange={e => setForm(p => ({ ...p, dept: e.target.value }))}
              disabled={deptLocked}
            >
              <option value="">— Select Department —</option>
              {(deptLocked ? activeDepts.filter(d => d.name === user.dept) : activeDepts).map(d => (
                <option key={d.id} value={d.name}>{d.name}</option>
              ))}
            </Select>

            <Input label="Position"     value={form.pos        || ""} onChange={e => setForm(p => ({ ...p, pos:        e.target.value }))} />
            <Input label="Basic Salary" value={form.basic      || ""} onChange={e => setForm(p => ({ ...p, basic:      e.target.value }))} type="number" />
            <Input label="Allowances"   value={form.allowances || ""} onChange={e => setForm(p => ({ ...p, allowances: e.target.value }))} type="number" />
            <Input label="Join Date"    value={form.joinDate   || ""} onChange={e => setForm(p => ({ ...p, joinDate:   e.target.value }))} type="date" />
            {/* Role choices depend on who's creating/editing — a manager can
                only make Team Leads, a TL can only add Employees, etc. */}
            <Select label="Role" value={form.role || myAssignableRoles[0] || "employee"} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
              {myAssignableRoles.map(r => (
                <option key={r} value={r}>{r === "hr" ? "HR" : r === "tl" ? "Team Lead" : r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </Select>
            <Select label="Status" value={form.status || "active"}   onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </div>
          {modal === "add" && (
            <Input label="Password" value={form.pass || ""} onChange={e => setForm(p => ({ ...p, pass: e.target.value }))} type="password" />
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Btn variant="ghost" onClick={() => setModal(null)}>Cancel</Btn>
            <Btn onClick={save} disabled={saving}>
              <Check size={13} />
              {saving ? "Saving…" : modal === "add" ? "Add Employee" : "Save Changes"}
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