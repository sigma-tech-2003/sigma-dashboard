import assert from "node:assert/strict";
import test from "node:test";
import { createAttendanceMutationService } from "../src/services/attendanceMutationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Fake repository-interface level, mirroring departmentMutationService.test.js.
// The authorization matrix itself is covered in attendanceAuthorization.test.js; these tests
// prove the service calls it correctly, in the right order, and own the two rules the database
// deliberately does not hold (D27): no future dates, and the employee must be active.

const DEPARTMENT = "dept-1";
const OTHER_DEPARTMENT = "dept-2";

const principalFor = (role, overrides = {}) => ({
  userId: "principal-user", employeeId: "principal-emp", role, departmentId: DEPARTMENT, ...overrides,
});

const EMPLOYEES = Object.freeze({
  inDepartment: { id: "emp-1", department_id: DEPARTMENT, employment_status: "active" },
  otherInDepartment: { id: "emp-2", department_id: DEPARTMENT, employment_status: "active" },
  elsewhere: { id: "emp-3", department_id: OTHER_DEPARTMENT, employment_status: "active" },
  terminated: { id: "emp-4", department_id: DEPARTMENT, employment_status: "terminated" },
});

function fakeEmployeeRepository(seed = Object.values(EMPLOYEES)) {
  const byId = new Map(seed.map((row) => [row.id, row]));
  return { async findById(id) { return byId.get(id) ?? null; } };
}

/**
 * `records` are what findById returns -- already carrying employee_department_id, the way the
 * real repository's join does. `employee_id`/`employee_department_id` default to emp-1/dept-1.
 */
function fakeAttendanceRepository(records = []) {
  const byId = new Map(records.map((row) => [row.id, row]));
  const calls = { create: [], updateById: [], deleteById: [] };
  return {
    calls,
    async findById(id) { return byId.get(id) ?? null; },
    async create(input) {
      calls.create.push(input);
      return { id: "new-id", ...input };
    },
    async updateById(id, changes) {
      calls.updateById.push({ id, changes });
      if (!byId.has(id)) return null;
      return { ...byId.get(id), ...changes };
    },
    async deleteById(id, deletedBy) {
      calls.deleteById.push({ id, deletedBy });
    },
  };
}

const record = (overrides = {}) => ({
  id: "att-1", employee_id: "emp-1", employee_department_id: DEPARTMENT, work_date: "2026-10-01",
  status: "present", ...overrides,
});

// 2026-10-02T20:00Z is 01:00 on Oct 3 in Karachi (UTC+5) but still Oct 2 in UTC.
const NOW = new Date("2026-10-02T20:00:00Z");

function buildService({ records = [record()], employees, timeZone = "Asia/Karachi", now = () => NOW } = {}) {
  const attendanceRepository = fakeAttendanceRepository(records);
  const service = createAttendanceMutationService({
    attendanceRepository,
    employeeRepository: fakeEmployeeRepository(employees),
    timeZone,
    now,
  });
  return { service, attendanceRepository };
}

const CREATE_INPUT = Object.freeze({
  employee_id: "emp-1", work_date: "2026-10-01", status: "present", check_in: "09:00", check_out: "17:00", notes: null,
});

/** The error a call rejects with; fails the test if it resolves. */
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected the call to reject");
}

// ---------------------------------------------------------------------------
// Every role against each operation
// ---------------------------------------------------------------------------

test("createAttendance: admin, hr and manager allowed; tl and employee denied before the repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, attendanceRepository } = buildService();
    const call = service.createAttendance(principalFor(role), CREATE_INPUT);

    if (["admin", "hr", "manager"].includes(role)) {
      await call;
      assert.equal(attendanceRepository.calls.create.length, 1, role);
    } else {
      const error = await rejection(call);
      assert.equal(error.statusCode, 403, role);
      assert.equal(error.code, "role_not_allowed", role);
      assert.equal(attendanceRepository.calls.create.length, 0, role);
    }
  }
});

test("updateAttendance: admin, hr and manager allowed; tl and employee denied before the repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, attendanceRepository } = buildService();
    const call = service.updateAttendance(principalFor(role), "att-1", { notes: "late bus" });

    if (["admin", "hr", "manager"].includes(role)) {
      await call;
      assert.equal(attendanceRepository.calls.updateById.length, 1, role);
    } else {
      assert.equal((await rejection(call)).code, "role_not_allowed", role);
      assert.equal(attendanceRepository.calls.updateById.length, 0, role);
    }
  }
});

