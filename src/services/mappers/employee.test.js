import assert from "node:assert/strict";
import test from "node:test";
import { MappingError } from "./common.js";
import { fromApi, toApiCreate, toApiDelete, toApiUpdate } from "./employee.js";

const ID = "11111111-1111-4111-8111-111111111111";
const DEPT = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

const ROW = Object.freeze({
  id: ID, user_id: "u", company_id: "c",
  department_id: DEPT, department_name: "Engineering",
  team_lead_id: LEAD, employee_number: "EMP-0007", full_name: "Aisha Khan",
  phone: "0300-1234567", position_title: "Engineer", employment_status: "active",
  joined_on: "2024-03-15", basic: 120000.5, allowances: 15000.25,
  created_at: "2024-03-15T09:00:00.000Z", updated_at: "2024-04-01T09:00:00.000Z",
  role: "employee", email: "aisha@example.com",
});

test("fromApi gives the pages the record shape they know", () => {
  assert.deepEqual(fromApi(ROW), {
    id: ID, name: "Aisha Khan", email: "aisha@example.com", phone: "0300-1234567",
    dept: "Engineering", departmentId: DEPT, pos: "Engineer", basic: 120000.5, allowances: 15000.25,
    joinDate: "2024-03-15", role: "employee", status: "active", teamLeadId: LEAD, empId: "EMP-0007",
    createdAt: "2024-03-15T09:00:00.000Z", updatedAt: "2024-04-01T09:00:00.000Z",
  });
});

test("fromApi: empId on an employee is the employee NUMBER, not the id", () => {
  const record = fromApi(ROW);
  assert.equal(record.empId, "EMP-0007");
  assert.notEqual(record.empId, record.id);
});

test("fromApi: nulls become the empty strings the pages bind to", () => {
  const record = fromApi({ ...ROW, phone: null, department_id: null, department_name: null, team_lead_id: null });

  assert.equal(record.phone, "");
  assert.equal(record.dept, "");
  assert.equal(record.departmentId, "");
  assert.equal(record.teamLeadId, "");
});

test("fromApi: money arrives as numbers and stays numbers", () => {
  const record = fromApi(ROW);
  assert.equal(typeof record.basic, "number");
  assert.equal(typeof record.allowances, "number");
});

test("fromApi passes on_leave and terminated through unchanged", () => {
  assert.equal(fromApi({ ...ROW, employment_status: "on_leave" }).status, "on_leave");
  assert.equal(fromApi({ ...ROW, employment_status: "terminated" }).status, "terminated");
});

test("fromApi keeps ids as the UUID strings they are", () => {
  const record = fromApi(ROW);
  assert.equal(record.id, ID);
  assert.equal(record.teamLeadId, LEAD);
});

test("toApiCreate renames every field and sends the department id from the lookup", () => {
  const body = toApiCreate(
    { name: " New Hire ", email: "NEW@Example.com ", phone: "0301", dept: "Engineering", pos: "Dev",
      joinDate: "2026-09-25", basic: "50000", allowances: 5000, role: "employee", status: "inactive", teamLeadId: LEAD },
    { departments: [{ id: DEPT, name: "Engineering" }] },
  );

  assert.deepEqual(body, {
    full_name: "New Hire", email: "new@example.com", phone: "0301", position_title: "Dev",
    joined_on: "2026-09-25", basic: 50000, allowances: 5000, role: "employee", team_lead_id: LEAD,
    department_id: DEPT, employment_status: "inactive",
  });
});

test("toApiCreate never sends the id, the employee number, the timestamps or the carried departmentId", () => {
  const body = toApiCreate({
    id: "x", empId: "EMP-1", createdAt: "t", updatedAt: "t", name: "A", email: "a@b.co", departmentId: DEPT,
    pos: "P", joinDate: "2026-01-01", basic: 1, allowances: 0, role: "employee",
  });

  for (const key of ["id", "empId", "createdAt", "updatedAt", "departmentId", "employee_number"]) {
    assert.equal(Object.hasOwn(body, key), false, key);
  }
  assert.equal(body.department_id, DEPT, "but the carried id still resolves the department");
});

test("toApiCreate: a blank phone and a blank team lead go as null, and omitting the department omits the key", () => {
  const body = toApiCreate({ name: "A", email: "a@b.co", phone: "", teamLeadId: "", dept: "" });

  assert.equal(body.phone, null);
  assert.equal(body.team_lead_id, null);
  assert.equal(Object.hasOwn(body, "department_id"), false);
});

test("toApiCreate with a department name that cannot be resolved is a MappingError", () => {
  assert.throws(
    () => toApiCreate({ name: "A", dept: "Nowhere" }, { departments: [{ id: DEPT, name: "Engineering" }] }),
    (error) => error instanceof MappingError && error.code === "unknown-department",
  );
});

test("toApiUpdate with the original sends only what changed", () => {
  const original = fromApi(ROW);
  const body = toApiUpdate({ ...original, pos: "Senior Engineer", phone: "0302" }, { original });

  assert.deepEqual(body, { position_title: "Senior Engineer", phone: "0302" });
});

test("a read followed by a write of the unchanged record sends nothing", () => {
  const original = fromApi(ROW);

  assert.deepEqual(toApiUpdate({ ...original }, { original }), {});
});

test("a read followed by a write survives for a record with nulls too", () => {
  const original = fromApi({ ...ROW, phone: null, team_lead_id: null, department_id: null, department_name: null });

  assert.deepEqual(toApiUpdate({ ...original }, { original }), {});
});

test("toApiUpdate: a manager (no departments list) editing an unrelated field sends no department", () => {
  const original = fromApi(ROW);
  const body = toApiUpdate({ ...original, pos: "Lead" }, { original });

  assert.equal(Object.hasOwn(body, "department_id"), false);
});

test("toApiUpdate: an admin changing the department sends the new id from the lookup", () => {
  const original = fromApi(ROW);
  const departments = [{ id: DEPT, name: "Engineering" }, { id: "d-fin", name: "Finance" }];
  const body = toApiUpdate({ ...original, dept: "Finance" }, { original, departments });

  assert.deepEqual(body, { department_id: "d-fin" });
});

test("toApiUpdate: status becomes employment_status, and on_leave / terminated are allowed on update", () => {
  const original = fromApi(ROW);

  assert.deepEqual(toApiUpdate({ status: "on_leave" }, { original }), { employment_status: "on_leave" });
  assert.deepEqual(toApiUpdate({ status: "terminated" }, { original }), { employment_status: "terminated" });
});

test("toApiUpdate without an original sends what it is given, and only known keys", () => {
  assert.deepEqual(toApiUpdate({ pos: "X", bogus: 1 }), { position_title: "X" });
});

test("toApiDelete sends the replacement team lead when there is one, and nothing otherwise", () => {
  assert.deepEqual(toApiDelete({ replacementTeamLeadId: LEAD }), { replacement_team_lead_id: LEAD });
  assert.deepEqual(toApiDelete({ replacementTeamLeadId: "" }), {});
  assert.deepEqual(toApiDelete({}), {});
  assert.deepEqual(toApiDelete(), {});
});
