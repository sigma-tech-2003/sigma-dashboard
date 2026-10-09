import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { fakeApi } from "../test-support/fakes.js";
import { createAttendanceService } from "./attendanceService.js";
import { createDepartmentService } from "./departmentService.js";
import { departmentDirectory } from "./departmentDirectory.js";
import { createEmployeeService } from "./employeeService.js";
import { createKpiService } from "./kpiService.js";
import { createLeaveBalanceService } from "./leaveBalanceService.js";
import { createLeaveService } from "./leaveService.js";
import { createPayrollService } from "./payrollService.js";
import { createProjectService } from "./projectService.js";
import { MappingError } from "./mappers/common.js";

const DEPT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EMP = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

beforeEach(() => departmentDirectory.clear());

const EMPLOYEE_ROW = {
  id: EMP, department_id: DEPT, department_name: "Engineering", team_lead_id: null, employee_number: "EMP-1",
  full_name: "Aisha Khan", phone: null, position_title: "Engineer", employment_status: "active",
  joined_on: "2024-03-15", basic: 100, allowances: 10, role: "employee", email: "a@b.co", created_at: "t", updated_at: "t",
};

// ---- the common behaviour, through the attendance service (the plainest one) --------------------------------

const ATTENDANCE_ROW = { id: "a1", employee_id: EMP, work_date: "2026-03-02", status: "present", check_in: "09:00", check_out: "17:00", notes: null, created_at: "t", updated_at: "t" };

test("list GETs the collection and returns page-shaped records, each with _docId", async () => {
  const api = fakeApi(() => [ATTENDANCE_ROW]);
  const records = await createAttendanceService(api).list();

  assert.deepEqual(api.calls, [{ method: "GET", path: "/attendance", query: undefined }]);
  assert.equal(records[0].empId, EMP);
  assert.equal(records[0].date, "2026-03-02");
  assert.equal(records[0]._docId, "a1");
  assert.equal(records[0].id, "a1");
});

test("create sends the mapped body WITHOUT the page's Date.now() id or timestamps, and returns the SERVER's record", async () => {
  const api = fakeApi(() => ({ ...ATTENDANCE_ROW, id: "server-made-id" }));
  const record = await createAttendanceService(api).create({
    id: 1760000000000, empId: EMP, date: "2026-03-02", status: "present", checkIn: "09:00", checkOut: "17:00",
    notes: "", createdAt: "x", updatedAt: "x",
  });

  assert.deepEqual(api.calls[0].body, {
    employee_id: EMP, work_date: "2026-03-02", status: "present", check_in: "09:00", check_out: "17:00", notes: null,
  });
  assert.equal(record.id, "server-made-id", "the id the caller gets back is the server's");
  assert.notEqual(record.id, 1760000000000);
});

test("update sends only what changed against the original", async () => {
  const api = fakeApi(() => ({ ...ATTENDANCE_ROW, status: "late" }));
  const service = createAttendanceService(api);
  const original = service.read(ATTENDANCE_ROW);

  await service.update("a1", { ...original, status: "late" }, { original });

  assert.deepEqual(api.calls, [{ method: "PATCH", path: "/attendance/a1", body: { status: "late" }, options: undefined }]);
});

test("update with nothing changed sends no request and resolves the original", async () => {
  const api = fakeApi();
  const service = createAttendanceService(api);
  const original = service.read(ATTENDANCE_ROW);

  const result = await service.update("a1", { ...original }, { original });

  assert.equal(api.calls.length, 0);
  assert.equal(result, original);
});

test("remove DELETEs the record", async () => {
  const api = fakeApi();
  await createAttendanceService(api).remove("a1");

  assert.equal(api.calls[0].method, "DELETE");
  assert.equal(api.calls[0].path, "/attendance/a1");
});

test("get reads one record", async () => {
  const api = fakeApi(() => ATTENDANCE_ROW);
  assert.equal((await createAttendanceService(api).get("a1"))._docId, "a1");
});

// ---- employees + the department directory (D33) ----------------------------------------------------------------

test("listing employees teaches the directory their department names, so a manager can write later", async () => {
  const service = createEmployeeService(fakeApi(() => [EMPLOYEE_ROW]));
  await service.list();

  assert.deepEqual(departmentDirectory.lookup(), [{ id: DEPT, name: "Engineering" }]);
});

test("create resolves the department NAME through the directory", async () => {
  departmentDirectory.learn([{ id: DEPT, name: "Engineering" }]);
  const api = fakeApi(() => EMPLOYEE_ROW);
  await createEmployeeService(api).create({
    name: "New Hire", email: "n@b.co", dept: "Engineering", pos: "Dev", joinDate: "2026-09-25", basic: 1, allowances: 0, role: "employee", status: "inactive",
  });

  assert.equal(api.calls[0].body.department_id, DEPT);
  assert.equal(api.calls[0].body.employment_status, "inactive");
});

