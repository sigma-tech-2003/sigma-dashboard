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
import { fmt, pct, fdate, getKpiRatingSummary, getProjectKpiRatingLabel, isValidProjectKpiScore, kpiScore, perfColor } from "../../utils/helpers";
import { scopeAttendance, scopeEmployees, scopeByEmployee, scopeProjectKpis } from "../../utils/permissions";
import { ANNOUNCEMENTS } from "../../data/announcements";
import Stat        from "../../components/stat/Stat";
import Badge       from "../../components/badge/Badge";
import Avatar      from "../../components/avatar/Avatar";
import Card        from "../../components/card/Card";
import ProgressBar from "../../components/ProgressBar/ProgressBar";

// ── Shared building blocks (visual style copied from the original file) ───
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

const normalizeAttendanceStatus = (status) => {
  const normalized = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  return normalized === "on leave" ? "leave" : normalized;
};

const attendanceDateValue = (value) => {
  if (typeof value === "string") {
    const dateValue = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (dateValue) return dateValue;
  }

  if (!value) return "";
  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
};

const attendanceRecordTimestamp = (record) => {
  for (const value of [record?.updatedAt, record?.createdAt]) {
    if (!value) continue;
    if (typeof value?.toMillis === "function") {
      const timestamp = value.toMillis();
      if (Number.isFinite(timestamp)) return timestamp;
    }
    const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
    const timestamp = date.getTime();
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return 0;
};

const latestAttendanceRecords = (records, employeeIds, date = "") => {
  const targetDate = date ? attendanceDateValue(date) : "";
  const latestByEmployeeDate = new Map();

  (Array.isArray(records) ? records : []).forEach((record) => {
    if (!record || typeof record !== "object" || record.empId == null) return;
    const employeeId = String(record.empId);
    const recordDate = attendanceDateValue(record.date);
    if (!employeeIds.has(employeeId) || !recordDate || (targetDate && recordDate !== targetDate)) return;

    const key = `${employeeId}:${recordDate}`;
    const current = latestByEmployeeDate.get(key);
    if (!current || attendanceRecordTimestamp(record) >= attendanceRecordTimestamp(current)) {
      latestByEmployeeDate.set(key, record);
    }
  });

  return [...latestByEmployeeDate.values()];
};

const getAttendanceSummary = (scopedEmployees, attendanceRecords, date) => {
  const activeEmployeeIds = new Set(
    (Array.isArray(scopedEmployees) ? scopedEmployees : [])
      .filter(employee =>
        employee
        && typeof employee === "object"
        && employee.id != null
        && normalizeAttendanceStatus(employee.status) === "active",
      )
      .map(employee => String(employee.id)),
  );
  const summary = {
    present: 0,
    late: 0,
    absent: 0,
    leave: 0,
    marked: 0,
    unmarked: activeEmployeeIds.size,
    total: activeEmployeeIds.size,
    attended: 0,
  };
  if (!attendanceDateValue(date)) return summary;

  latestAttendanceRecords(attendanceRecords, activeEmployeeIds, date).forEach((record) => {
    const status = normalizeAttendanceStatus(record.status);
    if (!["present", "late", "absent", "leave"].includes(status)) return;
    summary[status] += 1;
    summary.marked += 1;
  });

  summary.attended = summary.present + summary.late;
  summary.unmarked = Math.max(0, summary.total - summary.marked);
  return summary;
};

const getEmployeeAttendanceRate = (employeeId, attendanceRecords) => {
  if (employeeId == null) return { percentage: null, attended: 0, total: 0 };
  const employeeIds = new Set([String(employeeId)]);
  const eligibleStatuses = latestAttendanceRecords(attendanceRecords, employeeIds)
    .map(record => normalizeAttendanceStatus(record.status))
    .filter(status => ["present", "late", "absent"].includes(status));
  if (eligibleStatuses.length === 0) return { percentage: null, attended: 0, total: 0 };

  const attended = eligibleStatuses.filter(status => status === "present" || status === "late").length;
  return {
    percentage: Math.round((attended / eligibleStatuses.length) * 100),
    attended,
    total: eligibleStatuses.length,
  };
};

const attendanceSummaryLabel = (summary) =>
  `${summary.marked} marked · ${summary.unmarked} unmarked · ${summary.late} late`;

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
const AdminDashboard = ({ user, projects = [], employees, kpis, attendance = [], leaves, payroll, departments }) => {
  const managers  = employees.filter(e => e.role === "manager");
  const teamLeads = employees.filter(e => e.role === "tl");
  const hrStaff   = employees.filter(e => e.role === "hr");
  const active    = employees.filter(e => e.status === "active");
  const att       = getAttendanceSummary(
    employees,
    scopeAttendance(user, attendance, employees),
    new Date(),
  );
  const netPaid   = payroll.reduce((s, p) => s + (p.net || 0), 0);
  const visibleKpis = scopeProjectKpis(user, kpis, projects, employees);
  const ratingSummary = getKpiRatingSummary(visibleKpis);
  const averageCompletion = visibleKpis.length
    ? Math.round(visibleKpis.reduce((sum, kpi) => sum + pct(kpi.current, kpi.target), 0) / visibleKpis.length)
    : null;

  const deptData = departments.length > 0
    ? departments.map(d => ({ dept: d.name.slice(0, 4), count: employees.filter(e => e.dept === d.name && e.status === "active").length })).filter(d => d.count > 0)
    : [...new Set(employees.map(e => e.dept).filter(Boolean))].map(d => ({ dept: d.slice(0, 4), count: employees.filter(e => e.dept === d && e.status === "active").length })).filter(d => d.count > 0);

  const kpiEmployees = employees.filter(employee => ["employee", "tl"].includes(employee.role));
  const employeeRatings = kpiEmployees.map((employee) => {
    const employeeKpis = visibleKpis.filter(kpi =>
      kpi.empId != null
      && employee.id != null
      && String(kpi.empId) === String(employee.id),
    );
    const summary = getKpiRatingSummary(employeeKpis);
    return {
      name: employee.name || employee.email || `Employee ${employee.id}`,
      rating: summary.average,
      ratedCount: summary.ratedCount,
    };
  }).filter(employee => employee.rating !== null);
  const kpiProgress = kpiEmployees.map((employee) => ({
    name: employee.name || employee.email || `Employee ${employee.id}`,
    score: kpiScore(visibleKpis.filter(kpi =>
      kpi.empId != null
      && employee.id != null
      && String(kpi.empId) === String(employee.id),
    )),
  })).filter(employee => employee.score > 0);

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
        <Stat icon={Clock}      label="Attendance Today" value={`${att.attended}/${att.total}`} sub={attendanceSummaryLabel(att)} color={T.secondary} />
        <Stat icon={Calendar}   label="Leave Summary"      value={leaves.filter(l => l.status === "pending").length} sub={`${leaves.filter(l => l.status === "approved").length} approved this period`} color={T.warning} />
        <Stat icon={DollarSign} label="Payroll Summary"    value={fmt(netPaid)} sub={`${payroll.length} payslips processed`} color={T.success} />
        <Stat
          icon={Target}
          label="KPI Summary"
          value={ratingSummary.average === null ? "Not Rated" : `${ratingSummary.average}/10`}
          sub={`${ratingSummary.ratedCount}/${ratingSummary.totalCount} rated · ${averageCompletion === null ? "No target completion data" : `${averageCompletion}% target/current completion`}`}
          color={T.purple}
        />
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

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card title="Company Project KPI Ratings" right={<span style={{ color: T.muted, fontSize: 11 }}>0–10 scale</span>}>
          {employeeRatings.length === 0 ? <EmptyRow>No valid company KPI ratings yet.</EmptyRow> : (
            <ResponsiveContainer width="100%" height={Math.max(180, employeeRatings.length * 38)}>
              <BarChart data={employeeRatings} barSize={22} layout="vertical" margin={{ right: 42 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={false} />
                <XAxis type="number" domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={90} />
                <Tooltip
                  contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: T.text }}
                  formatter={(value, _name, item) => [`${value}/10 (${item.payload.ratedCount} rated)`, "Average rating"]}
                />
                <Bar dataKey="rating" fill={T.purple} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
        <KpiBarCard title="Company KPI Target Progress" data={kpiProgress} />
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
            <div>
              <strong style={{ color: T.text }}>
                {ratingSummary.average === null ? "Not Rated" : `${ratingSummary.average}/10`}
              </strong>{" "}
              company KPI rating · {ratingSummary.ratedCount}/{ratingSummary.totalCount} rated
            </div>
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
const HRDashboard = ({ user, projects = [], employees, kpis, attendance = [], leaves, payroll }) => {
  const active = employees.filter(e => e.status === "active");
  const today = attendanceDateValue(new Date());
  const att = getAttendanceSummary(
    employees,
    scopeAttendance(user, attendance, employees),
    today,
  );
  const approvedLeaveToday = new Set(
    leaves
      .filter((leave) => {
        const startDate = attendanceDateValue(leave.start);
        const endDate = attendanceDateValue(leave.end);
        return normalizeAttendanceStatus(leave.status) === "approved"
          && leave.empId != null
          && startDate
          && endDate
          && startDate <= today
          && endDate >= today;
      })
      .map(leave => String(leave.empId)),
  ).size;
  const pending = leaves.filter(l => l.status === "pending");
  const recentPending = [...pending]
    .sort((a, b) => new Date(b.applied || b.start || 0) - new Date(a.applied || a.start || 0))
    .slice(0, 6);
  const employeeById = new Map(employees.map(employee => [String(employee.id), employee]));
  const totalPayroll = payroll.reduce((sum, record) => sum + (Number(record.net) || 0), 0);
  const visibleKpis = scopeProjectKpis(user, kpis, projects, employees);
  const ratingSummary = getKpiRatingSummary(visibleKpis);
  const averageProgress = visibleKpis.length
    ? Math.round(visibleKpis.reduce((sum, kpi) => sum + pct(kpi.current, kpi.target), 0) / visibleKpis.length)
    : null;
  const leaveStatus = leaveStatusData(leaves);
  const hasLeaveData = leaveStatus.some(status => status.value > 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon={Users} label="Total Employees" value={employees.length} sub={`${active.length} active`} color={T.primary} />
        <Stat icon={Clock} label="Attendance Overview" value={`${att.attended}/${att.total}`} sub={attendanceSummaryLabel(att)} color={T.secondary} />
        <Stat icon={Calendar} label="Employees on Approved Leave Today" value={approvedLeaveToday} sub="Approved leave in progress" color={T.warning} />
        <Stat icon={ListChecks} label="Pending Leave Requests" value={pending.length} sub="Awaiting review in Leave" color={T.danger} />
        <Stat icon={DollarSign} label="Total Payroll" value={fmt(totalPayroll)} sub={`${payroll.length} payroll records`} color={T.success} />
        <Stat
          icon={Target}
          label="KPI Average"
          value={ratingSummary.average === null ? "Not Rated" : `${ratingSummary.average}/10`}
          sub={`${ratingSummary.ratedCount}/${ratingSummary.totalCount} visible KPIs rated`}
          color={T.purple}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        {hasLeaveData
          ? <PieCard title="Leave Status" data={leaveStatus} />
          : (
            <Card title="Leave Status">
              <EmptyRow>No leave requests yet.</EmptyRow>
            </Card>
          )}
        <Card title="Recent Employees">
          {recentOf(employees).length === 0 ? <EmptyRow>No employees yet.</EmptyRow> :
            recentOf(employees).map(e => <EmployeeRow key={e.id} emp={e} sub={`${e.pos} · ${e.dept}`} />)}
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16 }}>
        <Card
          title="KPI Target Progress"
          right={<span style={{ fontSize: 12, color: T.muted }}>{averageProgress === null ? "No KPI data" : `${averageProgress}%`}</span>}
        >
          {averageProgress === null ? <EmptyRow>No KPI progress data yet.</EmptyRow> : (
            <div>
              <ProgressBar value={averageProgress} max={100} color={perfColor(averageProgress)} />
              <div style={{ color: T.muted, fontSize: 11, marginTop: 8 }}>
                Average target/current progress across {visibleKpis.length} visible KPI{visibleKpis.length === 1 ? "" : "s"}.
              </div>
            </div>
          )}
        </Card>

        <Card title="Pending Leave Requests">
          {recentPending.length === 0 ? <EmptyRow>No pending requests.</EmptyRow> :
            recentPending.map(leave => (
              <LeaveRow
                key={leave.id}
                l={leave}
                emp={employeeById.get(String(leave.empId))}
              />
            ))}
        </Card>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// MANAGER — scoped to their own department
// ─────────────────────────────────────────────────────────────────────────
const ManagerDashboard = ({ user, projects = [], employees, kpis, attendance = [], leaves }) => {
  const deptEmployees = scopeEmployees(user, employees);
  const activeEmployees = deptEmployees.filter(employee => employee.status === "active");
  const teamLeads = deptEmployees.filter(employee => employee.role === "tl");
  const deptLeaves = scopeByEmployee(user, leaves, employees);
  const pendingLeaves = deptLeaves.filter(leave => leave.status === "pending");
  const recentPendingLeaves = [...pendingLeaves]
    .sort((a, b) => {
      const bTime = new Date(b.applied || b.start || 0).getTime();
      const aTime = new Date(a.applied || a.start || 0).getTime();
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    })
    .slice(0, 6);
  const recentEmployees = recentOf(deptEmployees, 5);
  const employeeById = new Map(deptEmployees.map(employee => [String(employee.id), employee]));
  const deptKpis = scopeProjectKpis(user, kpis, projects, employees);
  const ratingSummary = getKpiRatingSummary(deptKpis);
  const averageProgress = deptKpis.length
    ? Math.round(deptKpis.reduce((sum, kpi) => sum + pct(kpi.current, kpi.target), 0) / deptKpis.length)
    : null;
  const att = getAttendanceSummary(
    deptEmployees,
    scopeAttendance(user, attendance, employees),
    new Date(),
  );
  const pendingTasks = deptKpis.filter(kpi =>
    kpi.status === "active"
    && (pct(kpi.current, kpi.target) < 100 || !isValidProjectKpiScore(kpi.rating)),
  ).length;

  const employeeRatings = deptEmployees.map(employee => {
    const employeeKpis = deptKpis.filter(kpi =>
      kpi.empId != null
      && employee.id != null
      && String(kpi.empId) === String(employee.id),
    );
    const summary = getKpiRatingSummary(employeeKpis);
    return {
      name: employee.name || employee.email || `Employee ${employee.id}`,
      rating: summary.average,
      ratedCount: summary.ratedCount,
    };
  }).filter(employee => employee.rating !== null);

  const currentMonth = new Date();
  const monthlyCompletion = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - (5 - index), 1);
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
      month: date.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
      values: [],
    };
  });
  const completionByMonth = new Map(monthlyCompletion.map(month => [month.key, month]));

  deptKpis.forEach(kpi => {
    const kpiDate = [kpi.ratedAt, kpi.updatedAt, kpi.createdAt]
      .filter(Boolean)
      .map(value => new Date(value))
      .find(date => !Number.isNaN(date.getTime()));
    const target = Number(kpi.target);
    const current = Number(kpi.current);

    if (!kpiDate || !Number.isFinite(target) || target <= 0 || !Number.isFinite(current) || current < 0) return;

    const monthKey = `${kpiDate.getFullYear()}-${String(kpiDate.getMonth() + 1).padStart(2, "0")}`;
    completionByMonth.get(monthKey)?.values.push(pct(current, target));
  });

  const monthlyData = monthlyCompletion.map(month => ({
    month: month.month,
    completion: month.values.length
      ? Math.round(month.values.reduce((sum, value) => sum + value, 0) / month.values.length)
      : 0,
    hasData: month.values.length > 0,
  }));
  const hasMonthlyData = monthlyData.some(month => month.hasData);

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 4 }}>{user.dept} Department</div>
        <div style={{ fontSize: 13, color: T.muted }}>Manager · {user.name}</div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon={Users} label="Department Employee Count" value={deptEmployees.length} sub={user.dept} color={T.primary} />
        <Stat icon={UserCog} label="Active Employees" value={activeEmployees.length} sub={`${deptEmployees.length - activeEmployees.length} inactive`} color={T.success} />
        <Stat icon={ShieldCheck} label="Team Leads" value={teamLeads.length} sub="In your department" color={T.secondary} />
        <Stat icon={Calendar} label="Pending Leave Requests" value={pendingLeaves.length} sub="Awaiting review in Leave" color={T.warning} />
        <Stat icon={Clock} label="Attendance Summary" value={`${att.attended}/${att.total}`} sub={attendanceSummaryLabel(att)} color={T.secondary} />
        <Stat icon={ListChecks} label="Pending KPI Tasks" value={pendingTasks} sub="Active, incomplete or unrated" color={T.danger} />
        <Stat
          icon={Target}
          label="Department KPI Average"
          value={ratingSummary.average === null ? "Not Rated" : `${ratingSummary.average}/10`}
          sub={`${ratingSummary.ratedCount}/${ratingSummary.totalCount} scoped KPIs rated`}
          color={T.purple}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card
          title="Employee KPI Rating Comparison"
          right={<span style={{ color: T.muted, fontSize: 11 }}>0–10 scale</span>}
        >
          {employeeRatings.length === 0 ? <EmptyRow>No valid employee KPI ratings yet.</EmptyRow> : (
            <ResponsiveContainer width="100%" height={Math.max(180, employeeRatings.length * 38)}>
              <BarChart data={employeeRatings} barSize={22} layout="vertical" margin={{ right: 42 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={false} />
                <XAxis type="number" domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={90} />
                <Tooltip
                  contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: T.text }}
                  formatter={(value, _name, item) => [`${value}/10 (${item.payload.ratedCount} rated)`, "Average rating"]}
                />
                <Bar dataKey="rating" fill={T.purple} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Monthly Productivity">
          {!hasMonthlyData ? <EmptyRow>No dated KPI completion data is available for the latest six months.</EmptyRow> : (
            <ResponsiveContainer width="100%" height={190}>
              <BarChart data={monthlyData} barSize={24}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                <XAxis dataKey="month" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={value => `${value}%`} />
                <Tooltip
                  contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: T.text }}
                  formatter={(value, _name, item) => [item.payload.hasData ? `${value}%` : "No data", "Average completion"]}
                />
                <Bar dataKey="completion" radius={[4, 4, 0, 0]}>
                  {monthlyData.map(month => <Cell key={month.month} fill={month.hasData ? T.secondary : T.border} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Card
          title="Department KPI Target Progress"
          right={<span style={{ color: T.muted, fontSize: 12 }}>{averageProgress === null ? "No KPI data" : `${averageProgress}%`}</span>}
        >
          {averageProgress === null ? <EmptyRow>No KPI progress data yet.</EmptyRow> : (
            <div>
              <ProgressBar value={averageProgress} max={100} color={perfColor(averageProgress)} />
              <div style={{ color: T.muted, fontSize: 11, marginTop: 8 }}>
                Average target/current completion across {deptKpis.length} scoped KPI{deptKpis.length === 1 ? "" : "s"}.
              </div>
            </div>
          )}
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card title="Recent Department Employees">
          {recentEmployees.length === 0 ? <EmptyRow>No department employees yet.</EmptyRow> :
            recentEmployees.map(employee => <EmployeeRow key={employee.id} emp={employee} sub={employee.pos} />)}
        </Card>
        <Card title="Pending Leave Requests">
          {recentPendingLeaves.length === 0 ? <EmptyRow>No pending requests.</EmptyRow> :
            recentPendingLeaves.map(leave => (
              <LeaveRow key={leave.id} l={leave} emp={employeeById.get(String(leave.empId))} />
            ))}
        </Card>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// TEAM LEAD — scoped to their own team (matched via employee.teamLeadId)
// ─────────────────────────────────────────────────────────────────────────
const TLDashboard = ({ user, projects = [], employees, kpis, attendance = [], leaves }) => {
  const team          = scopeEmployees(user, employees).filter(e => String(e.id) !== String(user.id));
  const teamLeaves    = scopeByEmployee(user, leaves, employees);
  const pendingLeaves = teamLeaves.filter(l => l.status === "pending");
  const teamKpis      = scopeProjectKpis(user, kpis, projects, employees);
  const ratingSummary = getKpiRatingSummary(teamKpis);
  const att            = getAttendanceSummary(
    team,
    scopeAttendance(user, attendance, employees),
    new Date(),
  );
  const pendingTasks   = teamKpis.filter(kpi =>
    String(kpi.status || "").trim().toLowerCase() === "active"
    && (pct(kpi.current, kpi.target) < 100 || !isValidProjectKpiScore(kpi.rating)),
  ).length;
  const taskProgress   = teamKpis.length ? Math.round(teamKpis.reduce((s, k) => s + pct(k.current, k.target), 0) / teamKpis.length) : 0;

  const employeeMetrics = team.map((employee) => {
    const employeeKpis = teamKpis.filter(kpi =>
      kpi.empId != null
      && employee.id != null
      && String(kpi.empId) === String(employee.id),
    );
    const employeeRating = getKpiRatingSummary(employeeKpis);
    const completion = employeeKpis.length
      ? Math.round(employeeKpis.reduce((sum, kpi) => sum + pct(kpi.current, kpi.target), 0) / employeeKpis.length)
      : 0;

    return {
      employee,
      completion,
      rating: employeeRating.average,
      ratedCount: employeeRating.ratedCount,
    };
  });
  const teamRatings = employeeMetrics
    .filter(metric => metric.rating !== null)
    .map(metric => ({
      name: metric.employee.name || metric.employee.email || `Employee ${metric.employee.id}`,
      rating: metric.rating,
      ratedCount: metric.ratedCount,
    }));

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 4 }}>My Team</div>
        <div style={{ fontSize: 13, color: T.muted }}>Team Lead · {user.name} · {user.dept}</div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon={Users}    label="Team Size"            value={team.length}                    sub={`${team.filter(e => e.status === "active").length} active`} color={T.primary}   />
        <Stat icon={Clock}    label="Team Attendance"      value={`${att.attended}/${att.total}`} sub={attendanceSummaryLabel(att)}                                color={T.secondary} />
        <Stat icon={Calendar} label="Pending Leave Requests" value={pendingLeaves.length}         sub="Awaiting your review"                                       color={T.warning}   />
        <Stat icon={Target}   label="Team KPI Rating"      value={ratingSummary.average === null ? "Not Rated" : `${ratingSummary.average}/10`} sub={`${ratingSummary.ratedCount}/${ratingSummary.totalCount} scoped KPIs rated`} color={T.purple} />
        <Stat icon={TrendingUp} label="Task Progress"      value={teamKpis.length ? `${taskProgress}%` : "—"} sub={`${pendingTasks} pending KPI task${pendingTasks === 1 ? "" : "s"}`} color={T.success} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card title="Team KPI Ratings" right={<span style={{ color: T.muted, fontSize: 11 }}>0–10 scale</span>}>
          {teamRatings.length === 0 ? <EmptyRow>No valid team KPI ratings yet.</EmptyRow> : (
            <ResponsiveContainer width="100%" height={Math.max(180, teamRatings.length * 38)}>
              <BarChart data={teamRatings} barSize={22} layout="vertical" margin={{ right: 42 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={false} />
                <XAxis type="number" domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={90} />
                <Tooltip
                  contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: T.text }}
                  formatter={(value, _name, item) => [`${value}/10 (${item.payload.ratedCount} rated)`, "Average rating"]}
                />
                <Bar dataKey="rating" fill={T.purple} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Employee Productivity">
          {employeeMetrics.length === 0 ? <EmptyRow>No team members assigned yet.</EmptyRow> : employeeMetrics.map(metric => (
              <div key={metric.employee.id} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: T.text }}>
                    {metric.employee.name || metric.employee.email || `Employee ${metric.employee.id}`}
                  </span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", fontSize: 12, fontWeight: 700 }}>
                    <span style={{ color: perfColor(metric.completion) }}>Completion {metric.completion}%</span>
                    <span style={{ color: T.purple }}>
                      Rating {metric.rating === null ? "Not Rated" : `${metric.rating}/10`}
                    </span>
                  </div>
                </div>
                <ProgressBar value={metric.completion} max={100} color={perfColor(metric.completion)} />
              </div>
            ))}
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
const EmployeeDashboard = ({ user, employees = [], projects = [], kpis, attendance = [], leaves, payroll, leaveBalances }) => {
  const myKpis   = scopeProjectKpis(user, kpis, projects, employees);
  const myLeaves = leaves.filter(leave =>
    leave.empId != null
    && user.id != null
    && String(leave.empId) === String(user.id),
  );
  const ratingSummary = getKpiRatingSummary(myKpis);
  const completionValues = myKpis
    .map(kpi => pct(kpi.current, kpi.target))
    .filter(Number.isFinite);
  const averageCompletion = completionValues.length
    ? Math.round(completionValues.reduce((sum, value) => sum + value, 0) / completionValues.length)
    : null;
  const projectById = new Map(
    projects
      .filter(project => project?.id != null)
      .map(project => [String(project.id), project]),
  );
  const myBal    = leaveBalances[user.id] || {};
  const annualLeft = myBal.Annual?.r ?? 15;
  const lastPayslip = payroll.find(record =>
    record.empId != null
    && user.id != null
    && String(record.empId) === String(user.id),
  );
  const completedTasks = myKpis.filter(k => pct(k.current, k.target) >= 100).length;
  const myAttendance = getEmployeeAttendanceRate(
    user.id,
    scopeAttendance(user, attendance, employees),
  );

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 4 }}>Welcome back, {user.name.split(" ")[0]} 👋</div>
        <div style={{ fontSize: 13, color: T.muted }}>{user.pos} · {user.dept}</div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat
          icon={Target}
          label="Project KPI Rating"
          value={ratingSummary.average === null ? "Not Rated" : `${ratingSummary.average}/10`}
          sub={`${ratingSummary.ratedCount}/${ratingSummary.totalCount} rated · ${averageCompletion === null ? "No target/current completion data" : `${averageCompletion}% average target/current completion`}`}
          color={T.purple}
        />
        <Stat icon={Calendar}   label="Leave Balance"     value={`${annualLeft} days`} sub="Annual leave remaining"                                            color={T.warning}          />
        <Stat icon={Clock}      label="Attendance %"      value={myAttendance.percentage === null ? "Not Marked" : `${myAttendance.percentage}%`} sub={myAttendance.total ? `${myAttendance.attended}/${myAttendance.total} present or late` : "No eligible attendance records"} color={T.secondary} />
        <Stat icon={DollarSign} label="My Payslips"       value={lastPayslip ? fmt(lastPayslip.net) : "—"} sub={lastPayslip ? `${lastPayslip.month} ${lastPayslip.year}` : "No payslip yet"} color={T.success} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card title="My KPIs — Performance">
          {myKpis.length === 0 ? <EmptyRow>No KPIs assigned yet.</EmptyRow> : myKpis.map(k => {
            const rawCompletion = pct(k.current, k.target);
            const p = Number.isFinite(rawCompletion) ? rawCompletion : 0;
            const hasValidProgress = Number.isFinite(Number(k.current))
              && Number(k.current) >= 0
              && Number.isFinite(Number(k.target))
              && Number(k.target) > 0;
            const project = k.projectId == null ? null : projectById.get(String(k.projectId));
            const projectTitle = project
              ? (project.title || project.name || "Untitled project")
              : "Legacy KPI";
            const hasValidRating = isValidProjectKpiScore(k.rating);
            const ratingText = hasValidRating
              ? `${Number(k.rating)}/10 · ${getProjectKpiRatingLabel(k.rating)}`
              : "Not Rated";
            return (
              <div key={k.id ?? k._docId ?? `${k.empId}-${k.projectId}`} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>
                      {k.title || "Untitled KPI"}
                    </div>
                    <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{projectTitle}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 12, color: perfColor(p), fontWeight: 700 }}>
                      Completion {p}%
                    </div>
                    <div style={{ fontSize: 11, color: hasValidRating ? T.purple : T.muted, marginTop: 2 }}>
                      Rating {ratingText}
                    </div>
                  </div>
                </div>
                <ProgressBar
                  value={hasValidProgress ? Number(k.current) : 0}
                  max={hasValidProgress ? Number(k.target) : 100}
                  color={perfColor(p)}
                />
                <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>
                  {k.current ?? "—"} / {k.target ?? "—"} · Weight: {k.weight ?? "—"}%
                </div>
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