test("deleteAttendance: admin, hr and manager allowed; tl and employee denied before the repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, attendanceRepository } = buildService();
    const call = service.deleteAttendance(principalFor(role), "att-1");

    if (["admin", "hr", "manager"].includes(role)) {
      await call;
      assert.equal(attendanceRepository.calls.deleteById.length, 1, role);
    } else {
      assert.equal((await rejection(call)).code, "role_not_allowed", role);
      assert.equal(attendanceRepository.calls.deleteById.length, 0, role);
    }
  }
});

// ---------------------------------------------------------------------------
// createAttendance
// ---------------------------------------------------------------------------

test("createAttendance: passes exactly the validated input through -- no timestamps are invented here", async () => {
  const { service, attendanceRepository } = buildService();

  await service.createAttendance(principalFor("admin"), CREATE_INPUT);

  assert.deepEqual(attendanceRepository.calls.create[0], CREATE_INPUT);
  assert.equal(Object.hasOwn(attendanceRepository.calls.create[0], "created_at"), false);
  assert.equal(Object.hasOwn(attendanceRepository.calls.create[0], "updated_at"), false);
});

test("createAttendance: an employee_id that does not exist is a 400 invalid_employee", async () => {
  const { service, attendanceRepository } = buildService();

  const error = await rejection(service.createAttendance(principalFor("admin"), { ...CREATE_INPUT, employee_id: "missing" }));

  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "invalid_employee");
  assert.equal(attendanceRepository.calls.create.length, 0);
});

test("createAttendance: a manager is denied for an employee in another department", async () => {
  const { service, attendanceRepository } = buildService();

  const error = await rejection(service.createAttendance(principalFor("manager"), { ...CREATE_INPUT, employee_id: "emp-3" }));

  assert.equal(error.statusCode, 403);
  assert.equal(error.code, "attendance_scope_denied");
  assert.equal(attendanceRepository.calls.create.length, 0);
});

test("createAttendance: D27 -- the employee must be active; every other employment_status is refused", async () => {
  for (const status of ["inactive", "on_leave", "terminated"]) {
    const { service, attendanceRepository } = buildService({
      employees: [{ id: "emp-1", department_id: DEPARTMENT, employment_status: status }],
    });

    const error = await rejection(service.createAttendance(principalFor("admin"), CREATE_INPUT));

    assert.equal(error.statusCode, 400, status);
    assert.equal(error.code, "employee_not_active", status);
    assert.equal(attendanceRepository.calls.create.length, 0, status);
  }
});

test("createAttendance: scope is checked before activity, so an out-of-scope manager learns nothing about status", async () => {
  const { service } = buildService({
    employees: [{ id: "emp-3", department_id: OTHER_DEPARTMENT, employment_status: "terminated" }],
  });

  const error = await rejection(service.createAttendance(principalFor("manager"), { ...CREATE_INPUT, employee_id: "emp-3" }));

  assert.equal(error.code, "attendance_scope_denied");
});

// ---------------------------------------------------------------------------
// Future dates: the company timezone, not UTC (D27)
// ---------------------------------------------------------------------------

test("future-date boundary, Asia/Karachi: one second before local midnight Oct 3 is still Oct 2", async () => {
  // 2026-10-02T18:59:59Z is 23:59:59 on Oct 2 in Karachi.
  const { service } = buildService({ now: () => new Date("2026-10-02T18:59:59Z") });

  await service.createAttendance(principalFor("admin"), { ...CREATE_INPUT, work_date: "2026-10-02" });

  const error = await rejection(service.createAttendance(principalFor("admin"), { ...CREATE_INPUT, work_date: "2026-10-03" }));
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "work_date_in_future");
});

test("future-date boundary, Asia/Karachi: at local midnight Oct 3 becomes today and Oct 4 is the future", async () => {
  // 2026-10-02T19:00:00Z is 00:00:00 on Oct 3 in Karachi -- UTC is still Oct 2, so a UTC
  // check would wrongly reject marking today's attendance for the first five local hours.
  const { service, attendanceRepository } = buildService({ now: () => new Date("2026-10-02T19:00:00Z") });

  await service.createAttendance(principalFor("admin"), { ...CREATE_INPUT, work_date: "2026-10-03" });
  assert.equal(attendanceRepository.calls.create.length, 1);

  const error = await rejection(service.createAttendance(principalFor("admin"), { ...CREATE_INPUT, work_date: "2026-10-04" }));
  assert.equal(error.code, "work_date_in_future");
});

