import assert from "node:assert/strict";
import test from "node:test";
import { MappingError } from "./common.js";
import { fromApi, toApiQuery } from "./leaveBalance.js";

const RESPONSE = Object.freeze({
  employee_id: "e1", as_of: "2026-10-09", year: 2026,
  taken: { Annual: 3, Sick: 2, Casual: 0, Maternity: 0, Emergency: 1 }, total: 6,
});

test("fromApi returns a one-entry map keyed by the employee's id, as the pages index balances", () => {
  assert.deepEqual(fromApi(RESPONSE), {
    e1: { taken: { Annual: 3, Sick: 2, Casual: 0, Maternity: 0, Emergency: 1 }, total: 6, year: 2026, asOf: "2026-10-09" },
  });
});

test("fromApi has no total-allowed or remaining figure: there are no entitlements (D40)", () => {
  const entry = fromApi(RESPONSE).e1;

  for (const key of ["t", "u", "r", "remaining", "allowed", "balance"]) {
    assert.equal(Object.hasOwn(entry, key), false, key);
  }
});

test("fromApi copies the taken map, so a page cannot mutate the response", () => {
  const entry = fromApi(RESPONSE).e1;
  entry.taken.Annual = 99;
  assert.equal(RESPONSE.taken.Annual, 3);
});

test("several responses merge into one map by employee id", () => {
  const merged = Object.assign(
    {},
    fromApi(RESPONSE),
    fromApi({ ...RESPONSE, employee_id: "e2", taken: { Annual: 1 }, total: 1 }),
  );

  assert.deepEqual(Object.keys(merged).sort(), ["e1", "e2"]);
});

test("fromApi refuses a malformed response", () => {
  for (const bad of [null, undefined, {}, { employee_id: "e1" }, { employee_id: 5, taken: {} }, { employee_id: "e1", taken: null }]) {
    assert.throws(() => fromApi(bad), (error) => error instanceof MappingError && error.code === "malformed-response");
  }
});

test("toApiQuery omits the employee for the caller's own balance and sends the date when given", () => {
  assert.deepEqual(toApiQuery(), { employee_id: undefined, as_of: undefined });
  assert.deepEqual(toApiQuery({ employeeId: "e2", asOf: "2026-01-01" }), { employee_id: "e2", as_of: "2026-01-01" });
  assert.deepEqual(toApiQuery({ employeeId: "" }), { employee_id: undefined, as_of: undefined });
});
