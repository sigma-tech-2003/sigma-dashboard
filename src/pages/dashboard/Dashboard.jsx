// src/pages/dashboard/Dashboard.jsx
// The dashboard of an HR product, in the order an HR person thinks: what needs me, who is here today, who is away and
// when, then money, people and performance. Admin, HR, managers and team leads share these widgets over the people
// each can see; an employee gets a page about their own month (EmployeeDashboard).
import "./Dashboard.css";
import { useState } from "react";

import LoadErrorGate from "../../components/load-error/LoadErrorGate";
import { useToast } from "../../components/toast/toastContext";
import { can, scopeAttendance, scopeByEmployee, scopeEmployees, scopeProjectKpis } from "../../utils/permissions";
import { guardedSave } from "../../utils/saveErrors";
import { payrollTrend } from "../../utils/payrollTrend";
import {
  awaitingRating, awayCalendar, decisionItems, greetingFor, longDate, payrollNeed, payrollSnapshot,
  peopleSnapshot, performanceSnapshot, presenceToday, weekAhead,
} from "./dashboardData";
import EmployeeDashboard from "./EmployeeDashboard";
import AwayCalendar from "./widgets/AwayCalendar";
import Greeting from "./widgets/Greeting";
import HereToday from "./widgets/HereToday";
import NeedsYou from "./widgets/NeedsYou";
import { PayrollCard, PeopleCard, PerformanceCard } from "./widgets/SnapshotCards";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The people a role can see and act on, as the rest of the app already scopes them.
const scopeFor = (props) => {
  const { user, employees = [], leaves = [], attendance = [], kpis = [], projects = [] } = props;
  const scopedEmployees = user.role === "tl"
    ? scopeEmployees(user, employees).filter((employee) => String(employee.id) !== String(user.id))
    : scopeEmployees(user, employees);
  const scopedLeaves = scopeByEmployee(user, leaves, employees)
    .filter((leave) => user.role !== "tl" || String(leave.empId) !== String(user.id));

  return {
    employees: scopedEmployees,
    leaves: scopedLeaves,
    attendance: scopeAttendance(user, attendance, employees),
    kpis: scopeProjectKpis(user, kpis, projects, employees),
  };
};

