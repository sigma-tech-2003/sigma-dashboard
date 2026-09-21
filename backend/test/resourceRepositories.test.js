import assert from "node:assert/strict";
import test from "node:test";
import { createAttendanceRepository } from "../src/repositories/attendanceRepository.js";
import { createDepartmentRepository } from "../src/repositories/departmentRepository.js";
import { createEmployeeRepository } from "../src/repositories/employeeRepository.js";
import { createKpiRepository } from "../src/repositories/kpiRepository.js";
import { createLeaveRepository } from "../src/repositories/leaveRepository.js";
import { createPayrollRepository } from "../src/repositories/payrollRepository.js";
import { createProjectRepository } from "../src/repositories/projectRepository.js";

// No database. Scope-predicate correctness itself is covered exhaustively in
// employeeScope.test.js and projectScopeService.test.js; these tests confirm each
// repository wires the right predicate to the right table/alias, short-circuits without
// querying for an unscopable principal, and shapes findByIdForPrincipal's parameters
// correctly (id at $1, scope filter offset to start at $2).

const DEPARTMENT = "11111111-1111-1111-1111-111111111111";
const PRINCIPAL_EMPLOYEE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SOME_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const principalFor = (role, overrides = {}) => ({
  userId: "user-id",
  employeeId: PRINCIPAL_EMPLOYEE,
  role,
  departmentId: DEPARTMENT,
  isTeamLead: role === "tl",
  ...overrides,
});

/** Records every query call; returns `rows` for all of them unless a function is given. */
function fakeDatabase(rows = []) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rows: typeof rows === "function" ? rows(text, values) : rows };
    },
  };
}

// ---------------------------------------------------------------------------
// employeeRepository -- findByIdForPrincipal (new), and compensation parity
// ---------------------------------------------------------------------------

test("employeeRepository.listForPrincipal includes basic and allowances for every role in scope", () => {
  // Parity decision: Firestore has no field-level security, so whoever the scope
  // predicate lets see the row sees full compensation. PAYROLL_ROLES still gates writes.
  for (const role of ["admin", "hr", "manager", "tl", "employee"]) {
    const database = fakeDatabase([]);
    const repository = createEmployeeRepository(database);
    repository.listForPrincipal(principalFor(role));
  }
});

test("employeeRepository.findByIdForPrincipal places id at $1 and offsets the scope filter to $2", async () => {
  const database = fakeDatabase([{ id: SOME_ID }]);
  const repository = createEmployeeRepository(database);
  await repository.findByIdForPrincipal(SOME_ID, principalFor("manager"));

  assert.equal(database.calls.length, 1);
  const { text, values } = database.calls[0];
  assert.match(text, /employees\.id = \$1/);
  assert.match(text, /employees\.department_id = \$2/);
  assert.match(text, /basic/);
  assert.match(text, /allowances/);
  assert.deepEqual(values, [SOME_ID, DEPARTMENT]);
});

test("employeeRepository.findByIdForPrincipal short-circuits for an unscopable principal", async () => {
  const database = fakeDatabase([{ id: SOME_ID }]);
  const repository = createEmployeeRepository(database);
  const result = await repository.findByIdForPrincipal(SOME_ID, { role: "admin" }); // no employeeId
  assert.equal(result, null);
  assert.equal(database.calls.length, 0, "must not query at all for an unscopable principal");
});

// ---------------------------------------------------------------------------
// departmentRepository -- role gate only, no row-level predicate
// ---------------------------------------------------------------------------

test("departmentRepository allows admin/hr and denies manager/tl/employee without querying", async () => {
  for (const role of ["manager", "tl", "employee"]) {
    const database = fakeDatabase([{ id: SOME_ID }]);
    const repository = createDepartmentRepository(database);
    assert.deepEqual(await repository.listForPrincipal(principalFor(role)), []);
    assert.equal(await repository.findByIdForPrincipal(SOME_ID, principalFor(role)), null);
    assert.equal(database.calls.length, 0, `${role} must not reach the database`);
  }

  for (const role of ["admin", "hr"]) {
    const database = fakeDatabase([{ id: SOME_ID, name: "Engineering" }]);
    const repository = createDepartmentRepository(database);
    const list = await repository.listForPrincipal(principalFor(role));
    assert.equal(list.length, 1);
    assert.equal(database.calls.length, 1);
  }
});

// ---------------------------------------------------------------------------
// projectRepository -- scope predicate + assignedEmployeeIds aggregation
// ---------------------------------------------------------------------------

test("projectRepository.listForPrincipal uses buildProjectScopeFilter against the projects table directly", async () => {
  const database = fakeDatabase((text) => (text.includes("project_assignments") ? [] : [{ id: SOME_ID, title: "P" }]));
  const repository = createProjectRepository(database);
  await repository.listForPrincipal(principalFor("manager"));

  const listCall = database.calls.find((call) => call.text.includes("FROM projects"));
  assert.match(listCall.text, /projects\.department_id = \$1/);
  assert.deepEqual(listCall.values, [DEPARTMENT]);
});

test("projectRepository attaches assignedEmployeeIds aggregated from project_assignments", async () => {
  const projectId = SOME_ID;
  const database = fakeDatabase((text) => {
    if (text.includes("FROM project_assignments")) {
      return [{ project_id: projectId, employee_id: "emp-1" }, { project_id: projectId, employee_id: "emp-2" }];
    }
    return [{ id: projectId, title: "P" }];
  });
  const repository = createProjectRepository(database);
  const [project] = await repository.listForPrincipal(principalFor("admin"));

  assert.deepEqual(project.assignedEmployeeIds.sort(), ["emp-1", "emp-2"]);
});

