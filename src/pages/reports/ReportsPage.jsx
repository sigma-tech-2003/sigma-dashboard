import "./Reports.css";
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
import LoadErrorGate from "../../components/load-error/LoadErrorGate";
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
      <div key={status} className="report-bar">
        <div className="report-bar__head">
          <Badge s={status} />
          <span className="report-bar__count">{count}</span>
        </div>
        <ProgressBar value={count} max={total || 1} color={T.primary} label={`${title}: ${status}`} />
      </div>
    ))}
  </Card>
);

const ReportsPageContent = ({
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

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Read-only workforce, project, leave and KPI figures for your scope"
      />

      <div className="stat-grid stat-grid--compact" data-reveal>
        <Stat icon={Users} label="Employees in scope" value={scopedEmployees.length} sub="Visible in your role scope" color={T.primaryText} />
        <Stat icon={UserCheck} label="Active employees" value={activeEmployees.length} sub={`${scopedEmployees.length - activeEmployees.length} not active`} color={T.success} />
        <Stat icon={FolderKanban} label="Visible projects" value={scopedProjects.length} sub="Authorized project scope" color={T.secondary} />
        <Stat icon={Clock3} label="Pending leaves" value={pendingLeaves.length} sub="Awaiting review" color={T.warning} />
        <Stat icon={CheckCircle2} label="Approved leaves" value={approvedLeaves.length} sub="Approved requests" color={T.success} />
        <Stat icon={XCircle} label="Rejected leaves" value={rejectedLeaves.length} sub="Rejected requests" color={T.danger} />
        <Stat
          icon={Target}
          label="KPI rating average"
          value={ratingSummary.average === null ? "Not rated" : `${ratingSummary.average}/10`}
          sub={`${ratingSummary.ratedCount}/${ratingSummary.totalCount} scoped KPIs rated`}
          color={T.purple}
        />
        <Stat
          icon={TrendingUp}
          label="Average KPI completion"
          value={averageCompletion === null ? "No data" : `${averageCompletion}%`}
          sub={`${completionValues.length}/${scopedKpis.length} KPIs with usable progress`}
          color={T.secondary}
        />
        {canViewPayroll && (
          <Stat icon={DollarSign} label="Total payroll" value={fmt(totalPayroll)} sub="Net value from scoped records" color={T.success} />
        )}
        {canViewPayroll && (
          <Stat icon={ReceiptText} label="Payslips" value={scopedPayroll.length} sub="Scoped payroll records" color={T.primaryText} />
        )}
      </div>

      <div className="report-grid" data-reveal>
        <DistributionCard
          title="Employees by status"
          rows={employeeStatuses}
          total={scopedEmployees.length}
          emptyMessage="No employee status data"
        />
        <DistributionCard
          title="Projects by status"
          rows={projectStatuses}
          total={scopedProjects.length}
          emptyMessage="No project status data"
        />
        <DistributionCard
          title="Leaves by status"
          rows={leaveStatuses}
          total={scopedLeaves.length}
          emptyMessage="No leave status data"
        />
      </div>

      <div className="report-section" data-reveal>
        <Card title="KPI rating summary" right={<FileChartColumn size={16} color={T.muted} aria-hidden="true" />}>
          {scopedKpis.length === 0 ? (
            <EmptyState title="No KPI records" description="There are no KPI records in your current report scope." />
          ) : (
            <div className="report-kpi">
              <div>
                <div className="report-kpi__label">Valid rating average</div>
                <div className="report-kpi__value">
                  {ratingSummary.average === null ? "Not rated" : `${ratingSummary.average}/10`}
                </div>
                <div className="report-kpi__sub">
                  {ratingSummary.ratedCount} rated of {ratingSummary.totalCount} visible KPIs
                </div>
              </div>
              <div>
                <div className="report-kpi__row">
                  <span className="report-kpi__label">Target/current completion</span>
                  <span className="report-kpi__figure">
                    {averageCompletion === null ? "No data" : `${averageCompletion}%`}
                  </span>
                </div>
                {averageCompletion === null
                  ? <EmptyState title="No usable KPI progress" description="Valid target and current values are not available." />
                  : <ProgressBar value={averageCompletion} max={100} color={T.secondary} label="Average KPI completion" />}
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="section-head">
        <h2>Recent activity in your scope</h2>
      </div>

      <DataTable
        label="Recent activity"
        empty={recentActivity.length === 0 ? (
          <EmptyState title="No recent activity" description="No dated employee, project, leave or KPI records are available in your scope." />
        ) : null}
      >
        <thead>
          <tr>
            <th>Date</th>
            <th>Activity</th>
            <th>Subject</th>
            <th>Details</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {recentActivity.map((activity) => (
            <tr key={activity.key}>
              <td data-label="Date" style={{ whiteSpace: "nowrap", color: T.mutedLight }}>{fdate(activity.date)}</td>
              <td data-label="Activity">{activity.type}</td>
              <td data-primary style={{ fontWeight: 500 }}>{activity.subject}</td>
              <td data-label="Details" style={{ color: T.mutedLight }}>{activity.detail}</td>
              <td data-label="Status"><Badge s={activity.status} /></td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </div>
  );
};

// A failed load must not look like a report of zeros.
const ReportsPage = (props) => (
  <LoadErrorGate
    errors={props.dataErrors}
    required={{
      employees: props.employees,
      projects: props.projects,
      kpis: props.kpis,
      leaves: props.leaves,
      payroll: props.payroll,
    }}
  >
    <ReportsPageContent {...props} />
  </LoadErrorGate>
);

export default ReportsPage;
