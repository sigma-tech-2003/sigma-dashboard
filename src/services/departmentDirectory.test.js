import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { departmentDirectory } from "./departmentDirectory.js";
import { legacyCodeFor } from "./mutationErrors.js";
import { MappingError } from "./mappers/common.js";
import { ApiError } from "./apiClient.js";

beforeEach(() => departmentDirectory.clear());

test("learn stores id/name pairs and lookup returns them in the mappers' shape", () => {
  departmentDirectory.learn([{ id: "d1", name: "Engineering" }, { id: "d2", name: "Finance" }]);

  assert.deepEqual(departmentDirectory.lookup(), [{ id: "d1", name: "Engineering" }, { id: "d2", name: "Finance" }]);
});

test("learn ignores incomplete pairs", () => {
  departmentDirectory.learn([{ id: "", name: "x" }, { id: "d", name: "" }, { id: 5, name: "n" }, null, undefined, {}]);

  assert.deepEqual(departmentDirectory.lookup(), []);
});

test("a renamed department replaces the old name for its id", () => {
  departmentDirectory.learn([{ id: "d1", name: "Old" }]);
  departmentDirectory.learn([{ id: "d1", name: "New" }]);

  assert.deepEqual(departmentDirectory.lookup(), [{ id: "d1", name: "New" }]);
});

test("learnFromRecords reads departmentId and the name key from page-shaped records", () => {
  departmentDirectory.learnFromRecords([{ departmentId: "d1", dept: "Engineering" }, { departmentId: "", dept: "" }], "dept");
  departmentDirectory.learnFromRecords([{ departmentId: "d2", department: "Finance" }], "department");

  assert.deepEqual(departmentDirectory.lookup(), [{ id: "d1", name: "Engineering" }, { id: "d2", name: "Finance" }]);
});

test("clear empties it (on sign-out)", () => {
  departmentDirectory.learn([{ id: "d1", name: "x" }]);
  departmentDirectory.clear();

  assert.deepEqual(departmentDirectory.lookup(), []);
});

// ---- ApiError -> the codes the pages' error classes use ---------------------------------------------------------

const api = (status, code = "x") => new ApiError({ status, code, message: "m" });

test("legacyCodeFor maps statuses to the codes the pages already render", () => {
  assert.equal(legacyCodeFor(api(0, "network")), "unavailable");
  assert.equal(legacyCodeFor(api(503)), "unavailable");
  assert.equal(legacyCodeFor(api(401)), "unauthenticated");
  assert.equal(legacyCodeFor(api(403)), "permission-denied");
  assert.equal(legacyCodeFor(api(404)), "not-found");
  assert.equal(legacyCodeFor(api(400)), "invalid-argument");
  assert.equal(legacyCodeFor(api(500)), "internal");
});

test("legacyCodeFor: a 409 for a duplicate is already-exists, any other 409 is failed-precondition", () => {
  assert.equal(legacyCodeFor(api(409, "email_already_exists")), "already-exists");
  assert.equal(legacyCodeFor(api(409, "payroll_already_recorded")), "already-exists");
  assert.equal(legacyCodeFor(api(409, "leave_already_decided")), "failed-precondition");
});

test("legacyCodeFor: the team lead replacement rules are their own codes", () => {
  assert.equal(legacyCodeFor(api(400, "team_lead_replacement_required")), "replacement-required");
  assert.equal(legacyCodeFor(api(403, "team_lead_replacement_invalid")), "replacement-invalid");
});

test("legacyCodeFor: a MappingError is an invalid argument, and anything else is internal", () => {
  assert.equal(legacyCodeFor(new MappingError("unknown-department", "x")), "invalid-argument");
  assert.equal(legacyCodeFor(new Error("boom")), "internal");
  assert.equal(legacyCodeFor(null), "internal");
});
