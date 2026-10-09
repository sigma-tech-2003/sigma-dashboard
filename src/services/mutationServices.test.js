import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { created, failure, installFakeFetch, noContent, ok } from "../test-support/fakes.js";
import { departmentDirectory } from "./departmentDirectory.js";
import { pollingHub } from "./polling.js";
import { EmployeeInvitationError, inviteEmployee } from "./employeeInvitationService.js";
import { deleteEmployee, EmployeeMutationError, updateEmployee } from "./employeeMutationService.js";
import { EmployeePasswordSetupError, sendEmployeePasswordSetupEmail } from "./authService.js";
import { createKpi, deleteKpi, KpiMutationError, updateKpi } from "./kpiMutationService.js";
import { createProject, deleteProject, ProjectMutationError, updateProject } from "./projectMutationService.js";

// The services the PAGES import directly. They run on the real default API client with `fetch` replaced.

const DEPT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EMP = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let fake;
afterEach(() => {
  fake?.restore();
  fake = null;
  departmentDirectory.clear();
});

const EMPLOYEE_ROW = {
  id: EMP, department_id: DEPT, department_name: "Engineering", team_lead_id: null, employee_number: "EMP-1",
  full_name: "Aisha Khan", phone: null, position_title: "Engineer", employment_status: "active",
  joined_on: "2024-03-15", basic: 100, allowances: 10, role: "employee", email: "aisha@b.co", created_at: "t", updated_at: "t",
};
const PROFILE = { name: "Aisha Khan", email: "aisha@b.co", dept: "Engineering", pos: "Engineer", basic: 100, allowances: 10, joinDate: "2024-03-15", role: "employee", status: "active" };

// ---- inviteEmployee ------------------------------------------------------------------------------------------------

test("inviteEmployee POSTs /employees and resolves the created employee with its server id and email", async () => {
  departmentDirectory.learn([{ id: DEPT, name: "Engineering" }]);
  fake = installFakeFetch(() => created(EMPLOYEE_ROW));
  const employee = await inviteEmployee(PROFILE);

  assert.equal(fake.calls[0].method, "POST");
  assert.equal(fake.calls[0].path, "/employees");
  assert.equal(fake.calls[0].body.full_name, "Aisha Khan");
  assert.equal(fake.calls[0].body.department_id, DEPT);
  assert.equal(employee.id, EMP);
  assert.equal(employee.email, "aisha@b.co");
});

