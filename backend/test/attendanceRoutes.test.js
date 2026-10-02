import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createAttendanceMutationService } from "../src/services/attendanceMutationService.js";
import { HttpError } from "../src/utils/httpError.js";
import { USER_ROLES } from "../src/utils/roles.js";

// HTTP-level. The authorization matrix lives in attendanceAuthorization.test.js and the
// service rules in attendanceMutationService.test.js; these tests prove the real
// attendanceMutationService + attendanceAuthorizationService are wired to real HTTP status
// codes and bodies, and that the strict schemas guard the door -- against fake repositories
// (no database).

const DEPARTMENT = randomUUID();
const OTHER_DEPARTMENT = randomUUID();

const EMP_IN = randomUUID();          // active, principal's department
const EMP_IN_2 = randomUUID();        // active, principal's department
const EMP_OUT = randomUUID();         // active, other department
const EMP_TERMINATED = randomUUID();  // terminated, principal's department

const EMPLOYEES = [
  { id: EMP_IN, department_id: DEPARTMENT, employment_status: "active" },
  { id: EMP_IN_2, department_id: DEPARTMENT, employment_status: "active" },
  { id: EMP_OUT, department_id: OTHER_DEPARTMENT, employment_status: "active" },
  { id: EMP_TERMINATED, department_id: DEPARTMENT, employment_status: "terminated" },
];

function principalFor(role, overrides = {}) {
  return { userId: randomUUID(), employeeId: randomUUID(), role, departmentId: DEPARTMENT, isTeamLead: role === "tl", ...overrides };
}

function attendanceRecord(overrides = {}) {
  return {
    id: randomUUID(), employee_id: EMP_IN, employee_department_id: DEPARTMENT, work_date: "2026-10-01",
    status: "present", check_in: "09:00", check_out: "17:00", notes: null, ...overrides,
  };
}

/**
 * Mirrors the real repository's contract: findById returns the record with its employee's
 * department, create/updateById throw the same 409 the unique index would (with the occupant's
 * id), deleteById throws the same 404 for a record that is gone.
 */
function fakeAttendanceRepository(seed = [], { occupant = null } = {}) {
  const byId = new Map(seed.map((row) => [row.id, row]));
  const calls = { create: [], updateById: [], deleteById: [] };
  const duplicate = () => new HttpError(
    409, "attendance_already_recorded", "Attendance is already recorded for this employee on this date.",
    { existing_id: occupant },
  );
  return {
    calls,
    async findById(id) { return byId.get(id) ?? null; },
    async create(input) {
      calls.create.push(input);
      if (occupant) throw duplicate();
      return { id: randomUUID(), ...input };
    },
    async updateById(id, changes) {
      calls.updateById.push({ id, changes });
      if (occupant && Object.hasOwn(changes, "work_date")) throw duplicate();
      if (!byId.has(id)) return null;
      return { ...byId.get(id), ...changes };
    },
    async deleteById(id, deletedBy) {
      calls.deleteById.push({ id, deletedBy });
      if (!byId.has(id)) throw new HttpError(404, "not_found", "Attendance record not found.");
    },
  };
}

// 2026-10-02T20:00Z is Oct 3 in Karachi, still Oct 2 in UTC.
const NOW = new Date("2026-10-02T20:00:00Z");

