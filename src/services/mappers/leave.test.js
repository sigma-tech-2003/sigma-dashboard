import assert from "node:assert/strict";
import test from "node:test";
import { MappingError } from "./common.js";
import { fromApi, toApiCreate, toApiDecision } from "./leave.js";

const ROW = Object.freeze({
  id: "l1", employee_id: "e1", type: "Annual", start_date: "2026-02-10", end_date: "2026-02-12", days: 3,
  reason: "Family vacation", status: "approved", applied_on: "2026-02-05", decided_by_employee_id: "m1",
  decided_at: "2026-02-06T08:00:00.000Z", decision_recorded: true,
  created_at: "2026-02-05T09:00:00.000Z", updated_at: "2026-02-06T08:00:00.000Z",
});

test("fromApi gives the pages their field names; empId is the employee's id", () => {
  assert.deepEqual(fromApi(ROW), {
    id: "l1", empId: "e1", type: "Annual", start: "2026-02-10", end: "2026-02-12", days: 3, reason: "Family vacation",
    status: "approved", applied: "2026-02-05", decidedBy: "m1", decidedAt: "2026-02-06T08:00:00.000Z",
    createdAt: "2026-02-05T09:00:00.000Z", updatedAt: "2026-02-06T08:00:00.000Z",
  });
});

test("fromApi: a pending leave has empty decidedBy / decidedAt", () => {
  const record = fromApi({ ...ROW, status: "pending", decided_by_employee_id: null, decided_at: null });
  assert.equal(record.decidedBy, "");
  assert.equal(record.decidedAt, "");
});

test("fromApi keeps the leave type's title case, which the API shares with the pages", () => {
  for (const type of ["Annual", "Sick", "Casual", "Maternity", "Emergency"]) {
    assert.equal(fromApi({ ...ROW, type }).type, type);
  }
});

test("toApiCreate sends exactly the four fields the API accepts", () => {
  const body = toApiCreate({
    id: Date.now(), empId: "e1", type: "Sick", start: "2026-05-01", end: "2026-05-02", days: 2,
    reason: " Fever ", status: "pending", applied: "2026-04-30",
  });

  assert.deepEqual(body, { type: "Sick", start_date: "2026-05-01", end_date: "2026-05-02", reason: "Fever" });
});

test("toApiCreate never sends the id, the employee, the days, the status or the applied date", () => {
  const body = toApiCreate({ id: 1, empId: "e1", type: "Sick", start: "a", end: "b", days: 9, reason: "r", status: "approved", applied: "x" });

  assert.deepEqual(Object.keys(body).sort(), ["end_date", "reason", "start_date", "type"]);
});

test("toApiDecision sends { status } for approved and rejected", () => {
  assert.deepEqual(toApiDecision("approved"), { status: "approved" });
  assert.deepEqual(toApiDecision("rejected"), { status: "rejected" });
});

test("toApiDecision refuses pending and anything else", () => {
  for (const bad of ["pending", "Approved", "", undefined, null]) {
    assert.throws(() => toApiDecision(bad), (error) => error instanceof MappingError && error.code === "invalid-decision", String(bad));
  }
});
