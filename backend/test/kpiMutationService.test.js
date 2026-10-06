import assert from "node:assert/strict";
import test from "node:test";
import { createKpiMutationService } from "../src/services/kpiMutationService.js";
import { HttpError } from "../src/utils/httpError.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Fake repository-interface level, mirroring payrollMutationService.test.js. The scope
// matrix itself is kpiAuthorization.test.js; these tests prove the service applies it in the right
// order, owns create-time eligibility, keeps employee_id and project_id frozen, and -- crucially --
// does NOT pre-empt the database's rating bans (D29): a legacy KPI and a would-be self-rating both
// reach the repository, and only the constraints refuse them.

const D1 = "dept-1";
const D2 = "dept-2";
const TL_A = "tl-a";
const TL_B = "tl-b";
const KPI = "kpi-1";
const PROJECT = "prj-1";

const employee = (id, role, departmentId, teamLeadId = null, status = "active") => ({
  id, role, department_id: departmentId, team_lead_id: teamLeadId, employment_status: status,
});
const EMPLOYEES = [
  employee("e1", "employee", D1, TL_A),
  employee("e2", "employee", D1, TL_B),
  employee("e-other", "employee", D2),
  employee("e-term", "employee", D1, TL_A, "terminated"),
  employee("e-mgr", "manager", D1),
  employee(TL_A, "tl", D1),
];

function fakeEmployeeRepository() {
  const byId = new Map(EMPLOYEES.map((row) => [row.id, row]));
  const lookups = [];
  return { lookups, async findById(id) { lookups.push(id); return byId.get(id) ?? null; } };
}

// A project led by TL_A with one member of TL_A's team on it.
const projectLedByA = (overrides = {}) => ({
  id: PROJECT, department_id: D1, team_lead_id: TL_A, assignees: [{ id: "e1", team_lead_id: TL_A }], ...overrides,
});

function fakeProjectRepository(projects = [projectLedByA()]) {
  const byId = new Map(projects.map((row) => [row.id, row]));
  const lookups = [];
  return { lookups, async findByIdForWrite(id) { lookups.push(id); return byId.get(id) ?? null; } };
}

/** An existing KPI as kpiRepository.findByIdForWrite returns it, with project and employee context. */
const kpiRow = (overrides = {}) => ({
  id: KPI, project_id: PROJECT, employee_id: "e1",
  employee_department_id: D1, employee_team_lead_id: TL_A,
  project_department_id: D1, project_team_lead_id: TL_A, project_assignee_team_lead_ids: [TL_A],
  ...overrides,
});
const legacyKpiRow = (overrides = {}) => kpiRow({
  project_id: null, project_department_id: null, project_team_lead_id: null, project_assignee_team_lead_ids: [], ...overrides,
});

function fakeKpiRepository(row = kpiRow()) {
  const calls = { create: [], updateById: [], rate: [], deleteById: [] };
  return {
    calls,
    async findByIdForWrite(id) { return id === KPI && row ? row : null; },
    async create(input) { calls.create.push(input); return { id: "new-kpi", ...input }; },
    async updateById(id, changes) { calls.updateById.push({ id, changes }); return { id, ...changes }; },
    async rate(id, input) { calls.rate.push({ id, ...input }); return { id, rating: input.rating }; },
    async deleteById(id, deletedBy) { calls.deleteById.push({ id, deletedBy }); },
  };
}

function buildService({ row = kpiRow(), projects } = {}) {
  const kpiRepository = fakeKpiRepository(row);
  const projectRepository = fakeProjectRepository(projects);
  const employeeRepository = fakeEmployeeRepository();
  const service = createKpiMutationService({ kpiRepository, projectRepository, employeeRepository });
  return { service, kpiRepository, projectRepository, employeeRepository };
}

const principalFor = (role, overrides = {}) => ({
  userId: `user-${role}`,
  employeeId: role === "tl" ? TL_A : `principal-${role}`,
  role,
  departmentId: D1,
  ...overrides,
});

