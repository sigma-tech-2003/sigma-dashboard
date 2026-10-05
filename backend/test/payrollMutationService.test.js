import assert from "node:assert/strict";
import test from "node:test";
import { createPayrollMutationService } from "../src/services/payrollMutationService.js";
import { HttpError } from "../src/utils/httpError.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Fake repository-interface level, mirroring attendanceMutationService.test.js.
// The authorization gate itself is covered in payrollAuthorization.test.js; these tests prove the
// service calls it first and owns what a column cannot express (D28): defaulting basic and
// allowances from the employee, the employee existing, and a processed record being immutable.

const principalFor = (role, overrides = {}) => ({
  userId: "principal-user", employeeId: "principal-emp", role, departmentId: "dept-1", ...overrides,
});

// pg returns numeric as a string, so the employee row carries strings -- the fake does too.
const EMPLOYEES = Object.freeze({
  active: { id: "emp-1", basic: "50000.00", allowances: "5000.00", employment_status: "active" },
  other: { id: "emp-2", basic: "70000.00", allowances: "0.00", employment_status: "active" },
  terminated: { id: "emp-3", basic: "40000.00", allowances: "2500.00", employment_status: "terminated" },
  inactive: { id: "emp-4", basic: "30000.00", allowances: "0.00", employment_status: "inactive" },
  onLeave: { id: "emp-5", basic: "30000.00", allowances: "0.00", employment_status: "on_leave" },
});

function fakeEmployeeRepository(seed = Object.values(EMPLOYEES)) {
  const byId = new Map(seed.map((row) => [row.id, row]));
  const lookups = [];
  return { lookups, async findById(id) { lookups.push(id); return byId.get(id) ?? null; } };
}

function fakePayrollRepository(records = []) {
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

const draft = (overrides = {}) => ({ id: "draft-1", employee_id: "emp-1", status: "draft", ...overrides });
const processed = (overrides = {}) => ({ id: "proc-1", employee_id: "emp-1", status: "processed", ...overrides });

function buildService({ records = [draft(), processed()], employees } = {}) {
  const payrollRepository = fakePayrollRepository(records);
  const employeeRepository = fakeEmployeeRepository(employees);
  const service = createPayrollMutationService({ payrollRepository, employeeRepository });
  return { service, payrollRepository, employeeRepository };
}

// What the controller hands the service: the schema has already applied its defaults.
const CREATE_INPUT = Object.freeze({
  employee_id: "emp-1", period_year: 2026, period_month: 9, bonus: 0, deductions: 0, status: "processed",
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

test("createPayroll: admin and hr allowed; manager, tl and employee denied before any repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, payrollRepository, employeeRepository } = buildService();
    const call = service.createPayroll(principalFor(role), CREATE_INPUT);

    if (role === "admin" || role === "hr") {
      await call;
      assert.equal(payrollRepository.calls.create.length, 1, role);
    } else {
      const error = await rejection(call);
      assert.equal(error.statusCode, 403, role);
      assert.equal(error.code, "role_not_allowed", role);
      assert.equal(payrollRepository.calls.create.length, 0, role);
      assert.equal(employeeRepository.lookups.length, 0, `${role} must not even reach the employee lookup`);
    }
  }
});

test("updatePayroll: admin and hr allowed; manager, tl and employee denied before any repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, payrollRepository } = buildService();
    const call = service.updatePayroll(principalFor(role), "draft-1", { bonus: 100 });

    if (role === "admin" || role === "hr") {
      await call;
      assert.equal(payrollRepository.calls.updateById.length, 1, role);
    } else {
      assert.equal((await rejection(call)).code, "role_not_allowed", role);
      assert.equal(payrollRepository.calls.updateById.length, 0, role);
    }
  }
});

test("deletePayroll: admin and hr allowed; manager, tl and employee denied before any repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, payrollRepository } = buildService();
    const call = service.deletePayroll(principalFor(role), "proc-1");

    if (role === "admin" || role === "hr") {
      await call;
      assert.equal(payrollRepository.calls.deleteById.length, 1, role);
    } else {
      assert.equal((await rejection(call)).code, "role_not_allowed", role);
      assert.equal(payrollRepository.calls.deleteById.length, 0, role);
    }
  }
});

