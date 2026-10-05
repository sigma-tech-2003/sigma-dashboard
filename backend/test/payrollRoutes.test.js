import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createPayrollMutationService } from "../src/services/payrollMutationService.js";
import { HttpError } from "../src/utils/httpError.js";
import { USER_ROLES } from "../src/utils/roles.js";

// HTTP-level. The authorization gate lives in payrollAuthorization.test.js and the service rules
// in payrollMutationService.test.js; these tests prove the real payrollMutationService +
// payrollAuthorizationService are wired to real HTTP status codes and bodies, and that the strict
// schemas guard the door -- against fake repositories (no database).

const EMP_ACTIVE = randomUUID();
const EMP_OTHER = randomUUID();
const EMP_TERMINATED = randomUUID();

// pg returns numeric as a string, so the employee rows carry strings -- the fake does too.
const EMPLOYEES = [
  { id: EMP_ACTIVE, basic: "50000.00", allowances: "5000.00", employment_status: "active" },
  { id: EMP_OTHER, basic: "70000.00", allowances: "0.00", employment_status: "active" },
  { id: EMP_TERMINATED, basic: "40000.00", allowances: "2500.00", employment_status: "terminated" },
];

function principalFor(role, overrides = {}) {
  return { userId: randomUUID(), employeeId: randomUUID(), role, departmentId: randomUUID(), isTeamLead: role === "tl", ...overrides };
}

function payrollRecord(overrides = {}) {
  return {
    id: randomUUID(), employee_id: EMP_ACTIVE, period_year: 2026, period_month: 9,
    basic: 50000, allowances: 5000, bonus: 0, deductions: 0, gross: 55000, tax: 250, net: 54750,
    status: "draft", ...overrides,
  };
}

/**
 * Mirrors the real repository's contract: findById returns the record, create/updateById throw
 * the same 409 the unique index would (with the occupant's id), updateById enforces the same
 * draft-only guard the SQL does, and deleteById throws the same 404 for a record that is gone.
 */
function fakePayrollRepository(seed = [], { occupant = null } = {}) {
  const byId = new Map(seed.map((row) => [row.id, row]));
  const calls = { create: [], updateById: [], deleteById: [] };
  const duplicate = () => new HttpError(
    409, "payroll_already_recorded", "A payroll record already exists for this employee and period.",
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
      if (occupant && (Object.hasOwn(changes, "period_year") || Object.hasOwn(changes, "period_month"))) throw duplicate();
      const existing = byId.get(id);
      if (!existing) return null;
      if (existing.status === "processed") {
        throw new HttpError(409, "payroll_not_editable", "A processed payroll record cannot be changed.");
      }
      return { ...existing, ...changes };
    },
    async deleteById(id, deletedBy) {
      calls.deleteById.push({ id, deletedBy });
      if (!byId.has(id)) throw new HttpError(404, "not_found", "Payroll record not found.");
    },
  };
}

