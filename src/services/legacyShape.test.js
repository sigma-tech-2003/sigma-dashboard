import assert from "node:assert/strict";
import test from "node:test";
import { findRecordById, withDocId } from "./legacyShape.js";

const A = "9f1c2d3e-0000-4000-8000-000000000001";
const B = "9f1c2d3e-0000-4000-8000-000000000002";
const EMPLOYEES = [{ id: A, name: "Aisha" }, { id: B, name: "Bilal" }];

// PayrollPage selects an employee from a <select>, whose value is always a string, and used to look the employee
// up with `e.id === +value`. A UUID turns that into NaN, so no employee was ever found and payroll could neither be
// previewed nor processed.

test("a UUID selected from a <select> finds its employee (it did not when the page used +value)", () => {
  assert.deepEqual(findRecordById(EMPLOYEES, B), { id: B, name: "Bilal" });
  assert.equal(Number.isNaN(+B), true, "the old lookup compared against NaN");
});

test("the lookup compares as strings, so a numeric id from either side still matches", () => {
  assert.equal(findRecordById([{ id: 7, name: "x" }], "7").name, "x");
  assert.equal(findRecordById([{ id: "7", name: "x" }], 7).name, "x");
});

test("an unknown id finds nothing, as null", () => {
  assert.equal(findRecordById(EMPLOYEES, "00000000-0000-4000-8000-000000000000"), null);
  assert.equal(findRecordById(EMPLOYEES, ""), null);
});

test("an empty or missing list finds nothing instead of throwing", () => {
  assert.equal(findRecordById([], A), null);
  assert.equal(findRecordById(undefined, A), null);
  assert.equal(findRecordById(null, A), null);
});

test("records without an id never match by accident, and neither does a missing id", () => {
  assert.equal(findRecordById([{ name: "no id" }, null, undefined], "undefined"), null);
  assert.equal(findRecordById([{ name: "no id" }], undefined), null, "String(undefined) would have matched a record with no id");
  assert.equal(findRecordById([{ id: null, name: "null id" }], null), null);
});

test("withDocId copies the id into _docId and leaves the rest alone", () => {
  assert.deepEqual(withDocId({ id: A, name: "Aisha" }), { id: A, name: "Aisha", _docId: A });
});