async function startApp(principal, repository, { now = () => NOW } = {}) {
  const attendanceMutationService = createAttendanceMutationService({
    attendanceRepository: repository,
    employeeRepository: { async findById(id) { return EMPLOYEES.find((row) => row.id === id) ?? null; } },
    timeZone: "Asia/Karachi",
    now,
  });
  const app = createApp({
    verifyAccessToken: async () => principal,
    repositories: {},
    attendanceMutationService,
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    async request(method, pathname, body) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const VALID_CREATE_BODY = Object.freeze({
  employee_id: EMP_IN, work_date: "2026-10-01", status: "present", check_in: "09:00", check_out: "17:00",
});

const WRITER_ROLES = new Set(["admin", "hr", "manager"]);

// ---------------------------------------------------------------------------
// Role matrices: every role against each of the three operations
// ---------------------------------------------------------------------------

test("POST /attendance: admin, hr and manager create (201); tl and employee are denied (403)", async () => {
  for (const role of USER_ROLES) {
    const repository = fakeAttendanceRepository();
    const app = await startApp(principalFor(role), repository);
    try {
      const response = await app.request("POST", "/api/v1/attendance", VALID_CREATE_BODY);
      if (WRITER_ROLES.has(role)) {
        assert.equal(response.status, 201, role);
        assert.equal(response.body.data.employee_id, EMP_IN, role);
        assert.equal(repository.calls.create.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(response.body.error.code, "role_not_allowed", role);
        assert.equal(repository.calls.create.length, 0, role);
      }
    } finally {
      await app.close();
    }
  }
});

test("PATCH /attendance/:id: admin, hr and manager update (200); tl and employee are denied (403)", async () => {
  const target = attendanceRecord();
  for (const role of USER_ROLES) {
    const repository = fakeAttendanceRepository([target]);
    const app = await startApp(principalFor(role), repository);
    try {
      const response = await app.request("PATCH", `/api/v1/attendance/${target.id}`, { status: "late", check_in: "10:00" });
      if (WRITER_ROLES.has(role)) {
        assert.equal(response.status, 200, role);
        assert.equal(response.body.data.status, "late", role);
        assert.equal(repository.calls.updateById.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(response.body.error.code, "role_not_allowed", role);
        assert.equal(repository.calls.updateById.length, 0, role);
      }
    } finally {
      await app.close();
    }
  }
});

test("DELETE /attendance/:id: admin, hr and manager delete (204); tl and employee are denied (403)", async () => {
  const target = attendanceRecord();
  for (const role of USER_ROLES) {
    const repository = fakeAttendanceRepository([target]);
    const app = await startApp(principalFor(role), repository);
    try {
      const response = await app.request("DELETE", `/api/v1/attendance/${target.id}`);
      if (WRITER_ROLES.has(role)) {
        assert.equal(response.status, 204, role);
        assert.equal(repository.calls.deleteById.length, 1, role);
      } else {
        assert.equal(response.status, 403, role);
        assert.equal(repository.calls.deleteById.length, 0, role);
      }
    } finally {
      await app.close();
    }
  }
});

test("a manager's scope is their own department on every write operation", async () => {
  const outOfScope = attendanceRecord({ employee_id: EMP_OUT, employee_department_id: OTHER_DEPARTMENT });
  const repository = fakeAttendanceRepository([outOfScope]);
  const app = await startApp(principalFor("manager"), repository);
  try {
    const create = await app.request("POST", "/api/v1/attendance", { ...VALID_CREATE_BODY, employee_id: EMP_OUT });
    const update = await app.request("PATCH", `/api/v1/attendance/${outOfScope.id}`, { notes: "x" });
    const remove = await app.request("DELETE", `/api/v1/attendance/${outOfScope.id}`);

    for (const response of [create, update, remove]) {
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, "attendance_scope_denied");
    }
    assert.equal(repository.calls.create.length + repository.calls.updateById.length + repository.calls.deleteById.length, 0);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D27: two-sided re-attribution, over HTTP
// ---------------------------------------------------------------------------

test("PATCH: a manager cannot pull a record IN from another department (403)", async () => {
  const target = attendanceRecord({ employee_id: EMP_OUT, employee_department_id: OTHER_DEPARTMENT });
  const repository = fakeAttendanceRepository([target]);
  const app = await startApp(principalFor("manager"), repository);
  try {
    const response = await app.request("PATCH", `/api/v1/attendance/${target.id}`, { employee_id: EMP_IN });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "attendance_scope_denied");
    assert.equal(repository.calls.updateById.length, 0);
  } finally {
    await app.close();
  }
});

test("PATCH: a manager cannot push a record OUT to another department (403)", async () => {
  const target = attendanceRecord();
  const repository = fakeAttendanceRepository([target]);
  const app = await startApp(principalFor("manager"), repository);
  try {
    const response = await app.request("PATCH", `/api/v1/attendance/${target.id}`, { employee_id: EMP_OUT });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "attendance_scope_denied");
    assert.equal(repository.calls.updateById.length, 0);
  } finally {
    await app.close();
  }
});

test("PATCH: re-attribution within the manager's department (200), and admin across departments (200)", async () => {
  const target = attendanceRecord();

  const managerRepository = fakeAttendanceRepository([target]);
  const managerApp = await startApp(principalFor("manager"), managerRepository);
  try {
    const response = await managerApp.request("PATCH", `/api/v1/attendance/${target.id}`, { employee_id: EMP_IN_2 });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.employee_id, EMP_IN_2);
  } finally {
    await managerApp.close();
  }

  const adminRepository = fakeAttendanceRepository([target]);
  const adminApp = await startApp(principalFor("admin"), adminRepository);
  try {
    const response = await adminApp.request("PATCH", `/api/v1/attendance/${target.id}`, { employee_id: EMP_OUT });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.employee_id, EMP_OUT);
  } finally {
    await adminApp.close();
  }
});

// ---------------------------------------------------------------------------
// D27: the active-employee requirement
// ---------------------------------------------------------------------------

test("POST: a terminated employee is refused (400 employee_not_active)", async () => {
  const repository = fakeAttendanceRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("POST", "/api/v1/attendance", { ...VALID_CREATE_BODY, employee_id: EMP_TERMINATED });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "employee_not_active");
    assert.equal(repository.calls.create.length, 0);
  } finally {
    await app.close();
  }
});

test("PATCH: re-attributing onto a terminated employee is refused, but an ordinary edit of their record succeeds", async () => {
  const live = attendanceRecord();
  const historical = attendanceRecord({ employee_id: EMP_TERMINATED });
  const repository = fakeAttendanceRepository([live, historical]);
  const app = await startApp(principalFor("admin"), repository);
  try {
    const refused = await app.request("PATCH", `/api/v1/attendance/${live.id}`, { employee_id: EMP_TERMINATED });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, "employee_not_active");

    const edited = await app.request("PATCH", `/api/v1/attendance/${historical.id}`, { notes: "corrected after exit" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.data.notes, "corrected after exit");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D27: future dates in the company timezone
// ---------------------------------------------------------------------------

test("POST: the future-date boundary is Karachi midnight, not UTC midnight", async () => {
  // NOW is 01:00 Oct 3 in Karachi: Oct 3 is today (accepted), Oct 4 is the future (rejected).
  // A UTC check would call Oct 3 the future.
  const repository = fakeAttendanceRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    const today = await app.request("POST", "/api/v1/attendance", { ...VALID_CREATE_BODY, work_date: "2026-10-03" });
    assert.equal(today.status, 201);

    const tomorrow = await app.request("POST", "/api/v1/attendance", { ...VALID_CREATE_BODY, work_date: "2026-10-04" });
    assert.equal(tomorrow.status, 400);
    assert.equal(tomorrow.body.error.code, "work_date_in_future");
  } finally {
    await app.close();
  }
});

test("PATCH: moving a record's work_date into the future is refused (400), a past date is fine", async () => {
  const target = attendanceRecord();
  const repository = fakeAttendanceRepository([target]);
  const app = await startApp(principalFor("admin"), repository);
  try {
    const future = await app.request("PATCH", `/api/v1/attendance/${target.id}`, { work_date: "2026-10-04" });
    assert.equal(future.status, 400);
    assert.equal(future.body.error.code, "work_date_in_future");

    const past = await app.request("PATCH", `/api/v1/attendance/${target.id}`, { work_date: "2020-01-01" });
    assert.equal(past.status, 200);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D9: duplicate day
// ---------------------------------------------------------------------------

test("POST: a duplicate employee/day is a 409 whose body carries the existing record's id", async () => {
  const occupant = randomUUID();
  const repository = fakeAttendanceRepository([], { occupant });
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("POST", "/api/v1/attendance", VALID_CREATE_BODY);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "attendance_already_recorded");
    assert.deepEqual(response.body.error.details, { existing_id: occupant });
    assert.ok(response.body.error.requestId, "the standard error envelope is intact");
  } finally {
    await app.close();
  }
});

test("PATCH: moving a record onto an occupied day is the same 409 with the occupant's id", async () => {
  const occupant = randomUUID();
  const target = attendanceRecord();
  const repository = fakeAttendanceRepository([target], { occupant });
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("PATCH", `/api/v1/attendance/${target.id}`, { work_date: "2026-09-30" });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "attendance_already_recorded");
    assert.deepEqual(response.body.error.details, { existing_id: occupant });
  } finally {
    await app.close();
  }
});

test("errors without details keep their original shape -- no stray details key", async () => {
  const repository = fakeAttendanceRepository();
  const app = await startApp(principalFor("tl"), repository);
  try {
    const response = await app.request("POST", "/api/v1/attendance", VALID_CREATE_BODY);
    assert.equal(response.status, 403);
    assert.equal(Object.hasOwn(response.body.error, "details"), false);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D27: soft delete records the deleter
// ---------------------------------------------------------------------------

test("DELETE: the repository receives the acting principal's employee id as the deleter", async () => {
  const target = attendanceRecord();
  const repository = fakeAttendanceRepository([target]);
  const principal = principalFor("manager");
  const app = await startApp(principal, repository);
  try {
    const response = await app.request("DELETE", `/api/v1/attendance/${target.id}`);
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
    assert.deepEqual(repository.calls.deleteById, [{ id: target.id, deletedBy: principal.employeeId }]);
  } finally {
    await app.close();
  }
});

test("DELETE: a record that vanishes between the read and the write is a 404, not a 500", async () => {
  const target = attendanceRecord();
  const repository = fakeAttendanceRepository([target]);
  // Visible to findById, gone by the time deleteById runs.
  repository.deleteById = async () => { throw new HttpError(404, "not_found", "Attendance record not found."); };
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("DELETE", `/api/v1/attendance/${target.id}`);
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Schema enforcement
// ---------------------------------------------------------------------------

test("POST: server-owned and unknown fields are rejected outright, not silently ignored", async () => {
  const forbidden = {
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    deleted_at: null,
    deleted_by_employee_id: randomUUID(),
    id: randomUUID(),
    unexpected: true,
  };
  for (const [key, value] of Object.entries(forbidden)) {
    const repository = fakeAttendanceRepository();
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("POST", "/api/v1/attendance", { ...VALID_CREATE_BODY, [key]: value });
      assert.equal(response.status, 400, key);
      assert.equal(response.body.error.code, "invalid_request", key);
      assert.equal(repository.calls.create.length, 0, key);
    } finally {
      await app.close();
    }
  }
});

test("PATCH: server-owned and unknown fields are rejected, and an empty body is rejected", async () => {
  const target = attendanceRecord();
  const bodies = [
    { updated_at: "2026-10-01T00:00:00Z" },
    { created_at: "2026-10-01T00:00:00Z" },
    { deleted_at: null },
    { deleted_by_employee_id: randomUUID() },
    { id: randomUUID() },
    { unexpected: true },
    {},
  ];
  for (const body of bodies) {
    const repository = fakeAttendanceRepository([target]);
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("PATCH", `/api/v1/attendance/${target.id}`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(repository.calls.updateById.length, 0, JSON.stringify(body));
    } finally {
      await app.close();
    }
  }
});

test("POST: required fields are required", async () => {
  for (const missing of ["employee_id", "work_date", "status"]) {
    const body = { ...VALID_CREATE_BODY };
    delete body[missing];
    const repository = fakeAttendanceRepository();
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("POST", "/api/v1/attendance", body);
      assert.equal(response.status, 400, missing);
    } finally {
      await app.close();
    }
  }
});

test("POST: malformed values are rejected -- date, time, status, notes length, employee id", async () => {
  const bad = [
    { work_date: "2026-02-30" },        // not a real calendar date
    { work_date: "10/01/2026" },
    { work_date: "2026-10-01T00:00:00Z" },
    { check_in: "9:00" },               // not zero-padded
    { check_in: "24:00" },              // hour out of range
    { check_in: "09:60" },              // minute out of range
    { check_in: "09:00:00" },           // seconds are not part of the wire format
    { check_in: "" },                   // no "" sentinel -- null is the only empty value
    { status: "holiday" },
    { notes: "x".repeat(2001) },
    { employee_id: "not-a-uuid" },
  ];
  for (const override of bad) {
    const repository = fakeAttendanceRepository();
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("POST", "/api/v1/attendance", { ...VALID_CREATE_BODY, ...override });
      assert.equal(response.status, 400, JSON.stringify(override));
      assert.equal(repository.calls.create.length, 0, JSON.stringify(override));
    } finally {
      await app.close();
    }
  }
});

test("POST: absent and leave records cannot carry times; check_out must be later than check_in", async () => {
  const bad = [
    { status: "absent", check_in: "09:00", check_out: null },
    { status: "leave", check_in: null, check_out: "17:00" },
    { status: "present", check_in: "17:00", check_out: "09:00" },
    { status: "present", check_in: "09:00", check_out: "09:00" },
  ];
  for (const override of bad) {
    const repository = fakeAttendanceRepository();
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("POST", "/api/v1/attendance", { ...VALID_CREATE_BODY, ...override });
      assert.equal(response.status, 400, JSON.stringify(override));
      assert.equal(repository.calls.create.length, 0, JSON.stringify(override));
    } finally {
      await app.close();
    }
  }
});

test("POST: times and notes may be omitted or null; an absent record with no times is valid", async () => {
  const repository = fakeAttendanceRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("POST", "/api/v1/attendance", {
      employee_id: EMP_IN, work_date: "2026-10-01", status: "absent",
    });
    assert.equal(response.status, 201);
    assert.deepEqual(repository.calls.create[0], {
      employee_id: EMP_IN, work_date: "2026-10-01", status: "absent", check_in: null, check_out: null, notes: null,
    });
  } finally {
    await app.close();
  }
});

test("PATCH: a null clears a time, and the payload's own absent/ordering rules still apply", async () => {
  const target = attendanceRecord();
  const repository = fakeAttendanceRepository([target]);
  const app = await startApp(principalFor("admin"), repository);
  try {
    const cleared = await app.request("PATCH", `/api/v1/attendance/${target.id}`, { check_out: null });
    assert.equal(cleared.status, 200);
    assert.deepEqual(repository.calls.updateById[0].changes, { check_out: null });

    const absentWithTime = await app.request("PATCH", `/api/v1/attendance/${target.id}`, { status: "absent", check_in: "09:00" });
    assert.equal(absentWithTime.status, 400);

    const reversed = await app.request("PATCH", `/api/v1/attendance/${target.id}`, { check_in: "17:00", check_out: "09:00" });
    assert.equal(reversed.status, 400);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// id handling
// ---------------------------------------------------------------------------

test("PATCH and DELETE: a malformed id is a 404, matching the read path's convention", async () => {
  const repository = fakeAttendanceRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    assert.equal((await app.request("PATCH", "/api/v1/attendance/not-a-uuid", { notes: "x" })).status, 404);
    assert.equal((await app.request("DELETE", "/api/v1/attendance/not-a-uuid")).status, 404);
    assert.equal(repository.calls.updateById.length + repository.calls.deleteById.length, 0);
  } finally {
    await app.close();
  }
});

test("PATCH and DELETE: a well-formed but nonexistent id is a 404", async () => {
  const repository = fakeAttendanceRepository([]);
  const app = await startApp(principalFor("admin"), repository);
  try {
    assert.equal((await app.request("PATCH", `/api/v1/attendance/${randomUUID()}`, { notes: "x" })).status, 404);
    assert.equal((await app.request("DELETE", `/api/v1/attendance/${randomUUID()}`)).status, 404);
  } finally {
    await app.close();
  }
});

test("POST: an employee_id that does not exist is a 400", async () => {
  const repository = fakeAttendanceRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("POST", "/api/v1/attendance", { ...VALID_CREATE_BODY, employee_id: randomUUID() });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid_employee");
  } finally {
    await app.close();
  }
});