test("create for a department nobody has told the directory about is a MappingError, not a silent drop", async () => {
  const service = createEmployeeService(fakeApi(() => EMPLOYEE_ROW));

  await assert.rejects(
    service.create({ name: "A", email: "a@b.co", dept: "Atlantis", pos: "p", joinDate: "2026-01-01", basic: 1, allowances: 0, role: "employee" }),
    (error) => error instanceof MappingError && error.code === "unknown-department",
  );
});

test("a manager editing an unrelated field sends no department, even though the directory could not resolve one", async () => {
  const api = fakeApi(() => EMPLOYEE_ROW);
  const service = createEmployeeService(api);
  const original = service.read(EMPLOYEE_ROW);

  await service.update(EMP, { ...original, pos: "Lead" }, { original });

  assert.deepEqual(api.calls[0].body, { position_title: "Lead" });
});

test("remove sends the replacement team lead when given (the reassignment call)", async () => {
  const api = fakeApi();
  await createEmployeeService(api).remove(EMP, { replacementTeamLeadId: "r1" });

  assert.deepEqual(api.calls[0], { method: "DELETE", path: `/employees/${EMP}`, body: { replacement_team_lead_id: "r1" }, options: undefined });
});

test("remove without a replacement sends an empty body", async () => {
  const api = fakeApi();
  await createEmployeeService(api).remove(EMP);

  assert.deepEqual(api.calls[0].body, {});
});

test("issuePasswordSetupLink POSTs the token endpoint and returns the token and expiry", async () => {
  const api = fakeApi(() => ({ token: "tok", expiresAt: "2026-10-10T00:00:00Z" }));
  const result = await createEmployeeService(api).issuePasswordSetupLink(EMP);

  assert.equal(api.calls[0].path, `/employees/${EMP}/password-token`);
  assert.deepEqual(result, { token: "tok", expiresAt: "2026-10-10T00:00:00Z" });
});

// ---- departments, projects -----------------------------------------------------------------------------------------

test("listing departments teaches the directory (admin and hr, who can read the list)", async () => {
  const service = createDepartmentService(fakeApi(() => [{ id: DEPT, name: "Finance", description: null, status: "active", manager_employee_id: null, created_at: "t", updated_at: "t" }]));
  const [department] = await service.list();

  assert.equal(department.status, "Active");
  assert.deepEqual(departmentDirectory.lookup(), [{ id: DEPT, name: "Finance" }]);
});

test("department create sends 'active' for 'Active' and drops the page's id and createdAt", async () => {
  const api = fakeApi(() => ({ id: DEPT, name: "Ops", description: null, status: "active", manager_employee_id: null, created_at: "t", updated_at: "t" }));
  await createDepartmentService(api).create({ id: Date.now(), name: "Ops", description: "", status: "Active", createdAt: "x" });

  assert.deepEqual(api.calls[0].body, { name: "Ops", description: null, status: "active" });
});

test("project create resolves the department and returns the server's id", async () => {
  departmentDirectory.learn([{ id: DEPT, name: "Engineering" }]);
  const api = fakeApi(() => ({ id: "p-server", department_id: DEPT, department_name: "Engineering", team_lead_id: null, title: "T", description: "", start_date: "2026-01-01", due_date: "2026-02-01", status: "active", assignedEmployeeIds: [EMP], created_at: "t", updated_at: "t" }));
  const project = await createProjectService(api).create({
    id: Date.now(), title: "T", department: "Engineering", assignedEmployeeIds: [EMP], startDate: "2026-01-01", dueDate: "2026-02-01", status: "active",
  });

  assert.equal(api.calls[0].body.department_id, DEPT);
  assert.equal(Object.hasOwn(api.calls[0].body, "id"), false);
  assert.equal(project.id, "p-server");
  assert.equal(project.department, "Engineering");
});

// ---- KPIs: the rating split ------------------------------------------------------------------------------------

const KPI_ROW = { id: "k1", project_id: "p1", employee_id: EMP, title: "T", target: 10, current_value: 1, weight: 5, period: "Q1", status: "active", rating: null, rated_by_employee_id: null, rated_at: null, created_at: "t", updated_at: "t" };

test("a KPI update that carries only a rating is ONE call to POST /kpis/:id/rating, and no PATCH", async () => {
  const api = fakeApi(() => ({ ...KPI_ROW, rating: 8, rated_by_employee_id: "m1", rated_at: "t" }));
  const service = createKpiService(api);
  const original = service.read(KPI_ROW);

  const result = await service.update("k1", { rating: 8, ratedBy: "m1", ratedAt: "2026-03-31T00:00:00Z" }, { original });

  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["POST /kpis/k1/rating"]);
  assert.deepEqual(api.calls[0].body, { rating: 8 });
  assert.equal(result.rating, 8);
  assert.equal(result.ratedBy, "m1", "the rater recorded is the server's, not what the page sent");
});

