import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { fakeApi, installFakeFetch, ok } from "../test-support/fakes.js";
import { departmentDirectory } from "./departmentDirectory.js";
import { createEmployeeService } from "./employeeService.js";
import { createLeaveService, leaveService } from "./leaveService.js";
import { createProjectService } from "./projectService.js";
import * as employeeMapper from "./mappers/employee.js";
import * as projectMapper from "./mappers/project.js";
// The backend's own request schemas. Every one is .strict(), so a key the API does not accept (decided_at,
// department_name, an employee's name where an id belongs) makes safeParse fail. That is the contract these tests hold
// the frontend to: they would have caught each of the three reported defects had it existed.
import { leaveDecisionSchema } from "../../backend/src/validation/leaveSchemas.js";
import { projectCreateSchema, projectUpdateSchema } from "../../backend/src/validation/projectSchemas.js";
import { employeeCreateSchema, employeeUpdateSchema } from "../../backend/src/validation/employeeSchemas.js";

const DEPT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_DEPT = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
const E1 = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const E2 = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
const TL = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => departmentDirectory.learn([{ id: DEPT, name: "Engineering" }, { id: OTHER_DEPT, name: "Finance" }]));
afterEach(() => departmentDirectory.clear());

const rejected = (schema, body) => !schema.safeParse(body).success;
const accepted = (schema, body) => {
  const result = schema.safeParse(body);
  assert.equal(result.success, true, result.success ? "" : JSON.stringify(result.error.issues));
};

// ---- the control: the schemas really do refuse what the reported defects would have sent -------------------------------

test("control: the backend refuses decided_at, names and department_name, so the tests below can fail", () => {
  assert.ok(rejected(leaveDecisionSchema, { status: "approved", decided_at: "2026-10-01T00:00:00Z" }));
  assert.ok(rejected(leaveDecisionSchema, { status: "approved", decided_by_employee_id: E1 }));
  assert.ok(rejected(projectCreateSchema, { title: "T", department_id: DEPT, start_date: "2026-10-01", due_date: "2026-11-01", assigned_employee_ids: ["Aisha Khan"] }));
  assert.ok(rejected(projectCreateSchema, { title: "T", department_id: "Engineering", start_date: "2026-10-01", due_date: "2026-11-01", assigned_employee_ids: [E1] }));
  assert.ok(rejected(employeeCreateSchema, {
    email: "a@b.co", role: "employee", full_name: "A", position_title: "p", joined_on: "2026-10-01", basic: 1, allowances: 0,
    temporary_password: "temp-pass-1234", department_id: DEPT, department_name: "Engineering",
  }));
});

// ---- leave: approving or rejecting sends { status } and nothing else ------------------------------------------------------

test("a leave decision is exactly { status }, and the backend accepts it (approve and reject)", async () => {
  for (const status of ["approved", "rejected"]) {
    const api = fakeApi(() => ({ id: "l1", status }));
    await createLeaveService(api).decide("l1", status);

    assert.equal(api.calls[0].method, "PATCH");
    assert.equal(api.calls[0].path, "/leaves/l1");
    assert.deepEqual(Object.keys(api.calls[0].body), ["status"]);
    accepted(leaveDecisionSchema, api.calls[0].body);
  }
});

test("on the wire, a decision's JSON carries no decided_at or decided_by (the server stamps those itself)", async () => {
  const fake = installFakeFetch(() => ok({
    id: "l1", employee_id: E1, type: "Annual", start_date: "2026-11-02", end_date: "2026-11-04", days: 3, reason: "r", status: "approved",
    applied_on: "2026-10-21", decided_by_employee_id: TL, decided_at: "2026-10-21T10:00:00.000Z", decision_recorded: true,
    created_at: "t", updated_at: "t",
  }));
  try {
    const decided = await leaveService.decide("l1", "approved");

    const sent = JSON.stringify(fake.calls[0].body);
    assert.deepEqual(fake.calls[0].body, { status: "approved" });
    assert.doesNotMatch(sent, /decided/i);
    assert.equal(decided.decidedAt, "2026-10-21T10:00:00.000Z", "the response's decided_at is READ into the record, never sent back");
  } finally {
    fake.restore();
  }
});

test("deciding a leave never sends fields from a record that already carries a decision", async () => {
  // A decided leave as the page holds it (decidedBy/decidedAt present). Changing it again is a 409 from the server,
  // but whatever is asked, only { status } may go.
  const api = fakeApi(() => ({ id: "l1", status: "rejected" }));
  await createLeaveService(api).decide("l1", "rejected");

  assert.deepEqual(api.calls[0].body, { status: "rejected" });
});

