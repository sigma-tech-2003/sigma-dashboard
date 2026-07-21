// src/pages/dashboard/Dashboard.jsx
// Role-based dashboards. Same visual language everywhere (Stat / Card / chart
// styles copied 1:1 from the original dashboard) — only the data shown and
// the actions offered change per role.
import {
  Users, Calendar, DollarSign, Target, Clock, Building2,
  UserCog, ShieldCheck, Briefcase, ListChecks, TrendingUp,
  CheckCircle2, ClipboardList,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";

import { T }          from "../../theme/theme";
import { fmt, pct, fdate, kpiScore, perfLabel, perfColor } from "../../utils/helpers";
import { scopeEmployees, scopeByEmployee } from "../../utils/permissions";
import { ANNOUNCEMENTS } from "../../data/announcements";
import Stat        from "../../components/stat/Stat";
import Badge       from "../../components/badge/Badge";
import Avatar      from "../../components/avatar/Avatar";
import ProgressBar from "../../components/ProgressBar/ProgressBar";

// ── Shared building blocks (visual style copied from the original file) ───
const Card = ({ title, right, children, style }) => (
  <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, ...style }}>
    {(title || right) && (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        {title && <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{title}</div>}
        {right}
      </div>
    )}
    {children}
  </div>
);

const EmptyRow = ({ children }) => <div style={{ color: T.muted, fontSize: 13 }}>{children}</div>;

const EmployeeRow = ({ emp, sub }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
    <Avatar emp={emp} size={30} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{emp.name}</div>
      <div style={{ fontSize: 11, color: T.muted }}>{sub}</div>
    </div>
    <Badge s={emp.status} />
  </div>
);

const LeaveRow = ({ l, emp }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
    {emp && <Avatar emp={emp} size={32} />}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{emp?.name || "—"}</div>
      <div style={{ fontSize: 11, color: T.muted }}>{l.type} · {l.days} day{l.days > 1 ? "s" : ""} · {fdate(l.start)}</div>
    </div>
    <Badge s={l.status} />
  </div>
);

// Recent employees, most-recently-joined first.
const recentOf = (list, n = 5) =>
  [...list].sort((a, b) => new Date(b.joinDate || 0) - new Date(a.joinDate || 0)).slice(0, n);

// There's no attendance collection yet, so "attendance" is approximated from
// who's on approved leave today against the active headcount. Swap this for
// a real useAttendance() hook once that module exists.
const attendanceProxy = (scope, leaves) => {
  const today   = new Date().toISOString().slice(0, 10);
  const active  = scope.filter(e => e.status === "active");
  const onLeave = new Set(
    leaves.filter(l => l.status === "approved" && l.start <= today && l.end >= today).map(l => l.empId)
  );
  const present = active.filter(e => !onLeave.has(e.id)).length;
  return { present, total: active.length, onLeave: onLeave.size };
};

const payTrend = [
  { m: "Oct", total: 520000 }, { m: "Nov", total: 580000 }, { m: "Dec", total: 640000 },
  { m: "Jan", total: 590000 }, { m: "Feb", total: 620000 }, { m: "Mar", total: 660000 },
];

const leaveStatusData = (leaves) => ([
  { name: "Approved", value: leaves.filter(l => l.status === "approved").length, color: T.success },
  { name: "Pending",  value: leaves.filter(l => l.status === "pending").length,  color: T.warning },
  { name: "Rejected", value: leaves.filter(l => l.status === "rejected").length, color: T.danger  },
]);

const PieCard = ({ title, data }) => (
  <Card title={title}>
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <ResponsiveContainer width={120} height={120}>
        <PieChart>
          <Pie data={data} dataKey="value" innerRadius={35} outerRadius={55}>
            {data.map((e, i) => <Cell key={i} fill={e.color} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div style={{ flex: 1 }}>
        {data.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: T.muted, flex: 1 }}>{s.name}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  </Card>
);

const KpiBarCard = ({ title, data }) => (
  <Card title={title}>
    {data.length === 0 ? <EmptyRow>No KPI data yet.</EmptyRow> : (
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} barSize={26} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="name" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={60} />
          <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }}
            formatter={v => [`${v}%`, "KPI Score"]} />
          <Bar dataKey="score" radius={[0, 4, 4, 0]}>
            {data.map((e, i) => <Cell key={i} fill={perfColor(e.score)} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    )}
  </Card>
);

