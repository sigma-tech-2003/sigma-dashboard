// An employee's dashboard: their own month, nothing about anyone else. The same cards and motion as the management view.
import { useState } from "react";
import { CalendarDays, Plus, Target } from "lucide-react";
import Badge from "../../components/badge/Badge";
import Btn from "../../components/btn/Btn";
import CountUp from "../../components/count-up/CountUp";
import EmptyState from "../../components/empty-state/EmptyState";
import ProgressBar from "../../components/ProgressBar/ProgressBar";
import { getEmployeeAttendanceRate } from "../../utils/attendanceSummary";
import { fmt, getProjectKpiRatingLabel, isValidProjectKpiScore, perfColor, pct } from "../../utils/helpers";
import { totalTakenLabel, totalTakenSub } from "../../utils/leaveUsage";
import { scopeAttendance, scopeProjectKpis } from "../../utils/permissions";
import { greetingFor, longDate, formatRange } from "./dashboardData";
import Greeting from "./widgets/Greeting";

const EmployeeDashboard = ({ user, employees = [], projects = [], kpis = [], attendance = [], leaves = [], payroll = [], leaveBalances = {}, navigate }) => {
  const [now] = useState(() => new Date());
  const myKpis = scopeProjectKpis(user, kpis, projects, employees);
  const myLeaves = leaves
    .filter((leave) => leave.empId != null && String(leave.empId) === String(user.id))
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));
  const balance = leaveBalances[user.id] || {};
  const attendanceRate = getEmployeeAttendanceRate(user.id, scopeAttendance(user, attendance, employees));
  const latestPayslip = payroll.find((record) => record.empId != null && String(record.empId) === String(user.id));
  const projectById = new Map(projects.filter((project) => project?.id != null).map((project) => [String(project.id), project]));
  const first = (user.name || "").split(" ")[0] || "there";
  const pending = myLeaves.filter((leave) => leave.status === "pending").length;

  return (
    <div className="dash">
      <Greeting greeting={greetingFor(now)} name={first} date={longDate(now)}>
        {[user.pos, user.dept].filter(Boolean).join(" · ")}
        {pending > 0 && <>. <b>{pending} leave {pending === 1 ? "request is" : "requests are"}</b> waiting for a decision.</>}
      </Greeting>

      <div className="dash-grid">
        <section className="card dash-span-5" aria-labelledby="monthTitle">
          <div className="sh"><h2 id="monthTitle">Your month</h2></div>
          <dl className="mine">
            <div><dt>Attendance</dt><dd><CountUp value={attendanceRate.percentage === null ? "Not marked" : `${attendanceRate.percentage}%`} className="mine__n" /><small>{attendanceRate.total ? `${attendanceRate.attended} of ${attendanceRate.total} ${attendanceRate.total === 1 ? "day" : "days"} present or late` : "No attendance records yet"}</small></dd></div>
            <div><dt>Leave taken</dt><dd><CountUp value={totalTakenLabel(balance)} className="mine__n" /><small>{totalTakenSub(balance)}</small></dd></div>
            <div><dt>Latest payslip</dt><dd><CountUp value={latestPayslip ? fmt(latestPayslip.net) : "—"} className="mine__n" /><small>{latestPayslip ? `${latestPayslip.month} ${latestPayslip.year}` : "No payslip yet"}</small></dd></div>
          </dl>
          <Btn onClick={() => navigate("leave")}><Plus size={16} aria-hidden="true" />Request leave</Btn>
        </section>

        <section className="card dash-span-7" aria-labelledby="kpiTitle">
          <div className="sh"><h2 id="kpiTitle">Your KPIs</h2><span>{myKpis.length} assigned</span></div>
          {myKpis.length === 0 ? (
            <EmptyState icon={Target} title="No KPIs yet" description="KPIs assigned to you, with your progress and rating, will show here." />
          ) : (
            <ul className="kpis">
              {myKpis.map((kpi) => {
                const rawCompletion = pct(kpi.current, kpi.target);
                const completion = Number.isFinite(rawCompletion) ? rawCompletion : 0;
                const project = kpi.projectId == null ? null : projectById.get(String(kpi.projectId));
                const rated = isValidProjectKpiScore(kpi.rating);
                return (
                  <li key={kpi.id ?? kpi._docId ?? `${kpi.empId}-${kpi.projectId}`} className="kpis__row">
                    <div className="kpis__head">
                      <div><b>{kpi.title || "Untitled KPI"}</b><small>{project ? (project.title || project.name) : "Legacy KPI"}</small></div>
                      <div className="kpis__right"><b className="num" style={{ color: perfColor(completion) }}>{completion}%</b><small>{rated ? `${Number(kpi.rating)}/10 · ${getProjectKpiRatingLabel(kpi.rating)}` : "Not rated"}</small></div>
                    </div>
                    <ProgressBar value={Number(kpi.current) || 0} max={Number(kpi.target) > 0 ? Number(kpi.target) : 100} color={perfColor(completion)} label={`${kpi.title || "KPI"} progress`} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card dash-span-12" data-reveal aria-labelledby="leaveTitle">
          <div className="sh"><h2 id="leaveTitle">Your leave requests</h2><span>{myLeaves.length} in total</span></div>
          {myLeaves.length === 0 ? (
            <EmptyState icon={CalendarDays} title="You have not asked for leave yet" description="Requests you send are listed here with their status.">
              <Btn onClick={() => navigate("leave")}><Plus size={16} aria-hidden="true" />Request leave</Btn>
            </EmptyState>
          ) : (
            <ul className="requests">
              {myLeaves.slice(0, 6).map((leave) => (
                <li key={leave.id} className="requests__row">
                  <div><b>{leave.type} leave</b><small>{formatRange(String(leave.start).slice(0, 10), String(leave.end).slice(0, 10))} · {leave.days} {leave.days === 1 ? "day" : "days"}</small></div>
                  <Badge s={leave.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

export default EmployeeDashboard;