// ---- projects: ids are UUIDs, the department is an id, and nothing else goes -------------------------------------------

// The record ProjectsPage hands the service (department is a NAME for the page; assigned ids are strings of the
// employee ids from the option values).
const projectFromPage = () => ({
  id: 1760000000000, title: " Portal ", description: "", department: "Engineering", teamLeadId: TL,
  assignedEmployeeIds: [E1, E2], startDate: "2026-10-01", dueDate: "2026-12-31", status: "active",
});

test("project create sends UUID strings for the assignees and the department, and the backend accepts it", async () => {
  const api = fakeApi(() => ({ id: "p1", department_id: DEPT, department_name: "Engineering", assignedEmployeeIds: [E1, E2] }));
  await createProjectService(api).create(projectFromPage());

  const body = api.calls[0].body;
  assert.ok(body.assigned_employee_ids.every((id) => UUID.test(id)), JSON.stringify(body.assigned_employee_ids));
  assert.match(body.department_id, UUID);
  assert.equal(body.department_id, DEPT, "the NAME was resolved to the id, not sent as is");
  assert.equal(Object.keys(body).some((key) => /name|department$|^id$/.test(key)), false, Object.keys(body).join());
  accepted(projectCreateSchema, body);
});

test("project create never sends an employee's name, even when the page also holds names", () => {
  const body = projectMapper.toApiCreate({ ...projectFromPage(), assignedEmployees: ["Aisha Khan", "Omar Ali"], assignedNames: ["Aisha Khan"] }, { departments: departmentDirectory.lookup() });

  assert.equal(JSON.stringify(body).includes("Aisha"), false);
  accepted(projectCreateSchema, body);
});

test("project edit of a record read from the API sends only changed, accepted fields (ids stay UUIDs)", async () => {
  const original = projectMapper.fromApi({
    id: "p1", company_id: "c", department_id: DEPT, department_name: "Engineering", team_lead_id: TL, title: "Portal", description: "d",
    start_date: "2026-10-01", due_date: "2026-12-31", status: "active", assignedEmployeeIds: [E1],
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
  });
  const api = fakeApi(() => ({ id: "p1", department_id: DEPT, assignedEmployeeIds: [E1, E2] }));

  await createProjectService(api).update("p1", { ...original, description: "edited", assignedEmployeeIds: [E1, E2] }, { original });

  const body = api.calls[0].body;
  assert.deepEqual(Object.keys(body).sort(), ["assigned_employee_ids", "description"]);
  assert.ok(body.assigned_employee_ids.every((id) => UUID.test(id)));
  accepted(projectUpdateSchema, body);
});

// ProjectsPage.changeDepartment clears the team lead and the assignees; the person then picks new assignees (a team
// lead is optional). The API accepts a department change ONLY together with team_lead_id and assigned_employee_ids.
const projectInOldDepartment = (teamLeadId) => projectMapper.fromApi({
  id: "p1", department_id: DEPT, department_name: "Engineering", team_lead_id: teamLeadId, title: "Portal", description: "",
  start_date: "2026-10-01", due_date: "2026-12-31", status: "active", assignedEmployeeIds: [E1],
});

test("moving a project that had a team lead to another department sends the department, the new lead and the assignees", () => {
  const original = projectInOldDepartment(TL);
  const body = projectMapper.toApiUpdate(
    { ...original, department: "Finance", departmentId: OTHER_DEPT, teamLeadId: "", assignedEmployeeIds: [E2] },
    { original, departments: departmentDirectory.lookup() },
  );

  assert.equal(body.department_id, OTHER_DEPT);
  assert.equal("department" in body, false);
  assert.equal(body.team_lead_id, null);
  assert.deepEqual(body.assigned_employee_ids, [E2]);
  accepted(projectUpdateSchema, body);
});

test("moving a project that had NO team lead (and still has none) still sends team_lead_id, because the API requires it", () => {
  const original = projectInOldDepartment(null);
  const body = projectMapper.toApiUpdate(
    { ...original, department: "Finance", departmentId: OTHER_DEPT, teamLeadId: "", assignedEmployeeIds: [E2] },
    { original, departments: departmentDirectory.lookup() },
  );

  assert.equal(body.department_id, OTHER_DEPT);
  assert.equal(Object.hasOwn(body, "team_lead_id"), true, "an unchanged (empty) team lead must still be sent with a department change");
  assert.equal(body.team_lead_id, null);
  accepted(projectUpdateSchema, body);
});

