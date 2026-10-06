import assert from "node:assert/strict";
import test from "node:test";
import { createProjectMutationService } from "../src/services/projectMutationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Fake repository-interface level, mirroring payrollMutationService.test.js. The
// scope predicates themselves are covered in projectAuthorization.test.js; these tests prove the
// service applies them in the right order and to the right project -- the stored one, then the
// one it would become (D29) -- and owns who may be a lead or an assignee.

const D1 = "dept-1";
const D2 = "dept-2";
const TL_A = "tl-a";
const TL_B = "tl-b";

const employee = (id, role, departmentId, teamLeadId = null, status = "active") => ({
  id, role, department_id: departmentId, team_lead_id: teamLeadId, employment_status: status,
});

const EMPLOYEES = [
  employee(TL_A, "tl", D1),
  employee(TL_B, "tl", D1),
  employee("e1", "employee", D1, TL_A),
  employee("e2", "employee", D1, TL_B),
  employee("e3", "employee", D1, TL_A),
  employee("e-other", "employee", D2),
  employee("e-term", "employee", D1, TL_A, "terminated"),
  employee("e-mgr", "manager", D1),
  employee("tl-term", "tl", D1, null, "terminated"),
  employee("tl-other", "tl", D2),
];

function fakeEmployeeRepository() {
  const byId = new Map(EMPLOYEES.map((row) => [row.id, row]));
  const lookups = [];
  return { lookups, async findById(id) { lookups.push(id); return byId.get(id) ?? null; } };
}

function fakeProjectRepository(stored = []) {
  const byId = new Map(stored.map((row) => [row.id, row]));
  const calls = { create: [], updateById: [], deleteById: [] };
  return {
    calls,
    async findByIdForWrite(id) { return byId.get(id) ?? null; },
    async create(input) { calls.create.push(input); return { id: "new-id", ...input }; },
    async updateById(id, changes) {
      calls.updateById.push({ id, changes });
      return byId.has(id) ? { ...byId.get(id), ...changes } : null;
    },
    async deleteById(id, deletedBy) { calls.deleteById.push({ id, deletedBy }); },
  };
}

// Led by TL_A, one assignee on TL_A's team.
const ledByA = (overrides = {}) => ({
  id: "prj-a", department_id: D1, team_lead_id: TL_A, assignees: [{ id: "e1", team_lead_id: TL_A }], ...overrides,
});
// Led by TL_B, but with a member of TL_A's team on it too.
const ledByBWithAMember = () => ({
  id: "prj-b", department_id: D1, team_lead_id: TL_B,
  assignees: [{ id: "e1", team_lead_id: TL_A }, { id: "e2", team_lead_id: TL_B }],
});

function buildService(stored = [ledByA(), ledByBWithAMember()]) {
  const projectRepository = fakeProjectRepository(stored);
  const employeeRepository = fakeEmployeeRepository();
  const service = createProjectMutationService({ projectRepository, employeeRepository });
  return { service, projectRepository, employeeRepository };
}

const principalFor = (role, overrides = {}) => ({
  userId: `user-${role}`,
  employeeId: role === "tl" ? TL_A : `principal-${role}`,
  role,
  departmentId: D1,
  ...overrides,
});

const CREATE_INPUT = Object.freeze({
  department_id: D1, team_lead_id: TL_A, title: "Launch", description: "", start_date: "2026-01-01",
  due_date: "2026-02-01", status: "active", assigned_employee_ids: ["e1"],
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

test("createProject: admin, hr, manager and tl allowed; employee denied before any repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, projectRepository, employeeRepository } = buildService();
    // A tl may only create a project they lead, so the same input suits every role.
    const call = service.createProject(principalFor(role), CREATE_INPUT);

    if (role === "employee") {
      const error = await rejection(call);
      assert.equal(error.statusCode, 403, role);
      assert.equal(error.code, "role_not_allowed", role);
      assert.equal(projectRepository.calls.create.length, 0, role);
      assert.equal(employeeRepository.lookups.length, 0, "no employee lookup for a denied role");
    } else {
      await call;
      assert.equal(projectRepository.calls.create.length, 1, role);
    }
  }
});

test("updateProject: admin, hr, manager and tl allowed; employee denied before any repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, projectRepository } = buildService();
    const call = service.updateProject(principalFor(role), "prj-a", { title: "Renamed" });

    if (role === "employee") {
      assert.equal((await rejection(call)).code, "role_not_allowed", role);
      assert.equal(projectRepository.calls.updateById.length, 0, role);
    } else {
      await call;
      assert.equal(projectRepository.calls.updateById.length, 1, role);
    }
  }
});