const CREATE_INPUT = Object.freeze({
  project_id: PROJECT, employee_id: "e1", title: "Ship it", target: 100, current_value: 0, weight: 50,
  period: "Q1", status: "active",
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

test("createKpi: admin, hr, manager and tl allowed; employee denied before any lookup", async () => {
  for (const role of USER_ROLES) {
    const { service, kpiRepository, projectRepository, employeeRepository } = buildService();
    const call = service.createKpi(principalFor(role), CREATE_INPUT);

    if (role === "employee") {
      const error = await rejection(call);
      assert.equal(error.statusCode, 403, role);
      assert.equal(error.code, "role_not_allowed", role);
      assert.equal(kpiRepository.calls.create.length, 0, role);
      assert.deepEqual([projectRepository.lookups, employeeRepository.lookups], [[], []], "no lookups for a denied role");
    } else {
      await call;
      assert.equal(kpiRepository.calls.create.length, 1, role);
    }
  }
});

test("updateKpi: admin, hr, manager and tl allowed; employee denied before the repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, kpiRepository } = buildService();
    const call = service.updateKpi(principalFor(role), KPI, { current_value: 5 });

    if (role === "employee") {
      assert.equal((await rejection(call)).code, "role_not_allowed", role);
      assert.equal(kpiRepository.calls.updateById.length, 0, role);
    } else {
      await call;
      assert.equal(kpiRepository.calls.updateById.length, 1, role);
    }
  }
});

test("rateKpi: admin, hr, manager and tl allowed; employee denied before the repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, kpiRepository } = buildService();
    const call = service.rateKpi(principalFor(role), KPI, { rating: 8 });

    if (role === "employee") {
      assert.equal((await rejection(call)).code, "role_not_allowed", role);
      assert.equal(kpiRepository.calls.rate.length, 0, role);
    } else {
      await call;
      assert.equal(kpiRepository.calls.rate.length, 1, role);
    }
  }
});

test("deleteKpi: admin, hr, manager and tl allowed; employee denied before the repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, kpiRepository } = buildService();
    const call = service.deleteKpi(principalFor(role), KPI);

    if (role === "employee") {
      assert.equal((await rejection(call)).code, "role_not_allowed", role);
      assert.equal(kpiRepository.calls.deleteById.length, 0, role);
    } else {
      await call;
      assert.equal(kpiRepository.calls.deleteById.length, 1, role);
    }
  }
});

test("an account with no employee record, or a manager/tl with no department, is denied on every operation", async () => {
  const { service, kpiRepository } = buildService();
  for (const principal of [
    principalFor("admin", { employeeId: null }),
    principalFor("manager", { departmentId: null }),
    principalFor("tl", { departmentId: null }),
  ]) {
    assert.equal((await rejection(service.createKpi(principal, CREATE_INPUT))).code, "role_not_allowed");
    assert.equal((await rejection(service.updateKpi(principal, KPI, { title: "x" }))).code, "role_not_allowed");
    assert.equal((await rejection(service.rateKpi(principal, KPI, { rating: 5 }))).code, "role_not_allowed");
    assert.equal((await rejection(service.deleteKpi(principal, KPI))).code, "role_not_allowed");
  }
  const { create, updateById, rate, deleteById } = kpiRepository.calls;
  assert.equal(create.length + updateById.length + rate.length + deleteById.length, 0);
});

// ---------------------------------------------------------------------------
// createKpi: order of checks, scope, and create-time eligibility
// ---------------------------------------------------------------------------

test("createKpi: passes the validated input to the repository untouched", async () => {
  const { service, kpiRepository } = buildService();

  await service.createKpi(principalFor("admin"), CREATE_INPUT);

  assert.deepEqual(kpiRepository.calls.create[0], CREATE_INPUT);
  for (const key of ["rating", "rated_by_employee_id", "rated_at", "created_at", "updated_at", "deleted_at"]) {
    assert.equal(Object.hasOwn(kpiRepository.calls.create[0], key), false, key);
  }
});

test("createKpi: an unknown project is a 400 invalid_project, before the employee is even loaded", async () => {
  const { service, kpiRepository, employeeRepository } = buildService();

  const error = await rejection(service.createKpi(principalFor("admin"), { ...CREATE_INPUT, project_id: "missing" }));

  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "invalid_project");
  assert.deepEqual(employeeRepository.lookups, []);
  assert.equal(kpiRepository.calls.create.length, 0);
});