test("an admin or hr account with no employee record is denied on every operation", async () => {
  for (const role of ["admin", "hr"]) {
    const { service, payrollRepository } = buildService();
    const unlinked = principalFor(role, { employeeId: null });

    assert.equal((await rejection(service.createPayroll(unlinked, CREATE_INPUT))).code, "role_not_allowed", role);
    assert.equal((await rejection(service.updatePayroll(unlinked, "draft-1", { bonus: 1 }))).code, "role_not_allowed", role);
    assert.equal((await rejection(service.deletePayroll(unlinked, "proc-1"))).code, "role_not_allowed", role);
    const { create, updateById, deleteById } = payrollRepository.calls;
    assert.equal(create.length + updateById.length + deleteById.length, 0, role);
  }
});

// ---------------------------------------------------------------------------
// createPayroll: defaults, overrides, eligibility (D28)
// ---------------------------------------------------------------------------

test("createPayroll: D28 -- basic and allowances default to the employee's current values when omitted", async () => {
  const { service, payrollRepository } = buildService();

  await service.createPayroll(principalFor("admin"), CREATE_INPUT);

  const [created] = payrollRepository.calls.create;
  // The employee row's numerics are strings and are passed straight to a numeric parameter.
  assert.equal(created.basic, "50000.00");
  assert.equal(created.allowances, "5000.00");
  assert.equal(created.employee_id, "emp-1");
});

test("createPayroll: D28 -- explicit basic and allowances win over the employee's", async () => {
  const { service, payrollRepository } = buildService();

  await service.createPayroll(principalFor("admin"), { ...CREATE_INPUT, basic: 42000, allowances: 1500 });

  const [created] = payrollRepository.calls.create;
  assert.equal(created.basic, 42000);
  assert.equal(created.allowances, 1500);
});

test("createPayroll: an explicit allowances of 0 is an override, not 'omitted' -- it must not fall back to the employee's", async () => {
  // The employee has allowances of 5000.00; a caller who says 0 means 0. A truthiness-based
  // default would silently pay 5000.
  const { service, payrollRepository } = buildService();

  await service.createPayroll(principalFor("admin"), { ...CREATE_INPUT, basic: 0, allowances: 0 });

  const [created] = payrollRepository.calls.create;
  assert.equal(created.basic, 0);
  assert.equal(created.allowances, 0);
});

test("createPayroll: overriding one of the two defaults the other", async () => {
  const { service, payrollRepository } = buildService();

  await service.createPayroll(principalFor("admin"), { ...CREATE_INPUT, basic: 61000 });

  const [created] = payrollRepository.calls.create;
  assert.equal(created.basic, 61000);
  assert.equal(created.allowances, "5000.00");
});

test("createPayroll: passes the validated input through -- status, bonus, deductions, period -- and invents nothing", async () => {
  const { service, payrollRepository } = buildService();

  await service.createPayroll(principalFor("hr"), {
    ...CREATE_INPUT, period_year: 2025, period_month: 12, bonus: 250, deductions: 80, status: "draft",
  });

  assert.deepEqual(payrollRepository.calls.create[0], {
    employee_id: "emp-1", period_year: 2025, period_month: 12, bonus: 250, deductions: 80, status: "draft",
    basic: "50000.00", allowances: "5000.00",
  });
  for (const key of ["gross", "tax", "net", "created_at", "updated_at", "deleted_at", "deleted_by_employee_id"]) {
    assert.equal(Object.hasOwn(payrollRepository.calls.create[0], key), false, key);
  }
});

test("createPayroll: an employee_id that does not exist is a 400 invalid_employee", async () => {
  const { service, payrollRepository } = buildService();

  const error = await rejection(service.createPayroll(principalFor("admin"), { ...CREATE_INPUT, employee_id: "missing" }));

  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "invalid_employee");
  assert.equal(payrollRepository.calls.create.length, 0);
});

test("createPayroll: D28 -- a terminated, inactive or on-leave employee is accepted (final pay)", async () => {
  // Deliberately unlike attendance (D27): Firestore only required the employee to exist.
  for (const employee of [EMPLOYEES.terminated, EMPLOYEES.inactive, EMPLOYEES.onLeave]) {
    const { service, payrollRepository } = buildService();

    await service.createPayroll(principalFor("admin"), { ...CREATE_INPUT, employee_id: employee.id });

    assert.equal(payrollRepository.calls.create.length, 1, employee.employment_status);
    assert.equal(payrollRepository.calls.create[0].basic, employee.basic, employee.employment_status);
  }
});

