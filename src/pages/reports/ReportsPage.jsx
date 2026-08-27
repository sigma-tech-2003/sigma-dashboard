import {
  CheckCircle2,
  Clock3,
  DollarSign,
  FileChartColumn,
  FolderKanban,
  ReceiptText,
  Target,
  TrendingUp,
  UserCheck,
  Users,
  XCircle,
} from "lucide-react";

import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  ProgressBar,
} from "../../components";
import Stat from "../../components/stat/Stat";
import { fdate, fmt, getKpiRatingSummary, pct } from "../../utils/helpers";
import {
  scopeByEmployee,
  scopeEmployees,
  scopeProjectKpis,
  scopeProjects,
} from "../../utils/permissions";
import { T } from "../../theme/theme";

const normalizeStatus = (status) => String(status || "unknown").toLowerCase();

const statusDistribution = (records) => {
  const counts = new Map();

  records.forEach((record) => {
    const status = normalizeStatus(record.status);
    counts.set(status, (counts.get(status) || 0) + 1);
  });

  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
};

const validDate = (...values) => {
  for (const value of values) {
    if (!value) continue;
    const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
};

const DistributionCard = ({ title, rows, total, emptyMessage }) => (
  <Card title={title}>
    {rows.length === 0 ? (
      <EmptyState title={emptyMessage} description="No scoped records are available for this report." />
    ) : rows.map(({ status, count }) => (
      <div key={status} style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
          <Badge s={status} />
          <span style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>{count}</span>
        </div>
        <ProgressBar value={count} max={total || 1} color={T.primary} />
      </div>
    ))}
  </Card>
);

const ReportsPage = ({
  user,
  employees = [],
  projects = [],
  kpis = [],
  leaves = [],
  payroll = [],
}) => {
  const scopedEmployees = scopeEmployees(user, employees);
  const scopedProjects = scopeProjects(user, projects, employees);
  const scopedKpis = scopeProjectKpis(user, kpis, projects, employees);
  const scopedLeaves = scopeByEmployee(user, leaves, employees);
  const canViewPayroll = user.role === "admin" || user.role === "hr";
  const scopedPayroll = canViewPayroll
    ? scopeByEmployee(user, payroll, employees)
    : [];

  const activeEmployees = scopedEmployees.filter((employee) =>
    normalizeStatus(employee.status) === "active",
  );
  const pendingLeaves = scopedLeaves.filter((leave) => normalizeStatus(leave.status) === "pending");
  const approvedLeaves = scopedLeaves.filter((leave) => normalizeStatus(leave.status) === "approved");
  const rejectedLeaves = scopedLeaves.filter((leave) => normalizeStatus(leave.status) === "rejected");
  const ratingSummary = getKpiRatingSummary(scopedKpis);
  const completionValues = scopedKpis.reduce((values, kpi) => {
    const target = Number(kpi.target);
    const current = Number(kpi.current);
    if (Number.isFinite(target) && target > 0 && Number.isFinite(current) && current >= 0) {
      values.push(pct(current, target));
    }
    return values;
  }, []);
  const averageCompletion = completionValues.length
    ? Math.round(completionValues.reduce((sum, value) => sum + value, 0) / completionValues.length)
    : null;
  const totalPayroll = scopedPayroll.reduce((sum, record) => sum + (Number(record.net) || 0), 0);

  const employeeStatuses = statusDistribution(scopedEmployees);
  const projectStatuses = statusDistribution(scopedProjects);
  const leaveStatuses = statusDistribution(scopedLeaves);
  const employeeById = new Map(
    scopedEmployees
      .filter((employee) => employee.id != null)
      .map((employee) => [String(employee.id), employee]),
  );
  const projectById = new Map(
    scopedProjects
      .filter((project) => project.id != null)
      .map((project) => [String(project.id), project]),
  );

  const activityRecords = [
    ...scopedEmployees.map((employee) => ({
      sourceId: employee.id,
      date: validDate(employee.joinDate),
      type: "Employee",
      subject: employee.name || employee.email || "Unnamed employee",
      detail: [employee.pos, employee.dept].filter(Boolean).join(" · ") || "Employee joined",
      status: employee.status || "unknown",
    })),
    ...scopedProjects.map((project) => ({
      sourceId: project.id ?? project._docId,
      date: validDate(project.updatedAt, project.createdAt, project.startDate),
      type: "Project",
      subject: project.title || project.name || "Untitled project",
      detail: project.department || "No department",
      status: project.status || "unknown",
    })),
    ...scopedLeaves.map((leave) => ({
      sourceId: leave.id ?? leave._docId,
      date: validDate(leave.applied, leave.createdAt, leave.start),
      type: "Leave",
      subject: employeeById.get(String(leave.empId))?.name || "Unknown employee",
      detail: `${leave.type || "Leave"}${leave.days ? ` · ${leave.days} day${leave.days === 1 ? "" : "s"}` : ""}`,
      status: leave.status || "unknown",
    })),
    ...scopedKpis.map((kpi) => {
      const project = kpi.projectId == null ? null : projectById.get(String(kpi.projectId));
      return {
        sourceId: kpi.id ?? kpi._docId,
        date: validDate(kpi.ratedAt, kpi.updatedAt, kpi.createdAt),
        type: "KPI",
        subject: employeeById.get(String(kpi.empId))?.name || "Unknown employee",
        detail: `${kpi.title || "Untitled KPI"} · ${project?.title || project?.name || (kpi.projectId == null ? "Legacy KPI" : "Project unavailable")}`,
        status: kpi.status || "unknown",
      };
    }),
  ];
  const recentActivity = activityRecords
    .filter((activity) => activity.date)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, 10)
    .map((activity, index) => ({
      ...activity,
      key: `${activity.type}-${activity.sourceId ?? "record"}-${index}`,
    }));

  const headerCellStyle = {
    padding: "12px 16px",
    color: T.muted,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.8,
    textAlign: "left",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };
  const cellStyle = {
    padding: "14px 16px",
    color: T.mutedLight,
    fontSize: 13,
  };

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Read-only workforce, project, leave, KPI, and operational insights for your scope."
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14, marginBottom: 20 }}>
        <Stat icon={Users} label="Scoped Employees" value={scopedEmployees.length} sub="Visible in your role scope" color={T.primary} />
        <Stat icon={UserCheck} label="Active Employees" value={activeEmployees.length} sub={`${scopedEmployees.length - activeEmployees.length} not active`} color={T.success} />
        <Stat icon={FolderKanban} label="Visible Projects" value={scopedProjects.length} sub="Authorized project scope" color={T.secondary} />
        <Stat icon={Clock3} label="Pending Leaves" value={pendingLeaves.length} sub="Awaiting review" color={T.warning} />
        <Stat icon={CheckCircle2} label="Approved Leaves" value={approvedLeaves.length} sub="Approved requests" color={T.success} />
        <Stat icon={XCircle} label="Rejected Leaves" value={rejectedLeaves.length} sub="Rejected requests" color={T.danger} />
        <Stat
          icon={Target}
          label="KPI Rating Average"
          value={ratingSummary.average === null ? "Not Rated" : `${ratingSummary.average}/10`}
          sub={`${ratingSummary.ratedCount}/${ratingSummary.totalCount} scoped KPIs rated`}
          color={T.purple}
        />
        <Stat
          icon={TrendingUp}
          label="Average KPI Completion"
          value={averageCompletion === null ? "No Data" : `${averageCompletion}%`}
          sub={`${completionValues.length}/${scopedKpis.length} KPIs with usable progress`}
          color={T.secondary}
        />
        {canViewPayroll && (
          <Stat icon={DollarSign} label="Total Payroll" value={fmt(totalPayroll)} sub="Net value from scoped records" color={T.success} />
        )}
        {canViewPayroll && (
          <Stat icon={ReceiptText} label="Payslip Count" value={scopedPayroll.length} sub="Scoped payroll records" color={T.primary} />
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 16 }}>
        <DistributionCard
          title="Employee Status Distribution"
          rows={employeeStatuses}
          total={scopedEmployees.length}
          emptyMessage="No employee status data"
        />
        <DistributionCard
          title="Project Status Distribution"
          rows={projectStatuses}
          total={scopedProjects.length}
          emptyMessage="No project status data"
        />
        <DistributionCard
          title="Leave Status"
          rows={leaveStatuses}
          total={scopedLeaves.length}
          emptyMessage="No leave status data"
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <Card title="KPI Rating Summary" right={<FileChartColumn size={16} color={T.muted} />}>
          {scopedKpis.length === 0 ? (
            <EmptyState title="No KPI records available" description="There are no KPI records in your current report scope." />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 18, alignItems: "center" }}>
              <div>
                <div style={{ color: T.muted, fontSize: 11, marginBottom: 6 }}>Valid rating average</div>
                <div style={{ color: T.text, fontSize: 26, fontWeight: 800 }}>
                  {ratingSummary.average === null ? "Not Rated" : `${ratingSummary.average}/10`}
                </div>
                <div style={{ color: T.muted, fontSize: 12, marginTop: 5 }}>
                  {ratingSummary.ratedCount} rated of {ratingSummary.totalCount} visible KPIs
                </div>
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 7 }}>
                  <span style={{ color: T.muted, fontSize: 12 }}>Target/current completion</span>
                  <span style={{ color: T.text, fontSize: 12, fontWeight: 700 }}>
                    {averageCompletion === null ? "No Data" : `${averageCompletion}%`}
                  </span>
                </div>
                {averageCompletion === null
                  ? <EmptyState title="No usable KPI progress" description="Valid target and current values are not available." />
                  : <ProgressBar value={averageCompletion} max={100} color={T.secondary} />}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Recent Scoped Activity">
        {recentActivity.length === 0 ? (
          <EmptyState title="No recent activity" description="No dated employee, project, leave, or KPI records are available in your scope." />
        ) : (
          <DataTable>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {["Date", "Activity", "Subject", "Details", "Status"].map((heading) => (
                  <th key={heading} style={headerCellStyle}>{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentActivity.map((activity) => (
                <tr key={activity.key} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>{fdate(activity.date)}</td>
                  <td style={{ ...cellStyle, color: T.text, fontWeight: 700 }}>{activity.type}</td>
                  <td style={{ ...cellStyle, color: T.text }}>{activity.subject}</td>
                  <td style={cellStyle}>{activity.detail}</td>
                  <td style={cellStyle}><Badge s={activity.status} /></td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
    </div>
  );
};

export default ReportsPage;