test("future-date check uses the configured zone, not a hard-coded one", async () => {
  // At 2026-10-03T03:00Z it is Oct 2 20:00 in Los Angeles (UTC-7) but Oct 3 in UTC and Karachi.
  const instant = new Date("2026-10-03T03:00:00Z");

  const losAngeles = buildService({ timeZone: "America/Los_Angeles", now: () => instant });
  const error = await rejection(losAngeles.service.createAttendance(principalFor("admin"), { ...CREATE_INPUT, work_date: "2026-10-03" }));
  assert.equal(error.code, "work_date_in_future");

  const karachi = buildService({ timeZone: "Asia/Karachi", now: () => instant });
  await karachi.service.createAttendance(principalFor("admin"), { ...CREATE_INPUT, work_date: "2026-10-03" });
  assert.equal(karachi.attendanceRepository.calls.create.length, 1);
});

test("the clock is read per call, not captured once at construction", async () => {
  let current = new Date("2026-10-02T10:00:00Z");
  const { service } = buildService({ now: () => current });

  const error = await rejection(service.createAttendance(principalFor("admin"), { ...CREATE_INPUT, work_date: "2026-10-03" }));
  assert.equal(error.code, "work_date_in_future");

  current = new Date("2026-10-03T10:00:00Z");
  await service.createAttendance(principalFor("admin"), { ...CREATE_INPUT, work_date: "2026-10-03" });
});

// ---------------------------------------------------------------------------
// updateAttendance
// ---------------------------------------------------------------------------

test("updateAttendance: a missing record is a 404", async () => {
  const { service, attendanceRepository } = buildService();

  const error = await rejection(service.updateAttendance(principalFor("admin"), "missing", { notes: "x" }));

  assert.equal(error.statusCode, 404);
  assert.equal(attendanceRepository.calls.updateById.length, 0);
});

test("updateAttendance: a repository null (deleted between the read and the write) is a 404", async () => {
  const { service, attendanceRepository } = buildService();
  attendanceRepository.updateById = async () => null;

  const error = await rejection(service.updateAttendance(principalFor("admin"), "att-1", { notes: "x" }));

  assert.equal(error.statusCode, 404);
});

test("updateAttendance: an ordinary edit is scope-checked against the record's current employee", async () => {
  const { service, attendanceRepository } = buildService({
    records: [record({ employee_id: "emp-3", employee_department_id: OTHER_DEPARTMENT })],
  });

  const error = await rejection(service.updateAttendance(principalFor("manager"), "att-1", { notes: "x" }));

  assert.equal(error.code, "attendance_scope_denied");
  assert.equal(attendanceRepository.calls.updateById.length, 0);
});

test("updateAttendance: D27 -- a manager cannot pull a record IN from another department", async () => {
  // The record belongs to emp-3 (other department); the manager asks to move it to emp-1, who
  // is in their own department. Only the destination is in scope.
  const { service, attendanceRepository } = buildService({
    records: [record({ employee_id: "emp-3", employee_department_id: OTHER_DEPARTMENT })],
  });

  const error = await rejection(service.updateAttendance(principalFor("manager"), "att-1", { employee_id: "emp-1" }));

  assert.equal(error.statusCode, 403);
  assert.equal(error.code, "attendance_scope_denied");
  assert.match(error.message, /belongs to an employee outside your scope/);
  assert.equal(attendanceRepository.calls.updateById.length, 0);
});

test("updateAttendance: D27 -- a manager cannot push a record OUT to another department", async () => {
  const { service, attendanceRepository } = buildService();

  const error = await rejection(service.updateAttendance(principalFor("manager"), "att-1", { employee_id: "emp-3" }));

  assert.equal(error.statusCode, 403);
  assert.equal(error.code, "attendance_scope_denied");
  assert.match(error.message, /moving this record to is outside your scope/);
  assert.equal(attendanceRepository.calls.updateById.length, 0);
});

test("updateAttendance: re-attribution inside the manager's department succeeds", async () => {
  const { service, attendanceRepository } = buildService();

  await service.updateAttendance(principalFor("manager"), "att-1", { employee_id: "emp-2" });

  assert.deepEqual(attendanceRepository.calls.updateById, [{ id: "att-1", changes: { employee_id: "emp-2" } }]);
});

test("updateAttendance: admin and hr may re-attribute across departments", async () => {
  for (const role of ["admin", "hr"]) {
    const { service, attendanceRepository } = buildService();

    await service.updateAttendance(principalFor(role, { departmentId: null }), "att-1", { employee_id: "emp-3" });

    assert.equal(attendanceRepository.calls.updateById.length, 1, role);
  }
});

test("updateAttendance: re-attribution to an employee that does not exist is a 400 invalid_employee", async () => {
  const { service } = buildService();

  const error = await rejection(service.updateAttendance(principalFor("admin"), "att-1", { employee_id: "missing" }));

  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "invalid_employee");
});