test("createPayroll: D28 -- there is no temporal check; a far-future and a far-past period are both accepted", async () => {
  const { service, payrollRepository } = buildService();

  await service.createPayroll(principalFor("admin"), { ...CREATE_INPUT, period_year: 2099, period_month: 12 });
  await service.createPayroll(principalFor("admin"), { ...CREATE_INPUT, period_year: 1, period_month: 1 });

  assert.equal(payrollRepository.calls.create.length, 2);
});

test("createPayroll: a repository error (such as the duplicate-period 409) propagates unchanged", async () => {
  const { service, payrollRepository } = buildService();
  const duplicate = new HttpError(409, "payroll_already_recorded", "dup", { existing_id: "existing" });
  payrollRepository.create = async () => { throw duplicate; };

  const error = await rejection(service.createPayroll(principalFor("admin"), CREATE_INPUT));

  assert.equal(error, duplicate);
});

// ---------------------------------------------------------------------------
// updatePayroll: drafts editable and promotable, processed immutable (D28)
// ---------------------------------------------------------------------------

test("updatePayroll: D28 -- a draft's fields are editable", async () => {
  const { service, payrollRepository } = buildService();

  await service.updatePayroll(principalFor("hr"), "draft-1", {
    period_year: 2026, period_month: 10, basic: 45000, allowances: 100, bonus: 500, deductions: 20,
  });

  assert.deepEqual(payrollRepository.calls.updateById, [{
    id: "draft-1",
    changes: { period_year: 2026, period_month: 10, basic: 45000, allowances: 100, bonus: 500, deductions: 20 },
  }]);
});

test("updatePayroll: D28 -- a draft can be promoted to processed on its own", async () => {
  const { service, payrollRepository } = buildService();

  const result = await service.updatePayroll(principalFor("admin"), "draft-1", { status: "processed" });

  assert.deepEqual(payrollRepository.calls.updateById, [{ id: "draft-1", changes: { status: "processed" } }]);
  assert.equal(result.status, "processed");
});

test("updatePayroll: D28 -- a draft can be edited and promoted in the same request", async () => {
  const { service, payrollRepository } = buildService();

  await service.updatePayroll(principalFor("admin"), "draft-1", { bonus: 750, status: "processed" });

  assert.deepEqual(payrollRepository.calls.updateById[0].changes, { bonus: 750, status: "processed" });
});

test("updatePayroll: D28 -- a processed record is immutable; any field edit is a 409 payroll_not_editable", async () => {
  for (const changes of [{ bonus: 1 }, { basic: 1 }, { period_month: 2 }, { employee_id: "emp-2" }, { deductions: 5, bonus: 5 }]) {
    const { service, payrollRepository, employeeRepository } = buildService();

    const error = await rejection(service.updatePayroll(principalFor("admin"), "proc-1", changes));

    assert.equal(error.statusCode, 409, JSON.stringify(changes));
    assert.equal(error.code, "payroll_not_editable", JSON.stringify(changes));
    assert.equal(payrollRepository.calls.updateById.length, 0, JSON.stringify(changes));
    assert.equal(employeeRepository.lookups.length, 0, "the refusal comes before any employee lookup");
  }
});

test("updatePayroll: D28 -- processed -> draft is refused", async () => {
  const { service, payrollRepository } = buildService();

  const error = await rejection(service.updatePayroll(principalFor("admin"), "proc-1", { status: "draft" }));

  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "payroll_not_editable");
  assert.equal(payrollRepository.calls.updateById.length, 0);
});

test("updatePayroll: even a no-op status: processed on a processed record is refused", async () => {
  const { service } = buildService();

  const error = await rejection(service.updatePayroll(principalFor("admin"), "proc-1", { status: "processed" }));

  assert.equal(error.code, "payroll_not_editable");
});

test("updatePayroll: the record is read for its status before any write, so a processed record never reaches updateById", async () => {
  const { service, payrollRepository } = buildService();
  let reads = 0;
  const original = payrollRepository.findById;
  payrollRepository.findById = async (id) => { reads += 1; return original(id); };

  await rejection(service.updatePayroll(principalFor("admin"), "proc-1", { bonus: 1 }));

  assert.equal(reads, 1);
  assert.equal(payrollRepository.calls.updateById.length, 0);
});

test("updatePayroll: a record promoted between the service's read and the write is refused by the repository's guard, and that 409 propagates", async () => {
  const { service, payrollRepository } = buildService();
  const guard = new HttpError(409, "payroll_not_editable", "A processed payroll record cannot be changed.");
  payrollRepository.updateById = async () => { throw guard; };

  const error = await rejection(service.updatePayroll(principalFor("admin"), "draft-1", { bonus: 1 }));

  assert.equal(error, guard);
});