test("deleteProject: admin, hr, manager and tl allowed; employee denied before any repository is called", async () => {
  for (const role of USER_ROLES) {
    const { service, projectRepository } = buildService();
    const call = service.deleteProject(principalFor(role), "prj-a");

    if (role === "employee") {
      assert.equal((await rejection(call)).code, "role_not_allowed", role);
      assert.equal(projectRepository.calls.deleteById.length, 0, role);
    } else {
      await call;
      assert.equal(projectRepository.calls.deleteById.length, 1, role);
    }
  }
});

test("an account with no employee record, or a manager/tl with no department, is denied on every operation", async () => {
  const { service, projectRepository } = buildService();
  for (const principal of [
    principalFor("admin", { employeeId: null }),
    principalFor("manager", { departmentId: null }),
    principalFor("tl", { departmentId: null }),
  ]) {
    assert.equal((await rejection(service.createProject(principal, CREATE_INPUT))).code, "role_not_allowed");
    assert.equal((await rejection(service.updateProject(principal, "prj-a", { title: "x" }))).code, "role_not_allowed");
    assert.equal((await rejection(service.deleteProject(principal, "prj-a"))).code, "role_not_allowed");
  }
  const { create, updateById, deleteById } = projectRepository.calls;
  assert.equal(create.length + updateById.length + deleteById.length, 0);
});

// ---------------------------------------------------------------------------
// createProject: defaults and eligibility
// ---------------------------------------------------------------------------

test("createProject: a tl's department and lead default to their own when absent", async () => {
  const { service, projectRepository } = buildService();

  await service.createProject(principalFor("tl"), {
    title: "Launch", description: "", start_date: "2026-01-01", due_date: "2026-02-01", status: "active",
    assigned_employee_ids: ["e1"],
  });

  const [created] = projectRepository.calls.create;
  assert.equal(created.department_id, D1);
  assert.equal(created.team_lead_id, TL_A);
});

test("createProject: a manager's department defaults to their own, and the lead defaults to none", async () => {
  const { service, projectRepository } = buildService();

  await service.createProject(principalFor("manager"), {
    title: "Launch", description: "", start_date: "2026-01-01", due_date: "2026-02-01", status: "active",
    assigned_employee_ids: ["e1"],
  });

  const [created] = projectRepository.calls.create;
  assert.equal(created.department_id, D1);
  assert.equal(created.team_lead_id, null);
});

test("createProject: admin and hr have no department to default to, so department_id is required of them", async () => {
  for (const role of ["admin", "hr"]) {
    const { service, projectRepository } = buildService();
    const { department_id: _omitted, ...withoutDepartment } = CREATE_INPUT;

    const error = await rejection(service.createProject(principalFor(role), withoutDepartment));

    assert.equal(error.statusCode, 400, role);
    assert.equal(error.code, "invalid_request", role);
    assert.equal(projectRepository.calls.create.length, 0, role);
  }
});

test("createProject: a tl who names ANOTHER lead is refused, not quietly rewritten to themselves", async () => {
  const { service, projectRepository } = buildService();

  const error = await rejection(service.createProject(principalFor("tl"), { ...CREATE_INPUT, team_lead_id: TL_B }));

  assert.equal(error.statusCode, 403);
  assert.equal(error.code, "project_scope_denied");
  assert.equal(projectRepository.calls.create.length, 0);
});

test("createProject: a tl who sends an explicit null lead is refused -- the default applies only when the field is absent", async () => {
  const { service, projectRepository } = buildService();

  const error = await rejection(service.createProject(principalFor("tl"), { ...CREATE_INPUT, team_lead_id: null }));

  assert.equal(error.code, "project_scope_denied");
  assert.equal(projectRepository.calls.create.length, 0);
});

test("createProject: an explicit department is checked, not overridden -- a manager naming another department is refused", async () => {
  const { service, projectRepository } = buildService();

  const error = await rejection(service.createProject(principalFor("manager"), {
    ...CREATE_INPUT, department_id: D2, team_lead_id: null, assigned_employee_ids: ["e-other"],
  }));

  assert.equal(error.code, "project_scope_denied");
  assert.equal(projectRepository.calls.create.length, 0);
});

test("createProject: every assignee must be an active employee-role person in the project's department", async () => {
  for (const assignee of ["missing", "e-term", "e-mgr", TL_A, "e-other"]) {
    const { service, projectRepository } = buildService();

    const error = await rejection(service.createProject(principalFor("admin"), {
      ...CREATE_INPUT, assigned_employee_ids: ["e1", assignee],
    }));

    assert.equal(error.statusCode, 400, assignee);
    assert.equal(error.code, "invalid_assignee", assignee);
    assert.equal(projectRepository.calls.create.length, 0, assignee);
  }
});