test("a KPI update that carries only progress is ONE PATCH, and no rating call", async () => {
  const api = fakeApi(() => ({ ...KPI_ROW, current_value: 7 }));
  const service = createKpiService(api);
  const original = service.read(KPI_ROW);

  await service.update("k1", { current: 7 }, { original });

  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["PATCH /kpis/k1"]);
  assert.deepEqual(api.calls[0].body, { current_value: 7 });
});

test("both progress and rating make both calls, PATCH first", async () => {
  const api = fakeApi(() => KPI_ROW);
  const service = createKpiService(api);
  await service.update("k1", { current: 3, rating: 5 }, { original: service.read(KPI_ROW) });

  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["PATCH /kpis/k1", "POST /kpis/k1/rating"]);
});

test("a null rating is not a rating call", async () => {
  const api = fakeApi(() => KPI_ROW);
  const service = createKpiService(api);
  await service.update("k1", { rating: null }, { original: service.read(KPI_ROW) });

  assert.equal(api.calls.length, 0);
});

test("an out-of-range rating never reaches the server", async () => {
  const api = fakeApi();
  await assert.rejects(createKpiService(api).update("k1", { rating: 11 }), MappingError);
  assert.equal(api.calls.length, 0);
});

// ---- leaves: apply, decide, cancel -----------------------------------------------------------------------------

const LEAVE_ROW = { id: "l1", employee_id: EMP, type: "Annual", start_date: "2026-02-10", end_date: "2026-02-12", days: 3, reason: "trip", status: "pending", applied_on: "2026-02-05", decided_by_employee_id: null, decided_at: null, created_at: "t", updated_at: "t" };

test("leave apply sends exactly four fields", async () => {
  const api = fakeApi(() => LEAVE_ROW);
  await createLeaveService(api).create({ id: Date.now(), empId: EMP, type: "Annual", start: "2026-02-10", end: "2026-02-12", days: 3, reason: "trip", status: "pending", applied: "2026-02-05" });

  assert.deepEqual(api.calls[0].body, { type: "Annual", start_date: "2026-02-10", end_date: "2026-02-12", reason: "trip" });
});

test("decide PATCHes the status", async () => {
  const api = fakeApi(() => ({ ...LEAVE_ROW, status: "approved", decided_by_employee_id: "m1" }));
  const result = await createLeaveService(api).decide("l1", "approved");

  assert.deepEqual(api.calls[0], { method: "PATCH", path: "/leaves/l1", body: { status: "approved" }, options: undefined });
  assert.equal(result.status, "approved");
});

test("decide refuses a status that is not a decision, before any request", async () => {
  const api = fakeApi();
  await assert.rejects(createLeaveService(api).decide("l1", "pending"), MappingError);
  assert.equal(api.calls.length, 0);
});

test("CANCEL: an employee cancelling their pending leave is DELETE /leaves/:id", async () => {
  const api = fakeApi();
  await createLeaveService(api).cancel("l1");

  assert.equal(api.calls[0].method, "DELETE");
  assert.equal(api.calls[0].path, "/leaves/l1");
});

// ---- payroll, balances -------------------------------------------------------------------------------------------------

test("payroll create sends a month NUMBER and never tax/net/gross", async () => {
  const api = fakeApi(() => ({ id: "pr1", employee_id: EMP, period_year: 2026, period_month: 4, basic: 1, allowances: 1, bonus: 0, deductions: 0, gross: 2, tax: 0, net: 2, status: "processed", created_at: "t", updated_at: "t" }));
  const result = await createPayrollService(api).create({ id: Date.now(), empId: EMP, month: "April", year: "2026", tax: 99, net: 99, status: "processed" });

  assert.equal(api.calls[0].body.period_month, 4);
  assert.equal(Object.hasOwn(api.calls[0].body, "tax"), false);
  assert.equal(result.month, "April");
});

test("the leave balance filter goes THROUGH the mapper: employee_id and as_of are the API's names", async () => {
  const api = fakeApi(() => ({ employee_id: EMP, as_of: "2026-10-09", year: 2026, taken: { Annual: 3 }, total: 3 }));
  const records = await createLeaveBalanceService(api).forEmployee(EMP, { asOf: "2026-10-09" });

  assert.deepEqual(api.calls[0].query, { employee_id: EMP, as_of: "2026-10-09" });
  assert.deepEqual(records, [{ _docId: EMP, taken: { Annual: 3 }, total: 3, year: 2026, asOf: "2026-10-09" }]);
});

test("the leave balance has no total-allowed or remaining figure", async () => {
  const api = fakeApi(() => ({ employee_id: EMP, as_of: "d", year: 2026, taken: {}, total: 0 }));
  const [usage] = await createLeaveBalanceService(api).forEmployee(EMP);

  for (const key of ["t", "u", "r"]) assert.equal(Object.hasOwn(usage, key), false, key);
});
