import assert from "node:assert/strict";
import test from "node:test";
import {
  MONTHS,
  MappingError,
  emptyToNull,
  idOrEmpty,
  nullToEmpty,
  onlyChanged,
  pickMapped,
  resolveDepartmentId,
} from "./common.js";

test("emptyToNull turns blank into null and keeps everything else", () => {
  assert.equal(emptyToNull(""), null);
  assert.equal(emptyToNull("   "), null);
  assert.equal(emptyToNull(undefined), null);
  assert.equal(emptyToNull(null), null);
  assert.equal(emptyToNull("x"), "x");
  assert.equal(emptyToNull(0), 0);
});

test("nullToEmpty turns null and undefined into an empty string and keeps everything else", () => {
  assert.equal(nullToEmpty(null), "");
  assert.equal(nullToEmpty(undefined), "");
  assert.equal(nullToEmpty("x"), "x");
  assert.equal(nullToEmpty(0), 0);
});

test("idOrEmpty keeps an id as the string it is and never coerces it to a number", () => {
  assert.equal(idOrEmpty("9f1c2d3e-0000-4000-8000-000000000001"), "9f1c2d3e-0000-4000-8000-000000000001");
  assert.equal(idOrEmpty(null), "");
  assert.equal(idOrEmpty(undefined), "");
});

test("MONTHS is January to December in order", () => {
  assert.equal(MONTHS.length, 12);
  assert.equal(MONTHS[0], "January");
  assert.equal(MONTHS[11], "December");
});

test("pickMapped emits only the API keys whose page key is present, converting each", () => {
  const fields = [["a", "api_a"], ["b", "api_b", (value) => value * 2], ["c", "api_c"]];

  assert.deepEqual(pickMapped({ a: 1, b: 2 }, fields), { api_a: 1, api_b: 4 });
  assert.deepEqual(pickMapped({}, fields), {});
  assert.deepEqual(pickMapped({ c: null }, fields), { api_c: null }, "a present null is kept");
  assert.deepEqual(pickMapped({ a: 1, unknown: 9 }, fields), { api_a: 1 }, "an unknown page key is dropped");
});

test("onlyChanged keeps only the keys that differ from the original", () => {
  const original = { name: "A", phone: "", ids: ["1", "2"], lead: null };

  assert.deepEqual(onlyChanged({ name: "A", phone: "", ids: ["1", "2"], lead: "" }, original), {});
  assert.deepEqual(onlyChanged({ name: "B", phone: "" }, original), { name: "B" });
  assert.deepEqual(onlyChanged({ ids: ["2", "1"] }, original), { ids: ["2", "1"] }, "order matters for lists");
  assert.deepEqual(onlyChanged({ ids: ["1", "2", "3"] }, original), { ids: ["1", "2", "3"] });
});

test("onlyChanged treats null, undefined and an empty string as the same 'nothing'", () => {
  assert.deepEqual(onlyChanged({ lead: "" }, { lead: null }), {});
  assert.deepEqual(onlyChanged({ lead: null }, { lead: "" }), {});
  assert.deepEqual(onlyChanged({ lead: undefined }, { lead: "" }), {});
  assert.deepEqual(onlyChanged({ lead: "x" }, { lead: "" }), { lead: "x" });
});

test("onlyChanged without an original returns the changes untouched", () => {
  const changes = { name: "A" };
  assert.equal(onlyChanged(changes, undefined), changes);
});

test("resolveDepartmentId: a name in the lookup resolves to its id", () => {
  const departments = [{ id: "d1", name: "Engineering" }, { id: "d2", name: "Finance" }];

  assert.equal(resolveDepartmentId({ name: "Finance", departments }), "d2");
  assert.equal(resolveDepartmentId({ name: " Finance ", departments }), "d2", "surrounding whitespace is ignored");
});

test("resolveDepartmentId: the lookup wins over a carried departmentId when the name changed", () => {
  const departments = [{ id: "d1", name: "Engineering" }, { id: "d2", name: "Finance" }];

  assert.equal(resolveDepartmentId({ name: "Finance", departmentId: "d1", departments }), "d2");
});

test("resolveDepartmentId: with no lookup (manager, tl, employee) the carried departmentId is used", () => {
  assert.equal(resolveDepartmentId({ name: "Engineering", departmentId: "d1" }), "d1");
  assert.equal(resolveDepartmentId({ name: "Engineering", departmentId: "d1", departments: [] }), "d1");
});

test("resolveDepartmentId: no name and no id means omit the field", () => {
  assert.equal(resolveDepartmentId({ name: "" }), undefined);
  assert.equal(resolveDepartmentId({ name: undefined, departments: [] }), undefined);
});

test("resolveDepartmentId: a name that resolves to nothing is an error, never silently dropped", () => {
  assert.throws(
    () => resolveDepartmentId({ name: "Nowhere", departments: [{ id: "d1", name: "Engineering" }] }),
    (error) => error instanceof MappingError && error.code === "unknown-department",
  );
  assert.throws(() => resolveDepartmentId({ name: "Nowhere" }), MappingError);
});