test("updateAttendance: D27 -- the active-employee requirement applies to re-attribution", async () => {
  const { service, attendanceRepository } = buildService();

  const error = await rejection(service.updateAttendance(principalFor("admin"), "att-1", { employee_id: "emp-4" }));

  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "employee_not_active");
  assert.equal(attendanceRepository.calls.updateById.length, 0);
});

test("updateAttendance: D27 -- an ordinary edit of a terminated employee's record still succeeds", async () => {
  // Historical records of a deactivated employee must stay correctable; Firestore blocked this.
  const { service, attendanceRepository } = buildService({
    records: [record({ employee_id: "emp-4", employee_department_id: DEPARTMENT })],
  });

  await service.updateAttendance(principalFor("manager"), "att-1", { status: "late", check_in: "10:30" });

  assert.equal(attendanceRepository.calls.updateById.length, 1);
});

test("updateAttendance: a payload carrying the unchanged employee_id is not a re-attribution", async () => {
  // emp-4 is terminated; resending their own id must not trigger the active requirement.
  const { service, attendanceRepository } = buildService({
    records: [record({ employee_id: "emp-4", employee_department_id: DEPARTMENT })],
  });

  await service.updateAttendance(principalFor("admin"), "att-1", { employee_id: "emp-4", notes: "corrected" });

  assert.equal(attendanceRepository.calls.updateById.length, 1);
});

test("updateAttendance: a work_date change is future-checked in the company timezone", async () => {
  const { service, attendanceRepository } = buildService({ now: () => new Date("2026-10-02T18:59:59Z") });

  const error = await rejection(service.updateAttendance(principalFor("admin"), "att-1", { work_date: "2026-10-03" }));
  assert.equal(error.code, "work_date_in_future");
  assert.equal(attendanceRepository.calls.updateById.length, 0);

  await service.updateAttendance(principalFor("admin"), "att-1", { work_date: "2026-10-02" });
  assert.equal(attendanceRepository.calls.updateById.length, 1);
});

test("updateAttendance: an edit that does not touch work_date is not date-checked", async () => {
  // The stored date is untouched, so a record dated in the (stale-clock) future is not
  // re-judged by an unrelated notes edit.
  const { service, attendanceRepository } = buildService({
    records: [record({ work_date: "2099-01-01" })],
  });

  await service.updateAttendance(principalFor("admin"), "att-1", { notes: "x" });

  assert.equal(attendanceRepository.calls.updateById.length, 1);
});

test("updateAttendance: past records are editable with no window (D27)", async () => {
  const { service, attendanceRepository } = buildService({
    records: [record({ work_date: "2020-01-01" })],
  });

  await service.updateAttendance(principalFor("manager"), "att-1", { work_date: "2020-01-02", status: "late" });

  assert.equal(attendanceRepository.calls.updateById.length, 1);
});

// ---------------------------------------------------------------------------
// deleteAttendance
// ---------------------------------------------------------------------------

test("deleteAttendance: D27 -- the principal's employee id is passed as the deleter", async () => {
  const { service, attendanceRepository } = buildService();

  await service.deleteAttendance(principalFor("manager", { employeeId: "the-deleter" }), "att-1");

  assert.deepEqual(attendanceRepository.calls.deleteById, [{ id: "att-1", deletedBy: "the-deleter" }]);
});

test("deleteAttendance: a missing record is a 404", async () => {
  const { service, attendanceRepository } = buildService();

  const error = await rejection(service.deleteAttendance(principalFor("admin"), "missing"));

  assert.equal(error.statusCode, 404);
  assert.equal(attendanceRepository.calls.deleteById.length, 0);
});

test("deleteAttendance: a manager is denied for a record belonging to another department", async () => {
  const { service, attendanceRepository } = buildService({
    records: [record({ employee_id: "emp-3", employee_department_id: OTHER_DEPARTMENT })],
  });

  const error = await rejection(service.deleteAttendance(principalFor("manager"), "att-1"));

  assert.equal(error.code, "attendance_scope_denied");
  assert.equal(attendanceRepository.calls.deleteById.length, 0);
});

test("deleteAttendance: no active-employee or date requirement -- a terminated employee's old record can be deleted", async () => {
  const { service, attendanceRepository } = buildService({
    records: [record({ employee_id: "emp-4", work_date: "2019-05-05" })],
    now: () => new Date("2026-10-02T20:00:00Z"),
  });

  await service.deleteAttendance(principalFor("manager"), "att-1");

  assert.equal(attendanceRepository.calls.deleteById.length, 1);
});
