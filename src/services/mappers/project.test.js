import assert from "node:assert/strict";
import test from "node:test";
import { MappingError } from "./common.js";
import { fromApi, toApiCreate, toApiUpdate } from "./project.js";

const ROW = Object.freeze({
  id: "p1", company_id: "c", department_id: "d1", department_name: "Engineering", team_lead_id: "tl1",
  title: "Portal", description: "The portal", start_date: "2026-03-01", due_date: "2026-04-01", status: "active",
  assignedEmployeeIds: ["e1", "e2"], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
});
const DEPARTMENTS = [{ id: "d1", name: "Engineering" }, { id: "d2", name: "Finance" }];

test("fromApi: the department is a NAME for the pages (and the id rides along)", () => {
  assert.deepEqual(fromApi(ROW), {
    id: "p1", title: "Portal", description: "The portal", department: "Engineering", departmentId: "d1",
    teamLeadId: "tl1", assignedEmployeeIds: ["e1", "e2"], startDate: "2026-03-01", dueDate: "2026-04-01",
    status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  });
});

test("fromApi: assignedEmployeeIds is copied, and a missing list is empty", () => {
  const record = fromApi(ROW);
  record.assignedEmployeeIds.push("x");
  assert.deepEqual(ROW.assignedEmployeeIds, ["e1", "e2"]);
  assert.deepEqual(fromApi({ ...ROW, assignedEmployeeIds: undefined }).assignedEmployeeIds, []);
});

test("fromApi: nulls become empty strings", () => {
  const record = fromApi({ ...ROW, team_lead_id: null, description: null, department_name: null, department_id: null });
  assert.equal(record.teamLeadId, "");
  assert.equal(record.description, "");
  assert.equal(record.department, "");
  assert.equal(record.departmentId, "");
});

test("toApiCreate renames every field and resolves the department through the lookup", () => {
  const body = toApiCreate({
    id: 12345, title: " Portal ", description: "The portal", department: "Finance", teamLeadId: "tl1",
    assignedEmployeeIds: ["e1", "e2"], startDate: "2026-03-01", dueDate: "2026-04-01", status: "draft",
    createdAt: "t", updatedAt: "t",
  }, { departments: DEPARTMENTS });

  assert.deepEqual(body, {
    title: "Portal", description: "The portal", team_lead_id: "tl1", start_date: "2026-03-01", due_date: "2026-04-01",
    status: "draft", assigned_employee_ids: ["e1", "e2"], department_id: "d2",
  });
});

test("toApiCreate never sends the id or timestamps, and omits the department when there is none (manager, tl)", () => {
  const body = toApiCreate({ id: 1, title: "T", createdAt: "t", updatedAt: "t", assignedEmployeeIds: ["e1"] });
  assert.deepEqual(body, { title: "T", assigned_employee_ids: ["e1"] });
});

test("toApiCreate: a blank team lead goes as null", () => {
  assert.equal(toApiCreate({ teamLeadId: "" }).team_lead_id, null);
});

test("toApiCreate: an unknown department name is a MappingError", () => {
  assert.throws(
    () => toApiCreate({ title: "T", department: "Nowhere" }, { departments: DEPARTMENTS }),
    (error) => error instanceof MappingError && error.code === "unknown-department",
  );
});

test("a read followed by a write of the unchanged record sends nothing", () => {
  const original = fromApi(ROW);
  assert.deepEqual(toApiUpdate({ ...original }, { original }), {});
});

test("toApiUpdate with the original sends only what changed", () => {
  const original = fromApi(ROW);
  assert.deepEqual(
    toApiUpdate({ ...original, status: "completed", title: "Portal v2" }, { original }),
    { status: "completed", title: "Portal v2" },
  );
});

test("toApiUpdate: a department change carries the new id, and the assignments when they are sent with it", () => {
  const original = fromApi(ROW);
  const body = toApiUpdate(
    { ...original, department: "Finance", teamLeadId: "tl2", assignedEmployeeIds: ["e9"] },
    { original, departments: DEPARTMENTS },
  );

  assert.deepEqual(body, { department_id: "d2", team_lead_id: "tl2", assigned_employee_ids: ["e9"] });
});

test("toApiUpdate: a changed assignment list is sent as strings", () => {
  const original = fromApi(ROW);
  assert.deepEqual(toApiUpdate({ assignedEmployeeIds: ["e1"] }, { original }), { assigned_employee_ids: ["e1"] });
});
