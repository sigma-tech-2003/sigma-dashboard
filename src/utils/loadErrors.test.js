import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../services/apiClient.js";
import { describeLoadError, evaluateLoadErrors, isDeliberateDenial, joinLabels, loadErrorUnlessDenied } from "./loadErrors.js";

const apiError = (status, code, message) => new ApiError({ status, code, message });
const NETWORK = apiError(0, "network", "Unable to connect. Check your connection and try again.");
const OUTAGE = apiError(503, "unavailable", "The service is temporarily unavailable. Please try again.");

test("no errors is ok, whatever the data", () => {
  assert.equal(evaluateLoadErrors({ errors: {}, required: { employees: [] } }).status, "ok");
  assert.equal(evaluateLoadErrors({ errors: { employees: null }, required: { employees: [] } }).status, "ok");
  assert.equal(evaluateLoadErrors().status, "ok");
});

test("an EMPTY result with no error is ok: a legitimately empty collection must not be reported as a failure", () => {
  const result = evaluateLoadErrors({ errors: {}, required: { attendance: [], employees: [{ id: 1 }] } });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.blocking, []);
});

test("a required collection that failed and has nothing to show BLOCKS: a failure must not look like an empty result", () => {
  const result = evaluateLoadErrors({ errors: { attendance: NETWORK }, required: { attendance: [] } });

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocking.map((item) => item.name), ["attendance"]);
  assert.equal(result.blocking[0].label, "attendance records");
});

test("a required collection that failed but still has data from an earlier load is STALE, not blocked", () => {
  const result = evaluateLoadErrors({ errors: { payroll: OUTAGE }, required: { payroll: [{ id: "p1" }] } });

  assert.equal(result.status, "stale");
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.stale.map((item) => item.name), ["payroll"]);
});

test("blocked wins over stale when both occur", () => {
  const result = evaluateLoadErrors({
    errors: { employees: NETWORK, payroll: OUTAGE },
    required: { employees: [], payroll: [{ id: "p1" }] },
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocking.map((item) => item.name), ["employees"]);
  assert.deepEqual(result.stale.map((item) => item.name), ["payroll"]);
});

test("an optional collection that failed never blocks, even when empty", () => {
  const result = evaluateLoadErrors({ errors: { departments: NETWORK }, required: { employees: [{ id: 1 }] }, optional: { departments: [] } });

  assert.equal(result.status, "stale");
  assert.deepEqual(result.stale.map((item) => item.name), ["departments"]);
});

test("an error on a collection the page did not declare is ignored", () => {
  const result = evaluateLoadErrors({ errors: { projects: NETWORK }, required: { employees: [{ id: 1 }] } });

  assert.equal(result.status, "ok");
});

test("a non-array value counts as nothing to show", () => {
  assert.equal(evaluateLoadErrors({ errors: { kpis: NETWORK }, required: { kpis: undefined } }).status, "blocked");
  assert.equal(evaluateLoadErrors({ errors: { kpis: NETWORK }, required: { kpis: null } }).status, "blocked");
});

test("describeLoadError shows an ApiError's own message", () => {
  assert.equal(describeLoadError(NETWORK), "Unable to connect. Check your connection and try again.");
  assert.equal(describeLoadError(OUTAGE), "The service is temporarily unavailable. Please try again.");
});

test("describeLoadError never shows internal detail from a non-API error", () => {
  assert.equal(describeLoadError(new TypeError("Cannot read properties of undefined (reading 'map')")), "The data could not be loaded.");
  assert.equal(describeLoadError(new Error("SQL exploded at line 9")), "The data could not be loaded.");
  assert.equal(describeLoadError(null), "The data could not be loaded.");
  assert.equal(describeLoadError(apiError(500, "internal", "   ")), "The data could not be loaded.");
});

test("identical messages are listed once", () => {
  const result = evaluateLoadErrors({
    errors: { employees: NETWORK, attendance: NETWORK },
    required: { employees: [], attendance: [] },
  });

  assert.deepEqual(result.messages, ["Unable to connect. Check your connection and try again."]);
});

test("different messages are all kept", () => {
  const result = evaluateLoadErrors({
    errors: { employees: NETWORK, attendance: OUTAGE },
    required: { employees: [], attendance: [] },
  });

  assert.equal(result.messages.length, 2);
});

test("an unknown collection name falls back to the name itself as its label", () => {
  const result = evaluateLoadErrors({ errors: { widgets: NETWORK }, required: { widgets: [] } });

  assert.equal(result.blocking[0].label, "widgets");
});

test("joinLabels reads as a sentence", () => {
  assert.equal(joinLabels([]), "");
  assert.equal(joinLabels(["employees"]), "employees");
  assert.equal(joinLabels(["employees", "payroll records"]), "employees and payroll records");
  assert.equal(joinLabels(["a", "b", "c"]), "a, b and c");
});

test("stale entries say whether they still have data: out of date versus never loaded", () => {
  const result = evaluateLoadErrors({
    errors: { payroll: OUTAGE, departments: NETWORK },
    required: { payroll: [{ id: "p1" }] },
    optional: { departments: [] },
  });

  assert.equal(result.stale.find((item) => item.name === "payroll").hasData, true);
  assert.equal(result.stale.find((item) => item.name === "departments").hasData, false);
});

// ---- a deliberate refusal is not a failed load ---------------------------------------------------------------------

test("only an ApiError with status 403 is a deliberate denial", () => {
  assert.equal(isDeliberateDenial(apiError(403, "role_not_allowed", "no")), true);
  for (const other of [apiError(401, "unauthenticated", "x"), apiError(404, "not_found", "x"), apiError(409, "conflict", "x"), apiError(500, "internal", "x"), OUTAGE, NETWORK]) {
    assert.equal(isDeliberateDenial(other), false, String(other.status));
  }
  assert.equal(isDeliberateDenial(new Error("boom")), false);
  assert.equal(isDeliberateDenial({ name: "ApiError" }), false);
  for (const nothing of [null, undefined]) assert.equal(isDeliberateDenial(nothing), false);
});

test("loadErrorUnlessDenied hides a 403 and passes every real failure through untouched", () => {
  assert.equal(loadErrorUnlessDenied(apiError(403, "role_not_allowed", "no")), null);
  for (const real of [OUTAGE, NETWORK, apiError(500, "internal", "x"), apiError(401, "unauthenticated", "x")]) {
    assert.equal(loadErrorUnlessDenied(real), real);
  }
  assert.equal(loadErrorUnlessDenied(null), null);
  assert.equal(loadErrorUnlessDenied(undefined), undefined);
});

test("with the denial removed, a departments 403 reads as ok, while a departments outage still shows as stale", () => {
  const denied = loadErrorUnlessDenied(apiError(403, "role_not_allowed", "no"));
  assert.equal(evaluateLoadErrors({ errors: { departments: denied }, optional: { departments: [] } }).status, "ok");
  const outage = loadErrorUnlessDenied(OUTAGE);
  assert.equal(evaluateLoadErrors({ errors: { departments: outage }, optional: { departments: [] } }).status, "stale");
});

test("a 403 on a collection the page requires is NOT silenced by the helper being available", () => {
  const refusal = apiError(403, "role_not_allowed", "You do not have access.");
  // The hook for departments is the only caller. Anything else keeps its error, so a real denial of required data blocks.
  assert.equal(evaluateLoadErrors({ errors: { employees: refusal }, required: { employees: [] } }).status, "blocked");
});

