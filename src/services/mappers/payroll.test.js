import assert from "node:assert/strict";
import test from "node:test";
import { MONTHS, MappingError } from "./common.js";
import { fromApi, monthNameToNumber, monthNumberToName, toApiCreate, toApiUpdate } from "./payroll.js";

const ROW = Object.freeze({
  id: "pr1", employee_id: "e1", period_year: 2026, period_month: 3, basic: 120000.5, allowances: 15000.25,
  bonus: 10000, deductions: 5000, gross: 145000.75, tax: 6000, net: 134000.75, status: "processed",
  created_at: "2026-03-31T00:00:00.000Z", updated_at: "2026-03-31T00:00:00.000Z",
});

test("fromApi: the month is an English name and empId is the employee's id", () => {
  assert.deepEqual(fromApi(ROW), {
    id: "pr1", empId: "e1", month: "March", year: 2026, basic: 120000.5, allowances: 15000.25, bonus: 10000,
    deductions: 5000, gross: 145000.75, tax: 6000, net: 134000.75, status: "processed",
    createdAt: "2026-03-31T00:00:00.000Z", updatedAt: "2026-03-31T00:00:00.000Z",
  });
});

test("every month number maps to its name and back", () => {
  for (let number = 1; number <= 12; number += 1) {
    assert.equal(monthNumberToName(number), MONTHS[number - 1]);
    assert.equal(monthNameToNumber(MONTHS[number - 1]), number);
  }
  assert.equal(monthNumberToName(1), "January");
  assert.equal(monthNumberToName(12), "December");
});

test("month names that are not exactly English month names are refused", () => {
  for (const bad of ["march", "Mar", "", undefined, "Smarch"]) {
    assert.throws(() => monthNameToNumber(bad), (error) => error instanceof MappingError && error.code === "invalid-month", String(bad));
  }
  for (const bad of [0, 13, undefined, "x"]) {
    assert.throws(() => monthNumberToName(bad), MappingError, String(bad));
  }
});

test("fromApi on an out-of-range month fails loudly rather than guessing", () => {
  assert.throws(() => fromApi({ ...ROW, period_month: 13 }), MappingError);
});

test("toApiCreate turns the month name into a number and sends the amounts the page chose", () => {
  const body = toApiCreate({
    id: Date.now(), empId: "e1", month: "April", year: "2026", basic: 120000, allowances: 20000, bonus: "10000",
    deductions: 5000, tax: 8500, net: 136500, status: "processed",
  });

  assert.deepEqual(body, {
    employee_id: "e1", period_month: 4, period_year: 2026, basic: 120000, allowances: 20000, bonus: 10000,
    deductions: 5000, status: "processed",
  });
});

test("toApiCreate NEVER sends tax, net or gross (generated columns) or the page's id", () => {
  const body = toApiCreate({ id: 1, empId: "e1", month: "May", year: 2026, tax: 1, net: 2, gross: 3 });

  for (const key of ["tax", "net", "gross", "id"]) {
    assert.equal(Object.hasOwn(body, key), false, key);
  }
});

test("toApiCreate with only the employee and period lets the server default the money from the employee", () => {
  assert.deepEqual(
    toApiCreate({ empId: "e1", month: "June", year: 2026 }),
    { employee_id: "e1", period_month: 6, period_year: 2026 },
  );
});

test("toApiCreate with an invalid month name is a MappingError", () => {
  assert.throws(() => toApiCreate({ empId: "e1", month: "Nope", year: 2026 }), MappingError);
});

test("money in the payload stays numeric: nothing is concatenated as strings", () => {
  const body = toApiCreate({ empId: "e1", month: "June", year: 2026, basic: "100000", allowances: "20000", bonus: "5" });

  assert.equal(body.basic + body.allowances + body.bonus, 120005);
});

test("a read followed by a write of the unchanged record sends nothing", () => {
  const original = fromApi(ROW);
  assert.deepEqual(toApiUpdate({ ...original }, { original }), {});
});

test("toApiUpdate: marking a draft processed sends only the status", () => {
  const original = fromApi({ ...ROW, status: "draft" });
  assert.deepEqual(toApiUpdate({ ...original, status: "processed" }, { original }), { status: "processed" });
});

test("toApiUpdate: changing the month sends the number", () => {
  const original = fromApi(ROW);
  assert.deepEqual(toApiUpdate({ ...original, month: "May" }, { original }), { period_month: 5 });
});