test("createProject: a lead must be an active tl in the project's department", async () => {
  for (const lead of ["missing", "tl-term", "e1", "tl-other"]) {
    const { service, projectRepository } = buildService();

    const error = await rejection(service.createProject(principalFor("admin"), { ...CREATE_INPUT, team_lead_id: lead }));

    assert.equal(error.statusCode, 400, lead);
    assert.equal(error.code, "invalid_team_lead", lead);
    assert.equal(projectRepository.calls.create.length, 0, lead);
  }
});

test("createProject: a project may have no lead at all", async () => {
  const { service, projectRepository } = buildService();

  await service.createProject(principalFor("admin"), { ...CREATE_INPUT, team_lead_id: null });

  assert.equal(projectRepository.calls.create[0].team_lead_id, null);
});

test("createProject: the repository receives the status as given -- the schema, not the service, defaults it", async () => {
  const { service, projectRepository } = buildService();

  await service.createProject(principalFor("admin"), { ...CREATE_INPUT, status: "draft" });

  assert.equal(projectRepository.calls.create[0].status, "draft");
});

// ---------------------------------------------------------------------------
// D29: the two-sided scope, in both directions
// ---------------------------------------------------------------------------

test("a tl who leads a project, with only their own team on it, may create and edit it", async () => {
  const { service, projectRepository } = buildService();

  await service.createProject(principalFor("tl"), { ...CREATE_INPUT, assigned_employee_ids: ["e1", "e3"] });
  await service.updateProject(principalFor("tl"), "prj-a", { title: "Renamed" });

  assert.equal(projectRepository.calls.create.length, 1);
  assert.equal(projectRepository.calls.updateById.length, 1);
});

test("TL, existing side: a tl who is neither lead nor has a member on the project cannot touch it at all", async () => {
  const { service, projectRepository } = buildService([ledByA()]);
  const outsider = principalFor("tl", { employeeId: TL_B });

  assert.equal((await rejection(service.updateProject(outsider, "prj-a", { title: "x" }))).code, "project_scope_denied");
  assert.equal((await rejection(service.deleteProject(outsider, "prj-a"))).code, "project_scope_denied");
  assert.equal(projectRepository.calls.updateById.length + projectRepository.calls.deleteById.length, 0);
});

test("TL, resulting side: a tl who leads a project cannot add an assignee from another team", async () => {
  const { service, projectRepository } = buildService([ledByA()]);

  // e2 reports to TL_B, so the project would no longer be wholly TL_A's.
  const error = await rejection(service.updateProject(principalFor("tl"), "prj-a", { assigned_employee_ids: ["e1", "e2"] }));

  assert.equal(error.statusCode, 403);
  assert.equal(error.code, "project_scope_denied");
  assert.equal(projectRepository.calls.updateById.length, 0);
});

test("TL, resulting side: a tl cannot hand their project to another lead, or clear the lead", async () => {
  for (const lead of [TL_B, null]) {
    const { service, projectRepository } = buildService([ledByA()]);

    const error = await rejection(service.updateProject(principalFor("tl"), "prj-a", { team_lead_id: lead }));

    assert.equal(error.code, "project_scope_denied", String(lead));
    assert.equal(projectRepository.calls.updateById.length, 0, String(lead));
  }
});

test("TL: a tl who is NOT the lead but has a member on the project can delete it yet never edit it", async () => {
  // Manageable as it stands (a member of theirs is assigned) but not a state they could hold, so
  // the resulting-project check always refuses an edit -- exactly as the callable behaved.
  const { service, projectRepository } = buildService([ledByBWithAMember()]);
  const tl = principalFor("tl"); // TL_A: not the lead of prj-b, but e1 reports to them

  assert.equal((await rejection(service.updateProject(tl, "prj-b", { title: "x" }))).code, "project_scope_denied");
  assert.equal(projectRepository.calls.updateById.length, 0);

  await service.deleteProject(tl, "prj-b");
  assert.deepEqual(projectRepository.calls.deleteById, [{ id: "prj-b", deletedBy: TL_A }]);
});

test("manager, existing side: a manager cannot touch another department's project", async () => {
  const { service, projectRepository } = buildService([ledByA({ department_id: D2 })]);

  assert.equal((await rejection(service.updateProject(principalFor("manager"), "prj-a", { title: "x" }))).code, "project_scope_denied");
  assert.equal((await rejection(service.deleteProject(principalFor("manager"), "prj-a"))).code, "project_scope_denied");
  assert.equal(projectRepository.calls.updateById.length + projectRepository.calls.deleteById.length, 0);
});