test("inviteEmployee re-polls the data straight away: EmployeesPage calls it directly, so no hook would", async () => {
  departmentDirectory.learn([{ id: DEPT, name: "Engineering" }]);
  fake = installFakeFetch(() => created(EMPLOYEE_ROW));
  let polls = 0;
  const registration = pollingHub.register({ fetch: async () => { polls += 1; return []; }, onData: () => {}, onError: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = polls;

  await inviteEmployee(PROFILE);
  await new Promise((resolve) => setTimeout(resolve, 20));
  registration.stop();

  assert.ok(polls > before, `expected a poll after the invitation (before ${before}, after ${polls})`);
});

test("inviteEmployee rejects a field outside the profile before any request", async () => {
  fake = installFakeFetch(() => ok({}));
  await assert.rejects(inviteEmployee({ ...PROFILE, id: Date.now() }), (error) => error instanceof EmployeeInvitationError && error.code === "invalid-argument");
  assert.equal(fake.calls.length, 0);
});

test("inviteEmployee: a duplicate email shows the existing 'already exists' message", async () => {
  departmentDirectory.learn([{ id: DEPT, name: "Engineering" }]);
  fake = installFakeFetch(() => failure(409, "email_already_exists", "SQL detail that must not leak"));

  await assert.rejects(inviteEmployee(PROFILE), (error) => {
    assert.ok(error instanceof EmployeeInvitationError);
    assert.equal(error.code, "already-exists");
    assert.equal(error.message, "An employee account with this email already exists.");
    return true;
  });
});

test("inviteEmployee: forbidden, offline and unknown failures map to the existing messages", async () => {
  departmentDirectory.learn([{ id: DEPT, name: "Engineering" }]);
  for (const [response, code] of [[failure(403, "employee_scope_denied"), "permission-denied"], [failure(503, "unavailable"), "unavailable"], [failure(500, "internal"), "internal"]]) {
    fake = installFakeFetch(() => response);
    await assert.rejects(inviteEmployee(PROFILE), (error) => error.code === code);
    fake.restore();
  }
  fake = null;
});

test("inviteEmployee for an unknown department is an invalid-argument error, not a crash", async () => {
  fake = installFakeFetch(() => created(EMPLOYEE_ROW));
  await assert.rejects(inviteEmployee({ ...PROFILE, dept: "Atlantis" }), (error) => error instanceof EmployeeInvitationError && error.code === "invalid-argument");
  assert.equal(fake.calls.length, 0);
});

// ---- the password-setup step -------------------------------------------------------------------------------------

test("sendEmployeePasswordSetupEmail fails honestly: no email is sent, and no request is made", async () => {
  fake = installFakeFetch(() => ok({}));

  await assert.rejects(sendEmployeePasswordSetupEmail("aisha@b.co"), (error) => error instanceof EmployeePasswordSetupError && error.code === "not-supported");
  assert.equal(fake.calls.length, 0);
});

test("sendEmployeePasswordSetupEmail still validates the address first", async () => {
  await assert.rejects(sendEmployeePasswordSetupEmail("nope"), (error) => error.code === "invalid-email");
  await assert.rejects(sendEmployeePasswordSetupEmail(undefined), (error) => error.code === "invalid-email");
});

// ---- employee update / delete -------------------------------------------------------------------------------------

test("updateEmployee PATCHes only what changed against the original", async () => {
  fake = installFakeFetch(() => ok({ ...EMPLOYEE_ROW, position_title: "Lead" }));
  const original = { id: EMP, name: "Aisha Khan", pos: "Engineer", dept: "Engineering", departmentId: DEPT, role: "employee", basic: 100 };

  await updateEmployee(EMP, { ...original, pos: "Lead" }, { original });

  assert.equal(fake.calls[0].method, "PATCH");
  assert.equal(fake.calls[0].path, `/employees/${EMP}`);
  assert.deepEqual(fake.calls[0].body, { position_title: "Lead" });
});

test("updateEmployee with nothing changed makes no request", async () => {
  fake = installFakeFetch(() => ok({}));
  const original = { id: EMP, name: "A", pos: "p" };

  await updateEmployee(EMP, { ...original }, { original });

  assert.equal(fake.calls.length, 0);
});

test("updateEmployee: errors become EmployeeMutationError with the existing messages", async () => {
  for (const [response, code, message] of [
    [failure(403, "self_role_change_denied"), "permission-denied", "You do not have permission to manage this employee."],
    [failure(404, "not_found"), "not-found", "This employee record could not be found."],
    [failure(409, "email_already_exists"), "already-exists", "This employee email is already in use."],
  ]) {
    fake = installFakeFetch(() => response);
    await assert.rejects(updateEmployee(EMP, { pos: "x" }), (error) => {
      assert.ok(error instanceof EmployeeMutationError);
      assert.equal(error.code, code);
      assert.equal(error.message, message);
      return true;
    });
    fake.restore();
  }
  fake = null;
});

test("updateEmployee with a blank id is an invalid-argument error and makes no request", async () => {
  fake = installFakeFetch(() => ok({}));
  await assert.rejects(updateEmployee("  ", { pos: "x" }), (error) => error.code === "invalid-argument");
  assert.equal(fake.calls.length, 0);
});

test("deleteEmployee DELETEs, and sends the replacement team lead when one is given (REASSIGNMENT)", async () => {
  fake = installFakeFetch(() => noContent());
  await deleteEmployee(EMP, { replacementTeamLeadId: "r1" });

  assert.equal(fake.calls[0].method, "DELETE");
  assert.deepEqual(fake.calls[0].body, { replacement_team_lead_id: "r1" });
});

test("deleteEmployee for a team lead with members, with no replacement: a distinct, explanatory error", async () => {
  fake = installFakeFetch(() => failure(400, "team_lead_replacement_required"));

  await assert.rejects(deleteEmployee(EMP), (error) => {
    assert.ok(error instanceof EmployeeMutationError);
    assert.equal(error.code, "replacement-required");
    assert.match(error.message, /replacement|new team lead/i);
    return true;
  });
});

test("deleteEmployee: an invalid replacement is its own error too", async () => {
  fake = installFakeFetch(() => failure(403, "team_lead_replacement_invalid"));
  await assert.rejects(deleteEmployee(EMP, { replacementTeamLeadId: "stranger" }), (error) => error.code === "replacement-invalid");
});

test("deleteEmployee never reports a partial cleanup: a Postgres delete is one transaction", async () => {
  fake = installFakeFetch(() => failure(500, "internal"));
  await assert.rejects(deleteEmployee(EMP), (error) => error.partialCleanup === undefined);
});

// ---- projects -----------------------------------------------------------------------------------------------------

const PROJECT_ROW = { id: "p1", department_id: DEPT, department_name: "Engineering", team_lead_id: null, title: "T", description: "", start_date: "2026-01-01", due_date: "2026-02-01", status: "active", assignedEmployeeIds: [EMP], created_at: "t", updated_at: "t" };

test("createProject resolves the created project with the server's id and never sends the page's id", async () => {
  departmentDirectory.learn([{ id: DEPT, name: "Engineering" }]);
  fake = installFakeFetch(() => created(PROJECT_ROW));
  const project = await createProject({ id: Date.now(), title: "T", department: "Engineering", assignedEmployeeIds: [EMP], startDate: "2026-01-01", dueDate: "2026-02-01" });

  assert.equal(project.id, "p1");
  assert.equal(Object.hasOwn(fake.calls[0].body, "id"), false);
});

test("updateProject sends only what changed; deleteProject DELETEs", async () => {
  fake = installFakeFetch((call) => (call.method === "DELETE" ? noContent() : ok(PROJECT_ROW)));
  const original = { id: "p1", title: "T", status: "active" };

  await updateProject("p1", { ...original, status: "completed" }, { original });
  await deleteProject("p1");

  assert.deepEqual(fake.calls[0].body, { status: "completed" });
  assert.equal(fake.calls[1].method, "DELETE");
});

test("project errors map to ProjectMutationError with the existing messages", async () => {
  fake = installFakeFetch(() => failure(403, "project_scope_denied"));
  await assert.rejects(deleteProject("p1"), (error) => error instanceof ProjectMutationError && error.message === "You do not have permission to manage this project.");
});

// ---- KPIs ----------------------------------------------------------------------------------------------------------

const KPI_ROW = { id: "k1", project_id: "p1", employee_id: EMP, title: "T", target: 10, current_value: 1, weight: 5, period: "Q1", status: "active", rating: null, rated_by_employee_id: null, rated_at: null, created_at: "t", updated_at: "t" };

test("createKpi sends the foreign keys and returns the server's id; the page's rating nulls are not sent", async () => {
  fake = installFakeFetch(() => created(KPI_ROW));
  const kpi = await createKpi({ id: Date.now(), projectId: "p1", empId: EMP, title: "T", target: 10, current: 1, weight: 5, period: "Q1", status: "active", rating: null, ratedBy: null, ratedAt: null });

  assert.equal(kpi.id, "k1");
  assert.deepEqual(Object.keys(fake.calls[0].body).sort(), ["current_value", "employee_id", "period", "project_id", "status", "target", "title", "weight"]);
});

test("updateKpi with a rating goes to POST /kpis/:id/rating", async () => {
  fake = installFakeFetch(() => ok({ ...KPI_ROW, rating: 9, rated_by_employee_id: "m1", rated_at: "t" }));
  await updateKpi("k1", { rating: 9, ratedBy: "m1", ratedAt: "2026-01-01T00:00:00Z" });

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].path, "/kpis/k1/rating");
  assert.deepEqual(fake.calls[0].body, { rating: 9 });
});

test("a self-rating refusal surfaces as a KpiMutationError with a permission message", async () => {
  fake = installFakeFetch(() => failure(403, "self_rating_denied"));
  await assert.rejects(updateKpi("k1", { rating: 9 }), (error) => error instanceof KpiMutationError && error.code === "permission-denied");
});

test("deleteKpi DELETEs", async () => {
  fake = installFakeFetch(() => noContent());
  assert.deepEqual(await deleteKpi("k1"), { id: "k1", deleted: true });
});