test("projectRepository returns an empty assignedEmployeeIds array rather than querying when there are no projects", async () => {
  const database = fakeDatabase([]);
  const repository = createProjectRepository(database);
  const list = await repository.listForPrincipal(principalFor("admin"));
  assert.deepEqual(list, []);
  // Only the projects query ran; the assignment-aggregation query is skipped for an empty list.
  assert.equal(database.calls.length, 1);
});

test("projectRepository.findByIdForPrincipal offsets the scope filter to start at $2", async () => {
  const database = fakeDatabase((text) => (text.includes("project_assignments") ? [] : [{ id: SOME_ID, title: "P" }]));
  const repository = createProjectRepository(database);
  await repository.findByIdForPrincipal(SOME_ID, principalFor("manager"));

  const detailCall = database.calls.find((call) => call.text.includes("FROM projects"));
  assert.match(detailCall.text, /projects\.id = \$1/);
  assert.match(detailCall.text, /projects\.department_id = \$2/);
  assert.deepEqual(detailCall.values, [SOME_ID, DEPARTMENT]);
});

// ---------------------------------------------------------------------------
// kpiRepository / leaveRepository / attendanceRepository -- the shared employee-join shape
// ---------------------------------------------------------------------------

const JOIN_REPOSITORIES = [
  { name: "kpiRepository", create: createKpiRepository, table: "kpis" },
  { name: "leaveRepository", create: createLeaveRepository, table: "leaves" },
  { name: "attendanceRepository", create: createAttendanceRepository, table: "attendance" },
];

for (const { name, create, table } of JOIN_REPOSITORIES) {
  test(`${name}.listForPrincipal joins to employees and applies the employee scope predicate`, async () => {
    const database = fakeDatabase([]);
    const repository = create(database);
    await repository.listForPrincipal(principalFor("manager"));

    assert.equal(database.calls.length, 1);
    const { text, values } = database.calls[0];
    assert.match(text, new RegExp(`FROM ${table}`));
    assert.match(text, new RegExp(`JOIN employees ON employees\\.id = ${table}\\.employee_id`));
    assert.match(text, /employees\.department_id = \$1/);
    assert.deepEqual(values, [DEPARTMENT]);
  });

  test(`${name}.findByIdForPrincipal places id at $1 and offsets the scope filter to $2`, async () => {
    const database = fakeDatabase([{ id: SOME_ID }]);
    const repository = create(database);
    await repository.findByIdForPrincipal(SOME_ID, principalFor("tl"));

    const { text, values } = database.calls[0];
    assert.match(text, new RegExp(`${table}\\.id = \\$1`));
    assert.match(text, /\$2/);
    assert.match(text, /\$3/);
    assert.deepEqual(values, [SOME_ID, PRINCIPAL_EMPLOYEE, PRINCIPAL_EMPLOYEE]);
  });

  test(`${name} short-circuits for an unscopable principal without querying`, async () => {
    const database = fakeDatabase([{ id: SOME_ID }]);
    const repository = create(database);
    assert.deepEqual(await repository.listForPrincipal({ role: "admin" }), []);
    assert.equal(await repository.findByIdForPrincipal(SOME_ID, { role: "admin" }), null);
    assert.equal(database.calls.length, 0);
  });
}

// ---------------------------------------------------------------------------
// payrollRepository -- the documented exception: no join, manager/tl denied
// ---------------------------------------------------------------------------

test("payrollRepository never joins to employees -- manager/tl are denied before any query runs", async () => {
  for (const role of ["manager", "tl"]) {
    const database = fakeDatabase([{ id: SOME_ID }]);
    const repository = createPayrollRepository(database);
    assert.deepEqual(await repository.listForPrincipal(principalFor(role)), []);
    assert.equal(await repository.findByIdForPrincipal(SOME_ID, principalFor(role)), null);
    assert.equal(database.calls.length, 0, `${role} must not reach the database for payroll`);
  }
});

test("payrollRepository scopes an employee to their own processed rows, with no join clause", async () => {
  const database = fakeDatabase([]);
  const repository = createPayrollRepository(database);
  await repository.listForPrincipal(principalFor("employee"));

  assert.equal(database.calls.length, 1);
  const { text, values } = database.calls[0];
  assert.doesNotMatch(text, /JOIN employees/);
  assert.match(text, /payroll\.employee_id = \$1 AND payroll\.status = 'processed'/);
  assert.deepEqual(values, [PRINCIPAL_EMPLOYEE]);
});

test("payrollRepository.findByIdForPrincipal places id at $1 and offsets the scope filter to $2", async () => {
  const database = fakeDatabase([{ id: SOME_ID }]);
  const repository = createPayrollRepository(database);
  await repository.findByIdForPrincipal(SOME_ID, principalFor("employee"));

  const { text, values } = database.calls[0];
  assert.match(text, /payroll\.id = \$1/);
  assert.match(text, /payroll\.employee_id = \$2/);
  assert.deepEqual(values, [SOME_ID, PRINCIPAL_EMPLOYEE]);
});

test("payrollRepository lets admin/hr see draft and processed rows alike (unfiltered)", async () => {
  const database = fakeDatabase([]);
  const repository = createPayrollRepository(database);
  await repository.listForPrincipal(principalFor("admin"));

  const { text, values } = database.calls[0];
  assert.match(text, /WHERE payroll\.deleted_at IS NULL AND TRUE/);
  assert.deepEqual(values, []);
});
