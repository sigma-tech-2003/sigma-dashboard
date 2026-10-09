import assert from "node:assert/strict";
import test from "node:test";
import { MappingError } from "./common.js";
import { fromApi, statusToApi, toApiCreate, toApiUpdate } from "./department.js";

const ROW = Object.freeze({
  id: "d1", company_id: "c", name: "Engineering", description: "Builds things", status: "active",
  manager_employee_id: "m1", created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-02-01T00:00:00.000Z",
});

test("fromApi: status is capitalised the way the pages write and compare it", () => {
  assert.equal(fromApi(ROW).status, "Active");
  assert.equal(fromApi({ ...ROW, status: "inactive" }).status, "Inactive");
});

test("fromApi: the manager is managerId, and nulls become empty strings", () => {
  assert.deepEqual(fromApi(ROW), {
    id: "d1", name: "Engineering", description: "Builds things", status: "Active", managerId: "m1",
    createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-02-01T00:00:00.000Z",
  });

  const bare = fromApi({ ...ROW, description: null, manager_employee_id: null });
  assert.equal(bare.description, "");
  assert.equal(bare.managerId, "");
});

test("statusToApi lowercases the two statuses and refuses anything else", () => {
  assert.equal(statusToApi("Active"), "active");
  assert.equal(statusToApi("Inactive"), "inactive");
  for (const bad of ["active", "ACTIVE", "", undefined, "Archived"]) {
    assert.throws(() => statusToApi(bad), (error) => error instanceof MappingError && error.code === "invalid-status", String(bad));
  }
});

test("toApiCreate sends name, description and status, and never a manager", () => {
  assert.deepEqual(
    toApiCreate({ name: " Finance ", description: "", status: "Active", managerId: "m1", id: 5, createdAt: "t" }),
    { name: "Finance", description: null, status: "active" },
  );
});

test("toApiCreate with no status omits it, so the server's default (active) applies", () => {
  assert.deepEqual(toApiCreate({ name: "Finance" }), { name: "Finance" });
});

test("toApiUpdate sends the manager, and an empty managerId clears it", () => {
  assert.deepEqual(toApiUpdate({ managerId: "m2" }), { manager_employee_id: "m2" });
  assert.deepEqual(toApiUpdate({ managerId: "" }), { manager_employee_id: null });
});

test("a read followed by a write of the unchanged record sends nothing", () => {
  const original = fromApi(ROW);
  assert.deepEqual(toApiUpdate({ ...original }, { original }), {});
});

test("a read followed by a write of an unchanged record with nulls sends nothing", () => {
  const original = fromApi({ ...ROW, description: null, manager_employee_id: null });
  assert.deepEqual(toApiUpdate({ ...original }, { original }), {});
});

test("toApiUpdate with the original sends only the changed field, with status lowercased", () => {
  const original = fromApi(ROW);
  assert.deepEqual(toApiUpdate({ ...original, status: "Inactive" }, { original }), { status: "inactive" });
});
