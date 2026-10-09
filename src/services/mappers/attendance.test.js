import assert from "node:assert/strict";
import test from "node:test";
import { fromApi, toApiCreate, toApiUpdate } from "./attendance.js";

const ROW = Object.freeze({
  id: "a1", employee_id: "e1", work_date: "2026-03-02", status: "present", check_in: "09:05", check_out: "17:30",
  notes: "On site", created_at: "2026-03-02T09:05:00.000Z", updated_at: "2026-03-02T17:30:00.000Z",
});
const ABSENT = Object.freeze({ ...ROW, status: "absent", check_in: null, check_out: null, notes: null });

test("fromApi: work_date is date, times are HH:MM text, and empId is the employee's id", () => {
  assert.deepEqual(fromApi(ROW), {
    id: "a1", empId: "e1", date: "2026-03-02", status: "present", checkIn: "09:05", checkOut: "17:30", notes: "On site",
    createdAt: "2026-03-02T09:05:00.000Z", updatedAt: "2026-03-02T17:30:00.000Z",
  });
});

test("fromApi: no times and no notes become empty strings", () => {
  const record = fromApi(ABSENT);
  assert.equal(record.checkIn, "");
  assert.equal(record.checkOut, "");
  assert.equal(record.notes, "");
});

test("toApiCreate: empty strings become null, which the API wants for an absent or leave record", () => {
  const body = toApiCreate({ empId: "e1", date: "2026-03-03", status: "absent", checkIn: "", checkOut: "", notes: "" });

  assert.deepEqual(body, {
    employee_id: "e1", work_date: "2026-03-03", status: "absent", check_in: null, check_out: null, notes: null,
  });
});

test("toApiCreate: a present record keeps its times", () => {
  const body = toApiCreate({ empId: "e1", date: "2026-03-03", status: "present", checkIn: "09:00", checkOut: "17:00", notes: "x" });

  assert.equal(body.check_in, "09:00");
  assert.equal(body.check_out, "17:00");
});

test("toApiCreate never sends the page's timestamps or id", () => {
  const body = toApiCreate({ id: 7, empId: "e1", date: "d", status: "present", createdAt: "t", updatedAt: "t" });

  assert.equal(Object.hasOwn(body, "id"), false);
  assert.equal(Object.hasOwn(body, "createdAt"), false);
  assert.equal(Object.hasOwn(body, "updatedAt"), false);
});

test("a read followed by a write of the unchanged record sends nothing, for present and absent alike", () => {
  for (const row of [ROW, ABSENT]) {
    const original = fromApi(row);
    assert.deepEqual(toApiUpdate({ ...original }, { original }), {}, row.status);
  }
});

test("toApiUpdate: marking a present record absent clears the times with nulls", () => {
  const original = fromApi(ROW);
  const body = toApiUpdate({ ...original, status: "absent", checkIn: "", checkOut: "" }, { original });

  assert.deepEqual(body, { status: "absent", check_in: null, check_out: null });
});

test("toApiUpdate without an original sends what it is given", () => {
  assert.deepEqual(toApiUpdate({ notes: "late bus" }), { notes: "late bus" });
});