const AnnouncementsCard = () => (
  <Card title="Company Announcements">
    {ANNOUNCEMENTS.map(a => (
      <div key={a.id} style={{ padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{a.title}</span>
          <span style={{ fontSize: 11, color: T.muted, whiteSpace: "nowrap" }}>{fdate(a.date)}</span>
        </div>
        <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>{a.body}</div>
      </div>
    ))}
  </Card>
);

// ─────────────────────────────────────────────────────────────────────────
// ADMIN — full-system view
// ─────────────────────────────────────────────────────────────────────────
const AdminDashboard = ({ employees, kpis, leaves, payroll, departments }) => {
  const managers  = employees.filter(e => e.role === "manager");
  const teamLeads = employees.filter(e => e.role === "tl");
  const hrStaff   = employees.filter(e => e.role === "hr");
  const active    = employees.filter(e => e.status === "active");
  const att       = attendanceProxy(employees, leaves);
  const netPaid   = payroll.reduce((s, p) => s + (p.net || 0), 0);
  const avgKpi    = kpis.length ? Math.round(kpis.reduce((s, k) => s + pct(k.current, k.target), 0) / kpis.length) : 0;

  const deptData = departments.length > 0
    ? departments.map(d => ({ dept: d.name.slice(0, 4), count: employees.filter(e => e.dept === d.name && e.status === "active").length })).filter(d => d.count > 0)
    : [...new Set(employees.map(e => e.dept).filter(Boolean))].map(d => ({ dept: d.slice(0, 4), count: employees.filter(e => e.dept === d && e.status === "active").length })).filter(d => d.count > 0);

  const kpiPerf = employees.filter(e => ["employee", "tl"].includes(e.role)).map(e => ({ name: e.name.split(" ")[0], score: kpiScore(kpis.filter(k => k.empId === e.id)) })).filter(e => e.score > 0);

  return (
    <div>
      {/* Headcount by role */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
        <Stat icon={Users}     label="Total Employees"   value={employees.length}   sub={`${active.length} active`}              color={T.primary}   />
        <Stat icon={Building2} label="Total Departments" value={departments.length} sub={`${departments.filter(d => d.status === "Active").length} active`} color={T.purple} />
        <Stat icon={UserCog}   label="Total Managers"    value={managers.length}    sub="Department heads"                       color={T.secondary} />
        <Stat icon={ShieldCheck} label="Total Team Leads" value={teamLeads.length}  sub="Across all teams"                       color={T.success}   />
        <Stat icon={Briefcase} label="Total HR Staff"    value={hrStaff.length}     sub="HR operations"                          color={T.warning}   />
      </div>

      {/* Org-wide summaries */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon={Clock}      label="Attendance Summary" value={`${att.present}/${att.total}`} sub="Present today (approx.)" color={T.secondary} />
        <Stat icon={Calendar}   label="Leave Summary"      value={leaves.filter(l => l.status === "pending").length} sub={`${leaves.filter(l => l.status === "approved").length} approved this period`} color={T.warning} />
        <Stat icon={DollarSign} label="Payroll Summary"    value={fmt(netPaid)} sub={`${payroll.length} payslips processed`} color={T.success} />
        <Stat icon={Target}     label="KPI Summary"        value={kpis.length ? `${avgKpi}%` : "—"} sub="Company-wide average" color={T.purple} />
      </div>

      {/* Charts */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 20 }}>
        <Card title="Payroll Trend (6 months)">
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={payTrend}>
              <defs>
                <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={T.primary} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={T.primary} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
              <XAxis dataKey="m" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: T.muted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${v / 1000}K`} />
              <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: T.text }} formatter={v => [`PKR ${v.toLocaleString()}`, ""]} />
              <Area type="monotone" dataKey="total" stroke={T.primary} strokeWidth={2} fill="url(#pg)" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Employees by Department">
          {deptData.length === 0 ? <EmptyRow>No department data yet.</EmptyRow> : (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={deptData} barSize={20}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                <XAxis dataKey="dept" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: T.text }} />
                <Bar dataKey="count" fill={T.primary} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <PieCard title="Leave Status Overview" data={leaveStatusData(leaves)} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <KpiBarCard title="Company Performance — KPI Scores" data={kpiPerf} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card title="Recent Employees">
          {recentOf(employees).length === 0 ? <EmptyRow>No employees yet.</EmptyRow> :
            recentOf(employees).map(e => <EmployeeRow key={e.id} emp={e} sub={`${e.pos} · ${e.dept}`} />)}
        </Card>

        <Card title="Monthly Report" right={<ListClipboard />}>
          <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.8 }}>
            <div><strong style={{ color: T.text }}>{active.length}</strong> active employees this month</div>
            <div><strong style={{ color: T.text }}>{leaves.filter(l => l.status === "approved").length}</strong> leave requests approved</div>
            <div><strong style={{ color: T.text }}>{fmt(netPaid)}</strong> total payroll disbursed</div>
            <div><strong style={{ color: T.text }}>{kpis.length ? `${avgKpi}%` : "—"}</strong> average KPI performance</div>
          </div>
        </Card>
      </div>

      <Card title="Pending Leave Requests">
        {leaves.filter(l => l.status === "pending").length === 0
          ? <EmptyRow>No pending requests.</EmptyRow>
          : leaves.filter(l => l.status === "pending").map(l => <LeaveRow key={l.id} l={l} emp={employees.find(e => e.id === l.empId)} />)}
      </Card>
    </div>
  );
};

// Small inline icon helper used above (kept local to avoid a stray unused import if trimmed later)
const ListClipboard = () => <ClipboardList size={16} color={T.muted} />;

// ─────────────────────────────────────────────────────────────────────────
// HR — operational access (no system settings / role management / dept delete)
// ─────────────────────────────────────────────────────────────────────────
const HRDashboard = ({ employees, kpis, leaves, payroll }) => {
  const active = employees.filter(e => e.status === "active");
  const att    = attendanceProxy(employees, leaves);
  const today  = new Date().toISOString().slice(0, 10);
  const onLeaveToday = leaves.filter(l => l.status === "approved" && l.start <= today && l.end <= today);
  const pending = leaves.filter(l => l.status === "pending");
  const netPaid = payroll.reduce((s, p) => s + (p.net || 0), 0);
  const avgKpi  = kpis.length ? Math.round(kpis.reduce((s, k) => s + pct(k.current, k.target), 0) / kpis.length) : 0;

  return (
    <div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon={Users}    label="Total Employees"    value={employees.length}  sub={`${active.length} active`}          color={T.primary}   />
        <Stat icon={Clock}    label="Today's Attendance" value={`${att.present}/${att.total}`} sub="Present (approx.)"      color={T.secondary} />
        <Stat icon={Calendar} label="Employees on Leave" value={att.onLeave}       sub="On approved leave today"            color={T.warning}   />
        <Stat icon={ListChecks} label="Pending Requests" value={pending.length}    sub="Leave awaiting review"              color={T.danger}    />
        <Stat icon={DollarSign} label="Payroll Overview" value={fmt(netPaid)}      sub={`${payroll.length} payslips`}       color={T.success}   />
        <Stat icon={Target}   label="KPI Summary"        value={kpis.length ? `${avgKpi}%` : "—"} sub="All employees"       color={T.purple}    />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        <PieCard title="Attendance & Leave Overview" data={leaveStatusData(leaves)} />
        <Card title="Recent Employees">
          {recentOf(employees).length === 0 ? <EmptyRow>No employees yet.</EmptyRow> :
            recentOf(employees).map(e => <EmployeeRow key={e.id} emp={e} sub={`${e.pos} · ${e.dept}`} />)}
        </Card>
      </div>

      <Card title="Pending Leave Requests">
        {pending.length === 0 ? <EmptyRow>No pending requests.</EmptyRow> :
          pending.map(l => <LeaveRow key={l.id} l={l} emp={employees.find(e => e.id === l.empId)} />)}
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// MANAGER — scoped to their own department
// ─────────────────────────────────────────────────────────────────────────
const ManagerDashboard = ({ user, employees, kpis, leaves }) => {
  const deptEmployees = scopeEmployees(user, employees);
  const teamLeads      = deptEmployees.filter(e => e.role === "tl");
  const deptLeaves     = scopeByEmployee(user, leaves, employees);
  const pendingLeaves  = deptLeaves.filter(l => l.status === "pending");
  const deptKpis       = scopeByEmployee(user, kpis, employees);
  const avgKpi         = deptKpis.length ? kpiScore(deptKpis) : 0;
  const att             = attendanceProxy(deptEmployees, deptLeaves);
  const pendingTasks    = deptKpis.filter(k => pct(k.current, k.target) < 100).length;

  const perf = deptEmployees.filter(e => ["employee", "tl"].includes(e.role))
    .map(e => ({ name: e.name.split(" ")[0], score: kpiScore(kpis.filter(k => k.empId === e.id)) }))
    .filter(e => e.score > 0);

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 4 }}>{user.dept} Department</div>
        <div style={{ fontSize: 13, color: T.muted }}>Manager · {user.name}</div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon={Users}      label="Total Employees"      value={deptEmployees.length}         sub={`${deptEmployees.filter(e => e.status === "active").length} active`} color={T.primary}   />
        <Stat icon={ShieldCheck} label="Total Team Leads"    value={teamLeads.length}              sub="Reporting to you"                                                  color={T.secondary} />
        <Stat icon={Calendar}   label="Pending Leave Requests" value={pendingLeaves.length}        sub="Awaiting your approval"                                            color={T.warning}   />
        <Stat icon={Target}     label="Average KPI Score"    value={deptKpis.length ? `${avgKpi}%` : "—"} sub={perfLabel(avgKpi)}                                          color={perfColor(avgKpi)} />
        <Stat icon={Clock}      label="Attendance Summary"   value={`${att.present}/${att.total}`} sub="Present today (approx.)"                                          color={T.success}   />
        <Stat icon={ListChecks} label="Pending Tasks"        value={pendingTasks}                  sub="KPI items in progress"                                            color={T.danger}    />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        <KpiBarCard title="Department Performance" data={perf} />
        <Card title="Monthly Productivity">
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={payTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
              <XAxis dataKey="m" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: T.text }} />
              <Area type="monotone" dataKey="total" stroke={T.secondary} strokeWidth={2} fill={`${T.secondary}25`} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card title="Recent Employees">
          {recentOf(deptEmployees).length === 0 ? <EmptyRow>No employees yet.</EmptyRow> :
            recentOf(deptEmployees).map(e => <EmployeeRow key={e.id} emp={e} sub={e.pos} />)}
        </Card>
        <Card title="Pending Leave Requests">
          {pendingLeaves.length === 0 ? <EmptyRow>No pending requests.</EmptyRow> :
            pendingLeaves.map(l => <LeaveRow key={l.id} l={l} emp={employees.find(e => e.id === l.empId)} />)}
        </Card>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// TEAM LEAD — scoped to their own team (matched via employee.teamLeadId)
// ─────────────────────────────────────────────────────────────────────────
const TLDashboard = ({ user, employees, kpis, leaves }) => {
  const team          = scopeEmployees(user, employees).filter(e => e.id !== user.id);
  const teamLeaves    = scopeByEmployee(user, leaves, employees);
  const pendingLeaves = teamLeaves.filter(l => l.status === "pending");
  const teamKpis      = scopeByEmployee(user, kpis, employees);
  const avgKpi        = teamKpis.length ? kpiScore(teamKpis) : 0;
  const att            = attendanceProxy(team, teamLeaves);
  const pendingTasks   = teamKpis.filter(k => pct(k.current, k.target) < 100).length;
  const taskProgress   = teamKpis.length ? Math.round(teamKpis.reduce((s, k) => s + pct(k.current, k.target), 0) / teamKpis.length) : 0;

  const productivity = team.map(e => ({ name: e.name.split(" ")[0], score: kpiScore(kpis.filter(k => k.empId === e.id)) })).filter(e => e.score > 0);

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 4 }}>My Team</div>
        <div style={{ fontSize: 13, color: T.muted }}>Team Lead · {user.name} · {user.dept}</div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon={Users}    label="Team Size"            value={team.length}                    sub={`${team.filter(e => e.status === "active").length} active`} color={T.primary}   />
        <Stat icon={Clock}    label="Team Attendance"      value={`${att.present}/${att.total}`}  sub="Present today (approx.)"                                    color={T.secondary} />
        <Stat icon={Calendar} label="Pending Leave Requests" value={pendingLeaves.length}         sub="Awaiting your review"                                       color={T.warning}   />
        <Stat icon={Target}   label="Average KPI Score"    value={teamKpis.length ? `${avgKpi}%` : "—"} sub={perfLabel(avgKpi)}                                    color={perfColor(avgKpi)} />
        <Stat icon={TrendingUp} label="Task Progress"      value={teamKpis.length ? `${taskProgress}%` : "—"} sub={`${pendingTasks} pending`}                       color={T.success}   />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        <KpiBarCard title="Team Performance" data={productivity} />
        <Card title="Employee Productivity">
          {team.length === 0 ? <EmptyRow>No team members assigned yet.</EmptyRow> : team.map(e => {
            const s = kpiScore(kpis.filter(k => k.empId === e.id));
            return (
              <div key={e.id} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: T.text }}>{e.name}</span>
                  <span style={{ fontSize: 12, color: perfColor(s), fontWeight: 700 }}>{s}%</span>
                </div>
                <ProgressBar value={s} max={100} color={perfColor(s)} />
              </div>
            );
          })}
        </Card>
      </div>

      <Card title="Recent Activities">
        {teamLeaves.length === 0 ? <EmptyRow>No recent activity.</EmptyRow> :
          [...teamLeaves].sort((a, b) => new Date(b.applied || 0) - new Date(a.applied || 0)).slice(0, 6)
            .map(l => <LeaveRow key={l.id} l={l} emp={employees.find(e => e.id === l.empId)} />)}
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// EMPLOYEE — own data only
// ─────────────────────────────────────────────────────────────────────────
const EmployeeDashboard = ({ user, kpis, leaves, payroll, leaveBalances }) => {
  const myKpis   = kpis.filter(k => k.empId === user.id);
  const myLeaves = leaves.filter(l => l.empId === user.id);
  const myScore  = kpiScore(myKpis);
  const myBal    = leaveBalances[user.id] || {};
  const annualLeft = myBal.Annual?.r ?? 15;
  const lastPayslip = payroll.find(p => p.empId === user.id);
  const completedTasks = myKpis.filter(k => pct(k.current, k.target) >= 100).length;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 4 }}>Welcome back, {user.name.split(" ")[0]} 👋</div>
        <div style={{ fontSize: 13, color: T.muted }}>{user.pos} · {user.dept}</div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon={Target}     label="Monthly KPI Score" value={`${myScore}%`}        sub={perfLabel(myScore)}                                                color={perfColor(myScore)} />
        <Stat icon={Calendar}   label="Leave Balance"     value={`${annualLeft} days`} sub="Annual leave remaining"                                            color={T.warning}          />
        <Stat icon={Clock}      label="Attendance %"      value={myLeaves.length ? `${Math.max(0, 100 - myLeaves.reduce((s, l) => s + (l.status === "approved" ? l.days : 0), 0))}%` : "100%"} sub="Estimated, based on leave taken" color={T.secondary} />
        <Stat icon={DollarSign} label="My Payslips"       value={lastPayslip ? fmt(lastPayslip.net) : "—"} sub={lastPayslip ? `${lastPayslip.month} ${lastPayslip.year}` : "No payslip yet"} color={T.success} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card title="My KPIs — Performance">
          {myKpis.length === 0 ? <EmptyRow>No KPIs assigned yet.</EmptyRow> : myKpis.map(k => {
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
          })}
        </Card>

        <Card title="My Tasks" right={<span style={{ fontSize: 11, color: T.muted }}>{completedTasks}/{myKpis.length} complete</span>}>
          {myKpis.length === 0 ? <EmptyRow>No tasks assigned yet.</EmptyRow> : myKpis.map(k => {
            const p = pct(k.current, k.target);
            const done = p >= 100;
            return (
              <div key={k.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                <CheckCircle2 size={16} color={done ? T.success : T.muted} />
                <span style={{ flex: 1, fontSize: 13, color: T.text }}>{k.title}</span>
                <span style={{ fontSize: 11, color: done ? T.success : T.warning, fontWeight: 600 }}>{done ? "Completed" : "In Progress"}</span>
              </div>
            );
          })}
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card title="My Leave Requests">
          {myLeaves.length === 0 ? <EmptyRow>No leave requests.</EmptyRow> : myLeaves.map(l => (
            <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{l.type} Leave</div>
                <div style={{ fontSize: 11, color: T.muted }}>{fdate(l.start)} → {fdate(l.end)} · {l.days} day{l.days > 1 ? "s" : ""}</div>
              </div>
              <Badge s={l.status} />
            </div>
          ))}
        </Card>

        <AnnouncementsCard />
      </div>

      <Card title="My Profile">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <Avatar emp={user} size={44} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{user.name}</div>
            <div style={{ fontSize: 12, color: T.muted }}>{user.empId} · {user.pos}</div>
          </div>
        </div>
        {[["Department", user.dept], ["Email", user.email], ["Phone", user.phone], ["Join Date", fdate(user.joinDate)]].map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${T.border}` }}>
            <span style={{ fontSize: 12, color: T.muted, fontWeight: 600 }}>{k}</span>
            <span style={{ fontSize: 13, color: T.text }}>{v || "—"}</span>
          </div>
        ))}
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────
const Dashboard = (props) => {
  switch (props.user.role) {
    case "hr":       return <HRDashboard      {...props} />;
    case "manager":  return <ManagerDashboard {...props} />;
    case "tl":       return <TLDashboard      {...props} />;
    case "employee": return <EmployeeDashboard {...props} />;
    default:         return <AdminDashboard   {...props} />; // "admin"
  }
};

export default Dashboard;