test("manager, resulting side: a manager cannot move their project into another department", async () => {
  const { service, projectRepository } = buildService([ledByA()]);

  const error = await rejection(service.updateProject(principalFor("manager"), "prj-a", {
    department_id: D2, team_lead_id: null, assigned_employee_ids: ["e-other"],
  }));

  assert.equal(error.code, "project_scope_denied");
  assert.equal(projectRepository.calls.updateById.length, 0);
});

test("admin and hr may move a project across departments", async () => {
  for (const role of ["admin", "hr"]) {
    const { service, projectRepository } = buildService([ledByA()]);

    await service.updateProject(principalFor(role), "prj-a", {
      department_id: D2, team_lead_id: "tl-other", assigned_employee_ids: ["e-other"],
    });

    assert.equal(projectRepository.calls.updateById.length, 1, role);
  }
});

// ---------------------------------------------------------------------------
// updateProject: what is validated and what is not
// ---------------------------------------------------------------------------

test("updateProject: the patch reaches the repository exactly as validated -- assignees as a replace-set", async () => {
  const { service, projectRepository } = buildService([ledByA()]);

  await service.updateProject(principalFor("admin"), "prj-a", { title: "Renamed", assigned_employee_ids: ["e1", "e3"] });

  assert.deepEqual(projectRepository.calls.updateById, [{
    id: "prj-a", changes: { title: "Renamed", assigned_employee_ids: ["e1", "e3"] },
  }]);
});

test("updateProject: newly supplied assignees are validated like create's", async () => {
  for (const assignee of ["missing", "e-term", "e-mgr", TL_A, "e-other"]) {
    const { service, projectRepository } = buildService([ledByA()]);

    const error = await rejection(service.updateProject(principalFor("admin"), "prj-a", { assigned_employee_ids: ["e1", assignee] }));

    assert.equal(error.code, "invalid_assignee", assignee);
    assert.equal(projectRepository.calls.updateById.length, 0, assignee);
  }
});

test("updateProject: a newly supplied lead is validated, and null is allowed", async () => {
  const { service, projectRepository } = buildService([ledByA()]);

  assert.equal((await rejection(service.updateProject(principalFor("admin"), "prj-a", { team_lead_id: "e1" }))).code, "invalid_team_lead");
  assert.equal((await rejection(service.updateProject(principalFor("admin"), "prj-a", { team_lead_id: "tl-term" }))).code, "invalid_team_lead");

  await service.updateProject(principalFor("admin"), "prj-a", { team_lead_id: null });
  assert.equal(projectRepository.calls.updateById.length, 1);
});

test("updateProject: unchanged references are NOT re-validated -- re-validating stored ones is what stranded Firestore records", async () => {
  // The stored assignee has since been terminated. An edit that does not touch assignees must still work.
  const stored = ledByA({ assignees: [{ id: "e-term", team_lead_id: TL_A }] });
  const { service, projectRepository, employeeRepository } = buildService([stored]);

  await service.updateProject(principalFor("admin"), "prj-a", { title: "Still editable" });

  assert.equal(projectRepository.calls.updateById.length, 1);
  assert.deepEqual(employeeRepository.lookups, [], "no employee was loaded for an edit that names none");
});

test("updateProject: a missing project is a 404, and a repository null (deleted between read and write) is too", async () => {
  const { service, projectRepository } = buildService([ledByA()]);

  const missing = await rejection(service.updateProject(principalFor("admin"), "nope", { title: "x" }));
  assert.equal(missing.statusCode, 404);
  assert.equal(projectRepository.calls.updateById.length, 0);

  projectRepository.updateById = async () => null;
  assert.equal((await rejection(service.updateProject(principalFor("admin"), "prj-a", { title: "x" }))).statusCode, 404);
});

// ---------------------------------------------------------------------------
// deleteProject
// ---------------------------------------------------------------------------

test("deleteProject: the principal's employee id is passed as the deleter", async () => {
  const { service, projectRepository } = buildService([ledByA()]);

  await service.deleteProject(principalFor("hr", { employeeId: "the-deleter" }), "prj-a");

  assert.deepEqual(projectRepository.calls.deleteById, [{ id: "prj-a", deletedBy: "the-deleter" }]);
});

test("deleteProject: a missing project is a 404; the live-KPI refusal is the repository's, so its 409 propagates unchanged", async () => {
  const { service, projectRepository } = buildService([ledByA()]);

  assert.equal((await rejection(service.deleteProject(principalFor("admin"), "nope"))).statusCode, 404);

  const refusal = Object.assign(new Error("has kpis"), { statusCode: 409, code: "project_has_kpis" });
  projectRepository.deleteById = async () => { throw refusal; };
  assert.equal(await rejection(service.deleteProject(principalFor("admin"), "prj-a")), refusal);
});
