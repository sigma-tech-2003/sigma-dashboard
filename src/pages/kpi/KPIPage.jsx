// src/pages/kpi/KPIPage.jsx
import { useState } from "react";
import { Plus, Check } from "lucide-react";

import { T } from "../../theme/theme";
import { pct, kpiScore, perfLabel, perfColor } from "../../utils/helpers";
import Avatar      from "../../components/avatar/Avatar";
import Modal       from "../../components/modal/Modal";
import Input       from "../../components/input/Input";
import Select      from "../../components/select/Select";
import Btn         from "../../components/btn/Btn";
import ProgressBar from "../../components/ProgressBar/ProgressBar";

const KPIPage = ({ kpis, addKpi, updateKpi, employees, user }) => {
  const [modal,  setModal]  = useState(false);
  const [form,   setForm]   = useState({});
  const [selEmp, setSelEmp] = useState("all");

  const isAdmin = user.role !== "employee";
  const myKpis  = isAdmin ? kpis : kpis.filter(k => k.empId === user.id);
  const visible  = selEmp === "all" ? myKpis : myKpis.filter(k => k.empId === parseInt(selEmp));

  const empKpiSummary = employees.filter(e => e.role === "employee").map(e => {
    const eks = kpis.filter(k => k.empId === e.id);
    return { emp: e, kpis: eks, score: kpiScore(eks), label: perfLabel(kpiScore(eks)) };
  }).filter(s => s.kpis.length > 0);

  const save = async () => {
    await addKpi({
      ...form,
      id:      Date.now(),
      empId:   +form.empId,
      target:  +form.target,
      current: +form.current,
      weight:  +form.weight,
      status:  "active",
    });
    setModal(false);
  };

  const updateCurrent = async (id, val) => {
    await updateKpi(id, { current: Math.max(0, +val) });
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>KPI Tracker</div>
          <div style={{ fontSize: 12, color: T.muted }}>Performance indicators & scoring — Q1 2025</div>
        </div>
        {isAdmin && (
          <Btn onClick={() => { setForm({ period: "Q1 2025" }); setModal(true); }}>
            <Plus size={14} />Assign KPI
          </Btn>
        )}
      </div>

      {/* Admin: summary cards */}
      {isAdmin && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          {empKpiSummary.map(s => (
            <div key={s.emp.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, minWidth: 180, flex: "1 1 180px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <Avatar emp={s.emp} size={32} />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{s.emp.name.split(" ")[0]}</div>
                  <div style={{ fontSize: 10, color: T.muted }}>{s.emp.dept}</div>
                </div>
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, color: perfColor(s.score) }}>{s.score}%</div>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 8 }}>{s.label}</div>
              <ProgressBar value={s.score} color={perfColor(s.score)} h={4} />
            </div>
          ))}
        </div>
      )}

      {/* Admin: employee filter */}
      {isAdmin && (
        <div style={{ marginBottom: 14 }}>
          <select
            value={selEmp}
            onChange={e => setSelEmp(e.target.value)}
            style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px", color: T.text, fontSize: 13, outline: "none" }}>
            <option value="all">All Employees</option>
            {employees.filter(e => e.role === "employee").map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* KPI cards grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 14 }}>
        {visible.map(k => {
          const p   = pct(k.current, k.target);
          const emp = employees.find(e => e.id === k.empId);
          return (
            <div key={k.id}
              style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18, transition: "all .2s" }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = perfColor(p))}
              onMouseLeave={e => (e.currentTarget.style.borderColor = T.border)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>{k.title}</div>
                  {isAdmin && emp && <div style={{ fontSize: 11, color: T.muted }}>{emp.name} · {emp.dept}</div>}
                  <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>Period: {k.period} · Weight: {k.weight}%</div>
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: perfColor(p) }}>{p}%</div>
              </div>
              <ProgressBar value={k.current} max={k.target} color={perfColor(p)} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: T.muted }}>{k.current?.toLocaleString()} / {k.target?.toLocaleString()}</span>
                <span style={{ fontSize: 11, color: perfColor(p), fontWeight: 700 }}>{perfLabel(p)}</span>
              </div>
              {isAdmin && (
                <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: T.muted, flexShrink: 0 }}>Update:</span>
                  <input
                    type="number"
                    defaultValue={k.current}
                    onBlur={e => updateCurrent(k.id, e.target.value)}
                    style={{ flex: 1, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 8px", color: T.text, fontSize: 12, outline: "none" }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Assign KPI Modal */}
      {modal && (
        <Modal title="Assign New KPI" onClose={() => setModal(false)}>
          <Select label="Employee" value={form.empId || ""} onChange={e => setForm(p => ({ ...p, empId: e.target.value }))}>
            <option value="">Select employee</option>
            {employees.filter(e => e.role === "employee").map(e => (
              <option key={e.id} value={e.id}>{e.name} — {e.dept}</option>
            ))}
          </Select>
          <Input label="KPI Title" value={form.title || ""} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 12px" }}>
            <Input label="Target"   value={form.target  || ""} onChange={e => setForm(p => ({ ...p, target:  e.target.value }))} type="number" />
            <Input label="Current"  value={form.current || ""} onChange={e => setForm(p => ({ ...p, current: e.target.value }))} type="number" />
            <Input label="Weight %" value={form.weight  || ""} onChange={e => setForm(p => ({ ...p, weight:  e.target.value }))} type="number" />
          </div>
          <Input label="Period" value={form.period || ""} onChange={e => setForm(p => ({ ...p, period: e.target.value }))} />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Btn variant="ghost" onClick={() => setModal(false)}>Cancel</Btn>
            <Btn onClick={save} disabled={!form.empId || !form.title}>
              <Check size={13} />Assign KPI
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default KPIPage;