test("createKpi: an unknown employee is a 400 invalid_employee", async () => {
  const { service, kpiRepository } = buildService();

  const error = await rejection(service.createKpi(principalFor("admin"), { ...CREATE_INPUT, employee_id: "missing" }));

  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "invalid_employee");
  assert.equal(kpiRepository.calls.create.length, 0);
});

test("createKpi: D29 -- the employee must be an active employee-role person in the project's department", async () => {
  for (const employeeId of ["e-term", "e-mgr", TL_A, "e-other"]) {
    const { service, kpiRepository } = buildService();

    const error = await rejection(service.createKpi(principalFor("admin"), { ...CREATE_INPUT, employee_id: employeeId }));

    assert.equal(error.statusCode, 400, employeeId);
    assert.equal(error.code, "employee_not_eligible", employeeId);
    assert.equal(kpiRepository.calls.create.length, 0, employeeId);
  }
});

test("createKpi: scope is checked BEFORE eligibility, so a caller out of scope learns nothing about an employee's status", async () => {
  // e-other is in another department AND would be ineligible; a manager of D1 must get the scope
  // answer, not an eligibility one that reveals anything.
  const { service } = buildService();

  const error = await rejection(service.createKpi(principalFor("manager"), { ...CREATE_INPUT, employee_id: "e-other" }));

  assert.equal(error.statusCode, 403);
  assert.equal(error.code, "kpi_scope_denied");
});

test("createKpi: a manager is denied when the project is in another department", async () => {
  const { service, kpiRepository } = buildService({ projects: [projectLedByA({ department_id: D2 })] });

  const error = await rejection(service.createKpi(principalFor("manager"), CREATE_INPUT));

  assert.equal(error.code, "kpi_scope_denied");
  assert.equal(kpiRepository.calls.create.length, 0);
});

test("createKpi: a tl is denied for an employee on another team, and for a project that is not theirs", async () => {
  const { service, kpiRepository } = buildService({
    projects: [projectLedByA(), projectLedByA({ id: "prj-b", team_lead_id: TL_B, assignees: [{ id: "e2", team_lead_id: TL_B }] })],
  });

  const wrongTeam = await rejection(service.createKpi(principalFor("tl"), { ...CREATE_INPUT, employee_id: "e2" }));
  assert.equal(wrongTeam.code, "kpi_scope_denied");

  const wrongProject = await rejection(service.createKpi(principalFor("tl"), { ...CREATE_INPUT, project_id: "prj-b", employee_id: "e2" }));
  assert.equal(wrongProject.code, "kpi_scope_denied");
  assert.equal(kpiRepository.calls.create.length, 0);
});

test("createKpi: the assignment itself is NOT checked here -- the repository confirms it under a lock", async () => {
  // e1 is eligible and in scope; whether they are an assignee is the repository's atomic check, so
  // an employee absent from the project's loaded assignees still reaches it.
  const { service, kpiRepository } = buildService({ projects: [projectLedByA({ assignees: [] })] });

  await service.createKpi(principalFor("admin"), CREATE_INPUT);

  assert.equal(kpiRepository.calls.create.length, 1);
});

test("createKpi: a repository refusal (unassigned employee, missing project) propagates unchanged", async () => {
  const { service, kpiRepository } = buildService();
  const refusal = new HttpError(400, "employee_not_assigned", "The employee is not assigned to this project.");
  kpiRepository.create = async () => { throw refusal; };

  assert.equal(await rejection(service.createKpi(principalFor("admin"), CREATE_INPUT)), refusal);
});

// ---------------------------------------------------------------------------
// updateKpi: frozen employee_id and project_id, no re-check of eligibility
// ---------------------------------------------------------------------------