async function startApp(principal, repository) {
  const payrollMutationService = createPayrollMutationService({
    payrollRepository: repository,
    employeeRepository: { async findById(id) { return EMPLOYEES.find((row) => row.id === id) ?? null; } },
  });
  const app = createApp({
    verifyAccessToken: async () => principal,
    repositories: {},
    payrollMutationService,
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

const VALID_CREATE_BODY = Object.freeze({ employee_id: EMP_ACTIVE, period_year: 2026, period_month: 9 });

const WRITER_ROLES = new Set(["admin", "hr"]);

// ---------------------------------------------------------------------------
// Role matrices: every role against each of the three operations
// ---------------------------------------------------------------------------

test("POST /payroll: admin and hr create (201); manager, tl and employee are denied (403)", async () => {
  for (const role of USER_ROLES) {
    const repository = fakePayrollRepository();
    const app = await startApp(principalFor(role), repository);
    try {
      const response = await app.request("POST", "/api/v1/payroll", VALID_CREATE_BODY);
      if (WRITER_ROLES.has(role)) {
        assert.equal(response.status, 201, role);
        assert.equal(response.body.data.employee_id, EMP_ACTIVE, role);
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

test("PATCH /payroll/:id: admin and hr update a draft (200); manager, tl and employee are denied (403)", async () => {
  const target = payrollRecord();
  for (const role of USER_ROLES) {
    const repository = fakePayrollRepository([target]);
    const app = await startApp(principalFor(role), repository);
    try {
      const response = await app.request("PATCH", `/api/v1/payroll/${target.id}`, { bonus: 500 });
      if (WRITER_ROLES.has(role)) {
        assert.equal(response.status, 200, role);
        assert.equal(response.body.data.bonus, 500, role);
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

test("DELETE /payroll/:id: admin and hr delete (204); manager, tl and employee are denied (403)", async () => {
  const target = payrollRecord({ status: "processed" });
  for (const role of USER_ROLES) {
    const repository = fakePayrollRepository([target]);
    const app = await startApp(principalFor(role), repository);
    try {
      const response = await app.request("DELETE", `/api/v1/payroll/${target.id}`);
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

test("a manager is denied on every write even in the employee's own department -- payroll has no scope", async () => {
  const target = payrollRecord();
  const repository = fakePayrollRepository([target]);
  const app = await startApp(principalFor("manager"), repository);
  try {
    for (const response of [
      await app.request("POST", "/api/v1/payroll", VALID_CREATE_BODY),
      await app.request("PATCH", `/api/v1/payroll/${target.id}`, { bonus: 1 }),
      await app.request("DELETE", `/api/v1/payroll/${target.id}`),
    ]) {
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, "role_not_allowed");
    }
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D28: drafts reachable, processed immutable
// ---------------------------------------------------------------------------

test("POST: status defaults to processed, and draft is accepted", async () => {
  const repository = fakePayrollRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    const processedByDefault = await app.request("POST", "/api/v1/payroll", VALID_CREATE_BODY);
    assert.equal(processedByDefault.status, 201);
    assert.equal(repository.calls.create[0].status, "processed");

    const asDraft = await app.request("POST", "/api/v1/payroll", { ...VALID_CREATE_BODY, period_month: 10, status: "draft" });
    assert.equal(asDraft.status, 201);
    assert.equal(repository.calls.create[1].status, "draft");
  } finally {
    await app.close();
  }
});

test("PATCH: a draft's fields are editable and it can be promoted, alone or together", async () => {
  const target = payrollRecord();
  const repository = fakePayrollRepository([target]);
  const app = await startApp(principalFor("hr"), repository);
  try {
    const edited = await app.request("PATCH", `/api/v1/payroll/${target.id}`, { basic: 48000, bonus: 250, deductions: 10 });
    assert.equal(edited.status, 200);
    assert.deepEqual(repository.calls.updateById[0].changes, { basic: 48000, bonus: 250, deductions: 10 });

    const promoted = await app.request("PATCH", `/api/v1/payroll/${target.id}`, { status: "processed" });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.data.status, "processed");

    const editedAndPromoted = await app.request("PATCH", `/api/v1/payroll/${target.id}`, { bonus: 999, status: "processed" });
    assert.equal(editedAndPromoted.status, 200);
    assert.deepEqual(repository.calls.updateById[2].changes, { bonus: 999, status: "processed" });
  } finally {
    await app.close();
  }
});

test("PATCH: a processed record is refused with 409 payroll_not_editable -- fields, status, and putting it back to draft", async () => {
  const target = payrollRecord({ status: "processed" });
  for (const body of [{ bonus: 1 }, { basic: 1 }, { employee_id: EMP_OTHER }, { status: "draft" }, { status: "processed" }]) {
    const repository = fakePayrollRepository([target]);
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("PATCH", `/api/v1/payroll/${target.id}`, body);
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(response.body.error.code, "payroll_not_editable", JSON.stringify(body));
      assert.equal(repository.calls.updateById.length, 0, "refused before the write");
    } finally {
      await app.close();
    }
  }
});

test("PATCH: a record promoted between the read and the write is still refused -- the repository's guard surfaces as the same 409", async () => {
  // findById says draft, the write finds it processed: the SQL guard (here, the fake's mirror of
  // it) is what stops the edit, and the HTTP answer is identical.
  const target = payrollRecord({ status: "draft" });
  const repository = fakePayrollRepository([target]);
  const realFindById = repository.findById;
  repository.findById = async (id) => {
    const found = await realFindById(id);
    if (found) target.status = "processed"; // promoted by someone else right after the read
    return { ...found, status: "draft" };
  };
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("PATCH", `/api/v1/payroll/${target.id}`, { bonus: 5 });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "payroll_not_editable");
    assert.equal(repository.calls.updateById.length, 1, "the write was attempted and refused by the guard");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D28: duplicate period
// ---------------------------------------------------------------------------

test("POST: a duplicate employee/period is a 409 whose body carries the existing record's id", async () => {
  const occupant = randomUUID();
  const repository = fakePayrollRepository([], { occupant });
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("POST", "/api/v1/payroll", VALID_CREATE_BODY);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "payroll_already_recorded");
    assert.deepEqual(response.body.error.details, { existing_id: occupant });
    assert.ok(response.body.error.requestId, "the standard error envelope is intact");
  } finally {
    await app.close();
  }
});

test("PATCH: moving a draft onto an occupied period is the same 409 with the occupant's id", async () => {
  const occupant = randomUUID();
  const target = payrollRecord();
  const repository = fakePayrollRepository([target], { occupant });
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("PATCH", `/api/v1/payroll/${target.id}`, { period_month: 8 });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "payroll_already_recorded");
    assert.deepEqual(response.body.error.details, { existing_id: occupant });
  } finally {
    await app.close();
  }
});

test("errors without details keep their original shape -- no stray details key", async () => {
  const repository = fakePayrollRepository();
  const app = await startApp(principalFor("manager"), repository);
  try {
    const response = await app.request("POST", "/api/v1/payroll", VALID_CREATE_BODY);
    assert.equal(response.status, 403);
    assert.equal(Object.hasOwn(response.body.error, "details"), false);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D28: pay inputs and eligibility
// ---------------------------------------------------------------------------

test("POST: omitted basic and allowances default from the employee; bonus and deductions default to 0", async () => {
  const repository = fakePayrollRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("POST", "/api/v1/payroll", VALID_CREATE_BODY);
    assert.equal(response.status, 201);
    assert.deepEqual(repository.calls.create[0], {
      employee_id: EMP_ACTIVE, period_year: 2026, period_month: 9,
      basic: "50000.00", allowances: "5000.00", bonus: 0, deductions: 0, status: "processed",
    });
  } finally {
    await app.close();
  }
});

test("POST: explicit basic and allowances override the employee's, including an explicit 0", async () => {
  const repository = fakePayrollRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    const override = await app.request("POST", "/api/v1/payroll", { ...VALID_CREATE_BODY, basic: 42000, allowances: 1500 });
    assert.equal(override.status, 201);
    assert.equal(repository.calls.create[0].basic, 42000);
    assert.equal(repository.calls.create[0].allowances, 1500);

    const zero = await app.request("POST", "/api/v1/payroll", { ...VALID_CREATE_BODY, period_month: 10, basic: 30000, allowances: 0 });
    assert.equal(zero.status, 201);
    assert.equal(repository.calls.create[1].allowances, 0, "0 is an override, not 'omitted'");
  } finally {
    await app.close();
  }
});

test("POST: a terminated employee is accepted (final pay); an unknown employee is a 400", async () => {
  const repository = fakePayrollRepository();
  const app = await startApp(principalFor("hr"), repository);
  try {
    const terminated = await app.request("POST", "/api/v1/payroll", { ...VALID_CREATE_BODY, employee_id: EMP_TERMINATED });
    assert.equal(terminated.status, 201);
    assert.equal(repository.calls.create[0].basic, "40000.00");

    const unknown = await app.request("POST", "/api/v1/payroll", { ...VALID_CREATE_BODY, employee_id: randomUUID() });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, "invalid_employee");
  } finally {
    await app.close();
  }
});

test("POST: there is no temporal check -- a far-future period is accepted", async () => {
  const repository = fakePayrollRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("POST", "/api/v1/payroll", { ...VALID_CREATE_BODY, period_year: 2099, period_month: 12 });
    assert.equal(response.status, 201);
  } finally {
    await app.close();
  }
});

test("PATCH: re-pointing a draft at an unknown employee is a 400, at a terminated one is fine", async () => {
  const target = payrollRecord();
  const repository = fakePayrollRepository([target]);
  const app = await startApp(principalFor("admin"), repository);
  try {
    const unknown = await app.request("PATCH", `/api/v1/payroll/${target.id}`, { employee_id: randomUUID() });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, "invalid_employee");

    const terminated = await app.request("PATCH", `/api/v1/payroll/${target.id}`, { employee_id: EMP_TERMINATED });
    assert.equal(terminated.status, 200);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D28: soft delete records the deleter
// ---------------------------------------------------------------------------

test("DELETE: the repository receives the acting principal's employee id as the deleter, for a processed record too", async () => {
  const target = payrollRecord({ status: "processed" });
  const repository = fakePayrollRepository([target]);
  const principal = principalFor("hr");
  const app = await startApp(principal, repository);
  try {
    const response = await app.request("DELETE", `/api/v1/payroll/${target.id}`);
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
    assert.deepEqual(repository.calls.deleteById, [{ id: target.id, deletedBy: principal.employeeId }]);
  } finally {
    await app.close();
  }
});

test("DELETE: a record that vanishes between the read and the write is a 404, not a 500", async () => {
  const target = payrollRecord();
  const repository = fakePayrollRepository([target]);
  repository.deleteById = async () => { throw new HttpError(404, "not_found", "Payroll record not found."); };
  const app = await startApp(principalFor("admin"), repository);
  try {
    const response = await app.request("DELETE", `/api/v1/payroll/${target.id}`);
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Schema enforcement
// ---------------------------------------------------------------------------

test("POST: generated, server-owned and unknown fields are rejected outright, not silently ignored", async () => {
  const forbidden = {
    gross: 55000,
    tax: 250,
    net: 54750,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    deleted_at: null,
    deleted_by_employee_id: randomUUID(),
    id: randomUUID(),
    unexpected: true,
  };
  for (const [key, value] of Object.entries(forbidden)) {
    const repository = fakePayrollRepository();
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("POST", "/api/v1/payroll", { ...VALID_CREATE_BODY, [key]: value });
      assert.equal(response.status, 400, key);
      assert.equal(response.body.error.code, "invalid_request", key);
      assert.equal(repository.calls.create.length, 0, key);
    } finally {
      await app.close();
    }
  }
});

test("PATCH: generated, server-owned and unknown fields are rejected, and an empty body is rejected", async () => {
  const target = payrollRecord();
  const bodies = [
    { gross: 1 }, { tax: 1 }, { net: 1 },
    { updated_at: "2026-10-01T00:00:00Z" }, { created_at: "2026-10-01T00:00:00Z" },
    { deleted_at: null }, { deleted_by_employee_id: randomUUID() }, { id: randomUUID() },
    { unexpected: true }, {},
  ];
  for (const body of bodies) {
    const repository = fakePayrollRepository([target]);
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("PATCH", `/api/v1/payroll/${target.id}`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(repository.calls.updateById.length, 0, JSON.stringify(body));
    } finally {
      await app.close();
    }
  }
});

test("POST: employee_id, period_year and period_month are required", async () => {
  for (const missing of ["employee_id", "period_year", "period_month"]) {
    const body = { ...VALID_CREATE_BODY };
    delete body[missing];
    const repository = fakePayrollRepository();
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("POST", "/api/v1/payroll", body);
      assert.equal(response.status, 400, missing);
    } finally {
      await app.close();
    }
  }
});

test("POST: malformed periods, statuses and ids are rejected", async () => {
  const bad = [
    { period_month: 13 },
    { period_month: 0 },
    { period_month: 1.5 },
    { period_month: "September" },     // Firestore's English names are an ETL concern only
    { period_month: "9" },
    { period_year: 0 },
    { period_year: 10000 },
    { period_year: 2026.5 },
    { status: "paid" },
    { status: "Processed" },
    { employee_id: "not-a-uuid" },
  ];
  for (const override of bad) {
    const repository = fakePayrollRepository();
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("POST", "/api/v1/payroll", { ...VALID_CREATE_BODY, ...override });
      assert.equal(response.status, 400, JSON.stringify(override));
      assert.equal(repository.calls.create.length, 0, JSON.stringify(override));
    } finally {
      await app.close();
    }
  }
});

test("POST: malformed amounts are rejected -- negative, string, null, too many decimals, too large, exponent form", async () => {
  const bad = [
    { basic: -1 },
    { allowances: -0.01 },
    { bonus: -5 },
    { deductions: -5 },
    { basic: "50000" },                // amounts are JSON numbers
    { basic: null },                   // the columns are NOT NULL
    { bonus: null },
    { basic: 100.123 },                // a third decimal would be silently rounded by numeric(12,2)
    { bonus: 0.30000000000000004 },
    { deductions: 1e-7 },              // stringifies with an exponent
    { basic: 10000000000 },            // beyond numeric(12,2)
    { basic: 1e21 },
  ];
  for (const override of bad) {
    const repository = fakePayrollRepository();
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("POST", "/api/v1/payroll", { ...VALID_CREATE_BODY, ...override });
      assert.equal(response.status, 400, JSON.stringify(override));
      assert.equal(repository.calls.create.length, 0, JSON.stringify(override));
    } finally {
      await app.close();
    }
  }
});

test("POST: boundary amounts are accepted -- zero, one cent, two decimals, and the numeric(12,2) maximum", async () => {
  const good = [
    { basic: 0, allowances: 0 },
    { bonus: 0.01 },
    { basic: 1234.56 },
    { deductions: 99.9 },
    { basic: 9999999999.99 },
  ];
  for (const override of good) {
    const repository = fakePayrollRepository();
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("POST", "/api/v1/payroll", { ...VALID_CREATE_BODY, ...override });
      assert.equal(response.status, 201, JSON.stringify(override));
    } finally {
      await app.close();
    }
  }
});

test("PATCH: amount, period and status rules apply to a draft's payload too", async () => {
  const target = payrollRecord();
  const bad = [{ basic: -1 }, { basic: 1.234 }, { bonus: null }, { period_month: 13 }, { status: "paid" }, { basic: "5" }];
  for (const body of bad) {
    const repository = fakePayrollRepository([target]);
    const app = await startApp(principalFor("admin"), repository);
    try {
      const response = await app.request("PATCH", `/api/v1/payroll/${target.id}`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(repository.calls.updateById.length, 0, JSON.stringify(body));
    } finally {
      await app.close();
    }
  }
});

// ---------------------------------------------------------------------------
// id handling
// ---------------------------------------------------------------------------

test("PATCH and DELETE: a malformed id is a 404, matching the read path's convention", async () => {
  const repository = fakePayrollRepository();
  const app = await startApp(principalFor("admin"), repository);
  try {
    assert.equal((await app.request("PATCH", "/api/v1/payroll/not-a-uuid", { bonus: 1 })).status, 404);
    assert.equal((await app.request("DELETE", "/api/v1/payroll/not-a-uuid")).status, 404);
    assert.equal(repository.calls.updateById.length + repository.calls.deleteById.length, 0);
  } finally {
    await app.close();
  }
});

test("PATCH and DELETE: a well-formed but nonexistent id is a 404", async () => {
  const repository = fakePayrollRepository([]);
  const app = await startApp(principalFor("admin"), repository);
  try {
    assert.equal((await app.request("PATCH", `/api/v1/payroll/${randomUUID()}`, { bonus: 1 })).status, 404);
    assert.equal((await app.request("DELETE", `/api/v1/payroll/${randomUUID()}`)).status, 404);
  } finally {
    await app.close();
  }
});