const ManagementDashboard = (props) => {
  const { user, payroll = [], updateLeaveStatus, navigate } = props;
  const toast = useToast();
  const [now] = useState(() => new Date());
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState("");

  const scope = scopeFor(props);
  const canDecide = can(user, "approveLeave");
  const seesPayroll = user.role === "admin" || user.role === "hr";

  // Nobody decides their own leave (the server refuses it), so it is not offered here.
  const decisions = canDecide
    ? decisionItems(scope.leaves.filter((leave) => String(leave.empId) !== String(user.id)), scope.employees, now)
    : [];
  const awaiting = awaitingRating(scope.kpis, scope.employees);
  const payrollItem = seesPayroll ? payrollNeed(payroll, now) : null;
  const items = [
    ...decisions,
    ...(awaiting.length ? [{
      kind: "review",
      key: "review",
      title: `${plural(awaiting.reduce((sum, row) => sum + row.unrated, 0), "KPI is", "KPIs are")} waiting for a rating`,
      note: awaiting.slice(0, 2).map((row) => row.employee.name).join(" and ") + (awaiting.length > 2 ? ` and ${awaiting.length - 2} more` : ""),
    }] : []),
    ...(payrollItem ? [payrollItem] : []),
  ];

  const presence = presenceToday(scope.employees, scope.attendance, now);
  const week = weekAhead(scope.employees, scope.leaves, presence, now);
  const calendar = awayCalendar(scope.leaves, scope.employees, now);
  const people = peopleSnapshot(scope.employees, now);
  const performance = performanceSnapshot(scope.kpis, scope.employees);
  const outThisWeek = calendar.rows.filter((row) => row.bars.some((bar) => bar.status === "approved" && bar.start <= 6)).length;

  const decide = async (item, approve) => {
    if (busyKey) return;
    setBusyKey(item.key);
    setError("");
    const result = await guardedSave(() => updateLeaveStatus(item.id, approve ? "approved" : "rejected"), { fallback: "The decision could not be saved. Please try again." });
    setBusyKey(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    toast.success(`${approve ? "Approved" : "Declined"} ${item.employee.name}'s leave`);
  };

  const approveAll = async () => {
    if (busyKey) return;
    setBusyKey("all");
    setError("");
    let done = 0;
    for (const item of decisions) {
      const result = await guardedSave(() => updateLeaveStatus(item.id, "approved"), { fallback: "The decision could not be saved. Please try again." });
      if (!result.ok) {
        setError(result.message);
        break;
      }
      done += 1;
    }
    setBusyKey(null);
    if (done) toast.success(`Approved ${plural(done, "leave request", "leave requests")}`);
  };

  const first = (user.name || "").split(" ")[0] || "there";

  return (
    <div className="dash">
      <Greeting now={now} greeting={greetingFor(now)} name={first} date={longDate(now)}>
        {decisions.length > 0 ? <><b>{plural(decisions.length, "leave request", "leave requests")}</b> {decisions.length === 1 ? "is" : "are"} waiting for you. </> : canDecide ? <><b>No leave requests</b> are waiting. </> : null}
        {presence.counts.total > 0 && <><b>{presence.counts.in} of {presence.counts.total}</b> people are in today{outThisWeek > 0 ? `, and ${outThisWeek} will be out this week` : ""}.</>}
      </Greeting>

      <div className="dash-grid">
        <div className="dash-span-7"><NeedsYou items={items} busyKey={busyKey} error={error} onDecide={decide} onApproveAll={approveAll} navigate={navigate} /></div>
        <div className="dash-span-5"><HereToday presence={presence} week={week} /></div>
        <div className="dash-span-12" data-reveal><AwayCalendar calendar={calendar} /></div>
        {seesPayroll && <div className="dash-span-4" data-reveal><PayrollCard snapshot={payrollSnapshot(payroll, now)} trend={payrollTrend(payroll, now)} navigate={navigate} /></div>}
        <div className={seesPayroll ? "dash-span-4" : "dash-span-6"} data-reveal><PeopleCard snapshot={people} label={user.role === "tl" ? "My team" : "People"} /></div>
        <div className={seesPayroll ? "dash-span-4" : "dash-span-6"} data-reveal><PerformanceCard snapshot={performance} awaiting={awaiting} navigate={navigate} /></div>
      </div>
    </div>
  );
};

const RoleDashboard = (props) => (props.user.role === "employee" ? <EmployeeDashboard {...props} /> : <ManagementDashboard {...props} />);

// The collections each role's dashboard cannot do without. If one of these failed to LOAD and has nothing to
// show, every figure derived from it would read as zero, so the dashboard says so instead of rendering them.
// Collections a role cannot read at all (payroll for a manager) never error and are simply empty.
const REQUIRED_COLLECTIONS = {
  admin:    ["employees", "projects", "kpis", "attendance", "leaves", "payroll"],
  hr:       ["employees", "projects", "kpis", "attendance", "leaves", "payroll"],
  manager:  ["employees", "projects", "kpis", "attendance", "leaves"],
  tl:       ["employees", "projects", "kpis", "attendance", "leaves"],
  employee: ["employees", "projects", "kpis", "attendance", "leaves", "payroll"],
};

const Dashboard = (props) => {
  const names = REQUIRED_COLLECTIONS[props.user.role] ?? REQUIRED_COLLECTIONS.admin;
  const required = Object.fromEntries(names.map((name) => [name, props[name]]));
  // Secondary: a failure here is flagged but never blanks the page. (leaveBalances is a map, not a list.)
  const optional = { departments: props.departments, leaveBalances: Object.values(props.leaveBalances ?? {}) };

  return (
    <LoadErrorGate errors={props.dataErrors} required={required} optional={optional}>
      <RoleDashboard {...props} />
    </LoadErrorGate>
  );
};

export default Dashboard;
