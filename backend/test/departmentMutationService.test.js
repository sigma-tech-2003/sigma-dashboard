import assert from "node:assert/strict";
import test from "node:test";
import { createDepartmentMutationService } from "../src/services/departmentMutationService.js";
import { USER_ROLES } from "../src/utils/roles.js";

// No database. Fake repository-interface level, mirroring employeeMutationService.test.js's
// style. The authorization MATRIX itself is covered in departmentAuthorization.test.js;
// these tests only need enough of it to prove the service calls it correctly.

const principalFor = (role) => ({ userId: "principal-id", employeeId: "principal-emp", role });

function fakeDepartmentRepository(seedDepartments = []) {
  const byId = new Map(seedDepartments.map((row) => [row.id, row]));
  const calls = { create: [], updateById: [], deleteById: [] };
  return {
    calls,
    async create(input) {
      calls.create.push(input);
      return { id: "new-id", manager_employee_id: null, ...input };
    },
    async updateById(id, changes) {
      calls.updateById.push({ id, changes });
      if (!byId.has(id)) return null;
      return { ...byId.get(id), ...changes };
    },
    async deleteById(id) {
      calls.deleteById.push(id);
    },
  };
}

const CREATE_INPUT = Object.freeze({ name: "Engineering", description: null, status: "active" });

// ---------------------------------------------------------------------------
// createDepartment
// ---------------------------------------------------------------------------

test("createDepartment: admin only -- every other role is denied before the repository is ever called", async () => {
  for (const role of USER_ROLES) {
    const repository = fakeDepartmentRepository();
    const service = createDepartmentMutationService({ departmentRepository: repository });

    if (role === "admin") {
      await service.createDepartment(principalFor(role), CREATE_INPUT);
      assert.equal(repository.calls.create.length, 1, role);
    } else {
      await assert.rejects(
        service.createDepartment(principalFor(role), CREATE_INPUT),
        (error) => { assert.equal(error.statusCode, 403); assert.equal(error.code, "role_not_allowed"); return true; },
        role,
      );
      assert.equal(repository.calls.create.length, 0, role);
    }
  }
});

// ---------------------------------------------------------------------------
// updateDepartment
// ---------------------------------------------------------------------------

test("updateDepartment: admin only -- every other role is denied before the repository is ever called", async () => {
  for (const role of USER_ROLES) {
    const repository = fakeDepartmentRepository([{ id: "dept-1", name: "Engineering" }]);
    const service = createDepartmentMutationService({ departmentRepository: repository });

    if (role === "admin") {
      await service.updateDepartment(principalFor(role), "dept-1", { name: "Platform" });
      assert.equal(repository.calls.updateById.length, 1, role);
    } else {
      await assert.rejects(
        service.updateDepartment(principalFor(role), "dept-1", { name: "Platform" }),
        (error) => { assert.equal(error.code, "role_not_allowed"); return true; },
        role,
      );
      assert.equal(repository.calls.updateById.length, 0, role);
    }
  }
});

test("updateDepartment: a nonexistent department is a clean 404", async () => {
  const repository = fakeDepartmentRepository([]);
  const service = createDepartmentMutationService({ departmentRepository: repository });

  await assert.rejects(
    service.updateDepartment(principalFor("admin"), "missing-id", { name: "Platform" }),
    (error) => { assert.equal(error.statusCode, 404); return true; },
  );
});

// ---------------------------------------------------------------------------
// deleteDepartment
// ---------------------------------------------------------------------------

test("deleteDepartment: admin only -- every other role is denied before the repository is ever called", async () => {
  for (const role of USER_ROLES) {
    const repository = fakeDepartmentRepository([{ id: "dept-1", name: "Engineering" }]);
    const service = createDepartmentMutationService({ departmentRepository: repository });

    if (role === "admin") {
      await service.deleteDepartment(principalFor(role), "dept-1");
      assert.equal(repository.calls.deleteById.length, 1, role);
    } else {
      await assert.rejects(
        service.deleteDepartment(principalFor(role), "dept-1"),
        (error) => { assert.equal(error.code, "role_not_allowed"); return true; },
        role,
      );
      assert.equal(repository.calls.deleteById.length, 0, role);
    }
  }
});