test("updateKpi: only the progress fields it was given reach the repository -- employee_id and project_id are never added", async () => {
  const { service, kpiRepository } = buildService();

  await service.updateKpi(principalFor("admin"), KPI, { title: "Renamed", current_value: 7.5 });

  assert.deepEqual(kpiRepository.calls.updateById, [{ id: KPI, changes: { title: "Renamed", current_value: 7.5 } }]);
  const { changes } = kpiRepository.calls.updateById[0];
  for (const key of ["employee_id", "project_id", "rating", "rated_by_employee_id", "rated_at"]) {
    assert.equal(Object.hasOwn(changes, key), false, key);
  }
});

test("updateKpi: D29 -- eligibility is checked at create only, so no employee is looked up on an edit", async () => {
  // A KPI whose employee has since been terminated or re-roled stays editable; the legacy callable
  // re-verified on every write and stranded such KPIs.
  const { service, kpiRepository, employeeRepository, projectRepository } = buildService();

  await service.updateKpi(principalFor("admin"), KPI, { current_value: 1 });
  await service.rateKpi(principalFor("admin"), KPI, { rating: 5 });
  await service.deleteKpi(principalFor("admin"), KPI);

  assert.deepEqual(employeeRepository.lookups, []);
  assert.deepEqual(projectRepository.lookups, []);
  assert.equal(kpiRepository.calls.updateById.length + kpiRepository.calls.rate.length + kpiRepository.calls.deleteById.length, 3);
});

test("updateKpi: a manager is denied for a KPI whose project is in another department", async () => {
  const { service, kpiRepository } = buildService({ row: kpiRow({ project_department_id: D2 }) });

  assert.equal((await rejection(service.updateKpi(principalFor("manager"), KPI, { title: "x" }))).code, "kpi_scope_denied");
  assert.equal(kpiRepository.calls.updateById.length, 0);
});

test("updateKpi: a tl is denied when the KPI's employee is on another team", async () => {
  const { service, kpiRepository } = buildService({ row: kpiRow({ employee_id: "e2", employee_team_lead_id: TL_B }) });

  assert.equal((await rejection(service.updateKpi(principalFor("tl"), KPI, { title: "x" }))).code, "kpi_scope_denied");
  assert.equal(kpiRepository.calls.updateById.length, 0);
});

test("updateKpi: a missing KPI is a 404, and a repository null (deleted between read and write) is too", async () => {
  const { service, kpiRepository } = buildService();

  const missing = await rejection(service.updateKpi(principalFor("admin"), "nope", { title: "x" }));
  assert.equal(missing.statusCode, 404);
  assert.equal(kpiRepository.calls.updateById.length, 0);

  kpiRepository.updateById = async () => null;
  assert.equal((await rejection(service.updateKpi(principalFor("admin"), KPI, { title: "x" }))).statusCode, 404);
});

// ---------------------------------------------------------------------------
// rateKpi: server-set rater, and no pre-emption of the database bans
// ---------------------------------------------------------------------------

test("rateKpi: the rater is the acting principal's employee id, and no time is passed -- both are the server's", async () => {
  const { service, kpiRepository } = buildService();

  await service.rateKpi(principalFor("manager", { employeeId: "the-rater" }), KPI, { rating: 8 });

  assert.deepEqual(kpiRepository.calls.rate, [{ id: KPI, rating: 8, ratedByEmployeeId: "the-rater" }]);
  assert.equal(Object.hasOwn(kpiRepository.calls.rate[0], "rated_at"), false);
});

test("rateKpi: D29 -- a legacy KPI is NOT refused here; it reaches the repository so the database can refuse it", async () => {
  const { service, kpiRepository } = buildService({ row: legacyKpiRow() });

  await service.rateKpi(principalFor("admin"), KPI, { rating: 8 });

  assert.equal(kpiRepository.calls.rate.length, 1, "kpis_legacy_not_rateable, not this layer, is what says no");
});

test("rateKpi: D29 -- a would-be self-rating is NOT refused here; it reaches the repository so the database can refuse it", async () => {
  // The KPI's employee has since become a manager in the same department (eligibility is checked at
  // create only) and now rates their own KPI: in scope, so authorized -- kpis_no_self_rating decides.
  const { service, kpiRepository } = buildService({ row: kpiRow({ employee_id: "e-mgr" }) });
  const self = principalFor("manager", { employeeId: "e-mgr" });

  await service.rateKpi(self, KPI, { rating: 9 });

  assert.deepEqual(kpiRepository.calls.rate, [{ id: KPI, rating: 9, ratedByEmployeeId: "e-mgr" }]);
});

