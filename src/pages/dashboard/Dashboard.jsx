// src/pages/dashboard/Dashboard.jsx
import {
  Users, Calendar, DollarSign, Target, Clock, Building2,   // ← Building2 added
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";

import { T }          from "../../theme/theme";
import { fmt, pct, fdate, kpiScore, perfLabel, perfColor } from "../../utils/helpers";
import Stat        from "../../components/stat/Stat";
import Badge       from "../../components/badge/Badge";
import Avatar      from "../../components/avatar/Avatar";
import ProgressBar from "../../components/ProgressBar/ProgressBar";

const Dashboard = ({ user, employees, kpis, leaves, payroll, leaveBalances, departments }) => {
  const isAdmin  = user.role !== "employee";
  const myKpis   = kpis.filter(k => k.empId === user.id);
  const myLeaves = leaves.filter(l => l.empId === user.id);
  const myScore  = kpiScore(myKpis);

  // ── Dynamic dept chart data from Firestore departments ─────────
  // Falls back to deriving from employees if no departments seeded yet
  const deptData = departments.length > 0
    ? departments
        .map(d => ({
          dept:  d.name.slice(0, 4),
          count: employees.filter(e => e.dept === d.name && e.status === "active").length,
        }))
        .filter(d => d.count > 0)
    : [...new Set(employees.map(e => e.dept).filter(Boolean))]
        .map(d => ({
          dept:  d.slice(0, 4),
          count: employees.filter(e => e.dept === d && e.status === "active").length,
        }))
        .filter(d => d.count > 0);

  const payTrend = [
    { m: "Oct", total: 520000 }, { m: "Nov", total: 580000 }, { m: "Dec", total: 640000 },
    { m: "Jan", total: 590000 }, { m: "Feb", total: 620000 }, { m: "Mar", total: 660000 },
  ];

  const leaveStatus = [
    { name: "Approved", value: leaves.filter(l => l.status === "approved").length, color: T.success },
    { name: "Pending",  value: leaves.filter(l => l.status === "pending").length,  color: T.warning },
    { name: "Rejected", value: leaves.filter(l => l.status === "rejected").length, color: T.danger  },
  ];

  const kpiPerf = employees.filter(e => e.role === "employee").map(e => {
    const eKpis = kpis.filter(k => k.empId === e.id);
    return { name: e.name.split(" ")[0], score: kpiScore(eKpis) };
  }).filter(e => e.score > 0);

  // ─────────────────────────────────────────────────────────────────
  if (!isAdmin) {
    // ── Employee Dashboard ────────────────────────────────────────
    return (
      <div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 4 }}>
            Welcome back, {user.name.split(" ")[0]} 👋
          </div>
          <div style={{ fontSize: 13, color: T.muted }}>{user.pos} · {user.dept}</div>
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
          <Stat icon={Target}     label="KPI Score"      value={`${myScore}%`}        sub={perfLabel(myScore)}                                                   color={perfColor(myScore)} />
          <Stat icon={Calendar}   label="Leave Balance"  value={`${leaveBalances[user.id]?.Annual?.r || 15} days`} sub="Annual leave remaining"                color={T.warning}          />
          <Stat icon={Clock}      label="Leave Requests" value={myLeaves.length}       sub={`${myLeaves.filter(l => l.status === "pending").length} pending`}    color={T.primary}          />
          <Stat icon={DollarSign} label="Last Payslip"   value="March 2025"            sub={fmt(payroll.find(p => p.empId === user.id)?.net || 0)}              color={T.success}          />
        </div>

        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 14 }}>My KPIs — Q1 2025</div>
          {myKpis.length === 0
            ? <div style={{ color: T.muted, fontSize: 13 }}>No KPIs assigned yet.</div>
            : myKpis.map(k => {
                const p = pct(k.current, k.target);
                return (
                  <div key={k.id} style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{k.title}</span>
                      <span style={{ fontSize: 12, color: perfColor(p), fontWeight: 700 }}>{p}%</span>
                    </div>
                    <ProgressBar value={k.current} max={k.target} color={perfColor(p)} />
                    <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{k.current} / {k.target} · Weight: {k.weight}%</div>
                  </div>
                );
              })
          }
        </div>

        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 14 }}>Recent Leave Requests</div>
          {myLeaves.length === 0
            ? <div style={{ color: T.muted, fontSize: 13 }}>No leave requests.</div>
            : myLeaves.map(l => (
                <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{l.type} Leave</div>
                    <div style={{ fontSize: 11, color: T.muted }}>{fdate(l.start)} → {fdate(l.end)} · {l.days} day{l.days > 1 ? "s" : ""}</div>
                  </div>
                  <Badge s={l.status} />
                </div>
              ))
          }
        </div>
      </div>
    );
  }

  // ── Admin / HR Dashboard ────────────────────────────────────────
  return (
    <div>
      {/* ── Stat Cards ─────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon={Users}      label="Total Employees"   value={employees.length}
          sub={`${employees.filter(e => e.status === "active").length} active`}   color={T.primary}   />
        <Stat icon={Building2}  label="Total Departments" value={departments.length}
          sub={`${departments.filter(d => d.status === "Active").length} active`} color={T.purple}    />  {/* ← new */}
        <Stat icon={Calendar}   label="Leave Requests"    value={leaves.filter(l => l.status === "pending").length}
          sub="Awaiting approval"                                                  color={T.warning}   />
        <Stat icon={DollarSign} label="Monthly Payroll"   value="PKR 6.6L"
          sub="March 2025 total"                                                   color={T.success}   />
        <Stat icon={Target}     label="Avg KPI Score"
          value={kpis.length ? `${Math.round(kpis.reduce((s, k) => s + pct(k.current, k.target), 0) / kpis.length)}%` : "—"}
          sub="All employees Q1 2025"                                              color={T.secondary} />
      </div>

      {/* ── Charts row ─────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 20 }}>

        {/* Payroll trend */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 16 }}>Payroll Trend (6 months)</div>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={payTrend}>
              <defs>
                <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={T.primary} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={T.primary} stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
              <XAxis dataKey="m" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: T.muted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${v / 1000}K`} />
              <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: T.text }} formatter={v => [`PKR ${v.toLocaleString()}`, ""]} />
              <Area type="monotone" dataKey="total" stroke={T.primary} strokeWidth={2} fill="url(#pg)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Employees by Department — now dynamic from Firestore */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 16 }}>Employees by Department</div>
          {deptData.length === 0
            ? <div style={{ color: T.muted, fontSize: 13, paddingTop: 60, textAlign: "center" }}>No department data yet.</div>
            : (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={deptData} barSize={20}>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                  <XAxis dataKey="dept" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: T.text }} />
                  <Bar dataKey="count" fill={T.primary} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )
          }
        </div>

        {/* Leave status pie */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 16 }}>Leave Status Overview</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <ResponsiveContainer width={120} height={120}>
              <PieChart>
                <Pie data={leaveStatus} dataKey="value" innerRadius={35} outerRadius={55}>
                  {leaveStatus.map((e, i) => <Cell key={i} fill={e.color} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div style={{ flex: 1 }}>
              {leaveStatus.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: T.muted, flex: 1 }}>{s.name}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{s.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── KPI bar ────────────────────────────────────────────── */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 16 }}>Employee KPI Performance</div>
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={kpiPerf} barSize={28} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={false} />
            <XAxis type="number" domain={[0, 100]} tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={55} />
            <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }}
              formatter={v => [`${v}%`, "KPI Score"]} />
            <Bar dataKey="score" radius={[0, 4, 4, 0]}>
              {kpiPerf.map((e, i) => <Cell key={i} fill={perfColor(e.score)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* ── Pending Leaves ─────────────────────────────────────── */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 14 }}>Pending Leave Requests</div>
        {leaves.filter(l => l.status === "pending").length === 0
          ? <div style={{ color: T.muted, fontSize: 13 }}>No pending requests.</div>
          : leaves.filter(l => l.status === "pending").map(l => {
              const emp = employees.find(e => e.id === l.empId);
              return (
                <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
                  {emp && <Avatar emp={emp} size={32} />}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{emp?.name}</div>
                    <div style={{ fontSize: 11, color: T.muted }}>{l.type} · {l.days} day{l.days > 1 ? "s" : ""} · {fdate(l.start)}</div>
                  </div>
                  <Badge s="pending" />
                </div>
              );
            })
        }
      </div>
    </div>
  );
};

export default Dashboard;