import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_DEPARTMENT_VALUE, HR_DEPARTMENT_HINT, createDepartmentMessage, departmentOptions,
} from "./departmentOptions.js";

const DEPARTMENTS = [
  { id: "1", name: "Engineering", status: "Active" },
  { id: "2", name: "Finance", status: "Active" },
  { id: "3", name: "Retired", status: "Inactive" },
];
const names = (result) => result.options.map((option) => option.value);

test("admin: every ACTIVE department, can create, not locked, no hint", () => {
  const result = departmentOptions({ role: "admin", dept: "Engineering" }, DEPARTMENTS);

  assert.deepEqual(names(result), ["Engineering", "Finance"]);
  assert.equal(result.canCreate, true);
  assert.equal(result.locked, false);
  assert.equal(result.hint, "");
});

test("hr: the same list, NO create, and the hint saying why", () => {
  const result = departmentOptions({ role: "hr", dept: "People" }, DEPARTMENTS);

  assert.deepEqual(names(result), ["Engineering", "Finance"]);
  assert.equal(result.canCreate, false);
  assert.equal(result.locked, false);
  assert.equal(result.hint, HR_DEPARTMENT_HINT);
  assert.match(result.hint, /administrator/);
});

test("manager and tl: their own department as the ONLY option, locked, even though they cannot read the list", () => {
  for (const role of ["manager", "tl"]) {
    const result = departmentOptions({ role, dept: "Engineering" }, []);

    assert.deepEqual(result.options, [{ value: "Engineering", label: "Engineering" }], role);
    assert.equal(result.locked, true);
    assert.equal(result.canCreate, false);
    assert.equal(result.hint, "");
  }
});

test("manager and tl never see other departments, even if the list were somehow loaded", () => {
  const result = departmentOptions({ role: "manager", dept: "Finance" }, DEPARTMENTS);

  assert.deepEqual(names(result), ["Finance"]);
});

test("manager with no department has no option (locked and empty), not a crash", () => {
  const result = departmentOptions({ role: "tl" }, DEPARTMENTS);

  assert.deepEqual(result.options, []);
  assert.equal(result.locked, true);
});

test("nobody else can create: employee and unknown roles get no create option", () => {
  for (const role of ["employee", "owner", undefined]) assert.equal(departmentOptions({ role }, DEPARTMENTS).canCreate, false, String(role));
  assert.equal(departmentOptions(null, DEPARTMENTS).canCreate, false);
});

test("a department just created and selected stays selectable before the polled list includes it", () => {
  const result = departmentOptions({ role: "admin" }, DEPARTMENTS, "Operations");

  assert.deepEqual(names(result), ["Engineering", "Finance", "Operations"]);
});

test("...but is not listed twice once the list has it (compared without regard to case)", () => {
  const result = departmentOptions({ role: "admin" }, DEPARTMENTS, "finance");

  assert.deepEqual(names(result), ["Engineering", "Finance"]);
});

test("the create sentinel is never itself an option, and cannot collide with a real name", () => {
  const result = departmentOptions({ role: "admin" }, DEPARTMENTS, CREATE_DEPARTMENT_VALUE);

  assert.deepEqual(names(result), ["Engineering", "Finance"]);
  assert.equal(DEPARTMENTS.some((department) => department.name === CREATE_DEPARTMENT_VALUE), false);
});

test("a missing or malformed list is no options, not a crash", () => {
  for (const list of [undefined, null, {}, "x"]) assert.deepEqual(departmentOptions({ role: "admin" }, list).options, []);
});

test("a malformed department entry is skipped", () => {
  const result = departmentOptions({ role: "admin" }, [null, { name: "", status: "Active" }, { status: "Active" }, { name: "Ops", status: "Active" }]);

  assert.deepEqual(names(result), ["Ops"]);
});

// ---- the create-department message ------------------------------------------------------------------------------

const apiError = (status, message = "server wording") => Object.assign(new Error(message), { name: "ApiError", status });

test("a duplicate name says so, with the name, and not the server's wording", () => {
  const message = createDepartmentMessage(apiError(409, "SQL unique violation"), "Finance");

  assert.equal(message, 'A department named "Finance" already exists.');
});

test("a refusal, a bad name, being offline and anything else each have their own plain message", () => {
  assert.match(createDepartmentMessage(apiError(403)), /Only an administrator/);
  assert.match(createDepartmentMessage(apiError(400)), /valid department name/);
  assert.match(createDepartmentMessage(apiError(0)), /Unable to connect/);
  assert.match(createDepartmentMessage(apiError(503)), /Unable to connect/);
  assert.match(createDepartmentMessage(apiError(500)), /could not be created/);
  assert.match(createDepartmentMessage(new Error("boom")), /could not be created/);
  assert.match(createDepartmentMessage(undefined), /could not be created/);
});

test("no message ever carries the server's own text", () => {
  for (const status of [0, 400, 403, 409, 500, 503]) {
    assert.doesNotMatch(createDepartmentMessage(apiError(status, "SQL exploded at line 9")), /SQL|line 9/, String(status));
  }
});