test("rateKpi: the database's refusals propagate unchanged -- 403 self_rating_denied and 409 legacy_kpi_not_rateable", async () => {
  for (const refusal of [
    new HttpError(403, "self_rating_denied", "You cannot rate your own KPI."),
    new HttpError(409, "legacy_kpi_not_rateable", "A KPI with no project cannot be rated."),
  ]) {
    const { service, kpiRepository } = buildService();
    kpiRepository.rate = async () => { throw refusal; };

    assert.equal(await rejection(service.rateKpi(principalFor("admin"), KPI, { rating: 8 })), refusal, refusal.code);
  }
});

test("rateKpi: the rater's scope is the KPI write scope -- a tl may rate only an employee on their team", async () => {
  const onTeam = buildService({ row: kpiRow() });
  await onTeam.service.rateKpi(principalFor("tl"), KPI, { rating: 7 });
  assert.equal(onTeam.kpiRepository.calls.rate.length, 1);

  const offTeam = buildService({ row: kpiRow({ employee_id: "e2", employee_team_lead_id: TL_B }) });
  assert.equal((await rejection(offTeam.service.rateKpi(principalFor("tl"), KPI, { rating: 7 }))).code, "kpi_scope_denied");
  assert.equal(offTeam.kpiRepository.calls.rate.length, 0);
});

test("rateKpi: a missing KPI is a 404, and a repository null is too", async () => {
  const { service, kpiRepository } = buildService();

  assert.equal((await rejection(service.rateKpi(principalFor("admin"), "nope", { rating: 5 }))).statusCode, 404);

  kpiRepository.rate = async () => null;
  assert.equal((await rejection(service.rateKpi(principalFor("admin"), KPI, { rating: 5 }))).statusCode, 404);
});

// ---------------------------------------------------------------------------
// Legacy KPIs: scope, edit and delete (but never a service-level rating check)
// ---------------------------------------------------------------------------

test("a legacy KPI is editable and deletable within the callable's legacy scope", async () => {
  const { service, kpiRepository } = buildService({ row: legacyKpiRow() });

  await service.updateKpi(principalFor("manager"), KPI, { title: "x" });
  await service.deleteKpi(principalFor("tl"), KPI);

  assert.equal(kpiRepository.calls.updateById.length, 1);
  assert.equal(kpiRepository.calls.deleteById.length, 1);
});

test("a legacy KPI is out of scope for a manager of another department", async () => {
  const { service, kpiRepository } = buildService({ row: legacyKpiRow({ employee_department_id: D2 }) });

  assert.equal((await rejection(service.updateKpi(principalFor("manager"), KPI, { title: "x" }))).code, "kpi_scope_denied");
  assert.equal(kpiRepository.calls.updateById.length, 0);
});

// ---------------------------------------------------------------------------
// deleteKpi
// ---------------------------------------------------------------------------

test("deleteKpi: the principal's employee id is passed as the deleter", async () => {
  const { service, kpiRepository } = buildService();

  await service.deleteKpi(principalFor("hr", { employeeId: "the-deleter" }), KPI);

  assert.deepEqual(kpiRepository.calls.deleteById, [{ id: KPI, deletedBy: "the-deleter" }]);
});

test("deleteKpi: a missing KPI is a 404 and a manager out of scope is a 403, neither reaching the repository", async () => {
  const missing = buildService();
  assert.equal((await rejection(missing.service.deleteKpi(principalFor("admin"), "nope"))).statusCode, 404);

  const foreign = buildService({ row: kpiRow({ project_department_id: D2 }) });
  assert.equal((await rejection(foreign.service.deleteKpi(principalFor("manager"), KPI))).code, "kpi_scope_denied");

  assert.equal(missing.kpiRepository.calls.deleteById.length + foreign.kpiRepository.calls.deleteById.length, 0);
});