test("updatePayroll: a missing record is a 404", async () => {
  const { service, payrollRepository } = buildService();

  const error = await rejection(service.updatePayroll(principalFor("admin"), "missing", { bonus: 1 }));

  assert.equal(error.statusCode, 404);
  assert.equal(payrollRepository.calls.updateById.length, 0);
});

test("updatePayroll: a repository null (deleted between the read and the write) is a 404", async () => {
  const { service, payrollRepository } = buildService();
  payrollRepository.updateById = async () => null;

  const error = await rejection(service.updatePayroll(principalFor("admin"), "draft-1", { bonus: 1 }));

  assert.equal(error.statusCode, 404);
});

test("updatePayroll: moving a draft to another employee requires that employee to exist", async () => {
  const { service, payrollRepository, employeeRepository } = buildService();

  const error = await rejection(service.updatePayroll(principalFor("admin"), "draft-1", { employee_id: "missing" }));
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "invalid_employee");
  assert.equal(payrollRepository.calls.updateById.length, 0);

  await service.updatePayroll(principalFor("admin"), "draft-1", { employee_id: "emp-2" });
  assert.deepEqual(payrollRepository.calls.updateById[0].changes, { employee_id: "emp-2" });
  assert.deepEqual(employeeRepository.lookups, ["missing", "emp-2"]);
});

test("updatePayroll: moving a draft to a terminated employee is accepted (D28: employment_status is not checked)", async () => {
  const { service, payrollRepository } = buildService();

  await service.updatePayroll(principalFor("admin"), "draft-1", { employee_id: "emp-3" });

  assert.equal(payrollRepository.calls.updateById.length, 1);
});

test("updatePayroll: a payload carrying the draft's own, unchanged employee_id does no employee lookup", async () => {
  const { service, employeeRepository } = buildService();

  await service.updatePayroll(principalFor("admin"), "draft-1", { employee_id: "emp-1", bonus: 5 });

  assert.deepEqual(employeeRepository.lookups, []);
});

test("updatePayroll: basic and allowances are NOT re-defaulted when the employee changes -- defaulting is create-only", async () => {
  const { service, payrollRepository } = buildService();

  await service.updatePayroll(principalFor("admin"), "draft-1", { employee_id: "emp-2" });

  const { changes } = payrollRepository.calls.updateById[0];
  assert.equal(Object.hasOwn(changes, "basic"), false);
  assert.equal(Object.hasOwn(changes, "allowances"), false);
});

test("updatePayroll: no temporal check on a draft's period either", async () => {
  const { service, payrollRepository } = buildService();

  await service.updatePayroll(principalFor("admin"), "draft-1", { period_year: 2099, period_month: 12 });

  assert.equal(payrollRepository.calls.updateById.length, 1);
});

// ---------------------------------------------------------------------------
// deletePayroll
// ---------------------------------------------------------------------------

test("deletePayroll: D28 -- the principal's employee id is passed as the deleter", async () => {
  const { service, payrollRepository } = buildService();

  await service.deletePayroll(principalFor("hr", { employeeId: "the-deleter" }), "draft-1");

  assert.deepEqual(payrollRepository.calls.deleteById, [{ id: "draft-1", deletedBy: "the-deleter" }]);
});

test("deletePayroll: D28 -- a processed record can be deleted (the only correction path), not just a draft", async () => {
  const { service, payrollRepository } = buildService();

  await service.deletePayroll(principalFor("admin"), "proc-1");
  await service.deletePayroll(principalFor("admin"), "draft-1");

  assert.deepEqual(payrollRepository.calls.deleteById.map((call) => call.id), ["proc-1", "draft-1"]);
});

test("deletePayroll: never consults the employee -- no existence, status or scope check", async () => {
  const { service, employeeRepository } = buildService({
    records: [processed({ employee_id: "emp-3" })], // a terminated employee's old payslip
  });

  await service.deletePayroll(principalFor("admin"), "proc-1");

  assert.deepEqual(employeeRepository.lookups, []);
});

test("deletePayroll: a missing record is a 404", async () => {
  const { service, payrollRepository } = buildService();

  const error = await rejection(service.deletePayroll(principalFor("admin"), "missing"));

  assert.equal(error.statusCode, 404);
  assert.equal(payrollRepository.calls.deleteById.length, 0);
});