test("moving a project and keeping the SAME assignee list still sends the assignees with the department", () => {
  const original = projectInOldDepartment(null);
  const body = projectMapper.toApiUpdate(
    { ...original, department: "Finance", departmentId: OTHER_DEPT, teamLeadId: "", assignedEmployeeIds: [E1] },
    { original, departments: departmentDirectory.lookup() },
  );

  assert.deepEqual(body.assigned_employee_ids, [E1]);
  accepted(projectUpdateSchema, body);
});

test("a project edit that does NOT change the department never adds team_lead_id or assignees on its own", () => {
  const original = projectInOldDepartment(TL);
  const body = projectMapper.toApiUpdate({ ...original, description: "only this" }, { original, departments: departmentDirectory.lookup() });

  assert.deepEqual(body, { description: "only this" });
  accepted(projectUpdateSchema, body);
});

// ---- employees: department_id travels alone ---------------------------------------------------------------------------

// What EmployeesPage.invitationProfile builds: the department is a NAME, and a record copied from the list also carries
// departmentId and the server's department_name-derived `dept`.
const employeeFromPage = (extra = {}) => ({
  name: "Aisha Khan", email: "AISHA@b.co", phone: "", dept: "Engineering", pos: "Engineer", basic: 100, allowances: 10,
  joinDate: "2026-10-01", role: "employee", status: "active", temporaryPassword: "temp-pass-1234", ...extra,
});

test("employee create sends department_id and never department_name, and the backend accepts it", async () => {
  const api = fakeApi(() => ({ id: E1 }));
  await createEmployeeService(api).create(employeeFromPage());

  const body = api.calls[0].body;
  assert.equal(body.department_id, DEPT);
  assert.equal(Object.keys(body).some((key) => /department_name|^dept$|^departmentId$/.test(key)), false, Object.keys(body).join());
  accepted(employeeCreateSchema, body);
});

test("employee create with BOTH the name and an id on the record still sends one department_id and nothing derived", async () => {
  const api = fakeApi(() => ({ id: E1 }));
  await createEmployeeService(api).create(employeeFromPage({ departmentId: DEPT, department_name: "Engineering", departmentName: "Engineering" }));

  const body = api.calls[0].body;
  assert.equal(Object.keys(body).filter((key) => key.includes("department")).join(), "department_id");
  accepted(employeeCreateSchema, body);
});

test("employee edit of a record read from the API (which carries departmentId, dept and timestamps) is accepted", async () => {
  const original = employeeMapper.fromApi({
    id: E1, department_id: DEPT, department_name: "Engineering", team_lead_id: null, employee_number: "EMP-0001", full_name: "Aisha Khan",
    phone: null, position_title: "Engineer", employment_status: "active", joined_on: "2026-10-01", basic: 100, allowances: 10,
    role: "employee", email: "a@b.co", created_at: "t", updated_at: "t",
  });
  const api = fakeApi(() => ({ id: E1 }));

  await createEmployeeService(api).update(E1, { ...original, pos: "Senior Engineer", dept: "Finance", departmentId: OTHER_DEPT }, { original });

  const body = api.calls[0].body;
  assert.equal(body.department_id, OTHER_DEPT);
  assert.equal(Object.keys(body).some((key) => /department_name|^dept$|^departmentId$|empId|createdAt|updatedAt|^id$/.test(key)), false, Object.keys(body).join());
  accepted(employeeUpdateSchema, body);
});

test("employee edit that does not touch the department sends no department at all", async () => {
  const original = employeeMapper.fromApi({
    id: E1, department_id: DEPT, department_name: "Engineering", team_lead_id: null, employee_number: "EMP-0001", full_name: "Aisha Khan",
    phone: null, position_title: "Engineer", employment_status: "active", joined_on: "2026-10-01", basic: 100, allowances: 10,
    role: "employee", email: "a@b.co", created_at: "t", updated_at: "t",
  });
  const api = fakeApi(() => ({ id: E1 }));

  await createEmployeeService(api).update(E1, { ...original, pos: "Lead" }, { original });

  assert.deepEqual(api.calls[0].body, { position_title: "Lead" });
  accepted(employeeUpdateSchema, api.calls[0].body);
});
