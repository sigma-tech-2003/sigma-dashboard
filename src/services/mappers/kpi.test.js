import assert from "node:assert/strict";
import test from "node:test";
import { MappingError } from "./common.js";
import { fromApi, toApiCreate, toApiRating, toApiUpdate } from "./kpi.js";

const ROW = Object.freeze({
  id: "k1", project_id: "p1", employee_id: "e1", title: "Sprint velocity", target: 40, current_value: 42.5,
  weight: 25, period: "Q1 2026", status: "active", rating: 8, rated_by_employee_id: "m1",
  rated_at: "2026-03-31T10:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-31T10:00:00.000Z",
});

test("fromApi: current_value is current, and empId is the employee's id", () => {
  assert.deepEqual(fromApi(ROW), {
    id: "k1", empId: "e1", projectId: "p1", title: "Sprint velocity", target: 40, current: 42.5, weight: 25,
    period: "Q1 2026", status: "active", rating: 8, ratedBy: "m1", ratedAt: "2026-03-31T10:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-03-31T10:00:00.000Z",
  });
});

test("fromApi: an unrated KPI has rating null and empty ratedBy / ratedAt", () => {
  const record = fromApi({ ...ROW, rating: null, rated_by_employee_id: null, rated_at: null });
  assert.equal(record.rating, null);
  assert.equal(record.ratedBy, "");
  assert.equal(record.ratedAt, "");
});

test("fromApi: a legacy KPI with no project has an empty projectId", () => {
  assert.equal(fromApi({ ...ROW, project_id: null }).projectId, "");
});

test("fromApi: numbers stay numbers", () => {
  const record = fromApi(ROW);
  assert.equal(typeof record.target, "number");
  assert.equal(typeof record.current, "number");
});

test("toApiCreate renames every field, sends both foreign keys, and drops what the server owns", () => {
  const body = toApiCreate({
    id: 99, empId: "e1", projectId: "p1", title: " T ", target: "100", current: "5", weight: 30, period: "Q2",
    status: "active", rating: 9, ratedBy: "x", ratedAt: "t", createdAt: "t", updatedAt: "t",
  });

  assert.deepEqual(body, {
    project_id: "p1", employee_id: "e1", title: "T", target: 100, current_value: 5, weight: 30, period: "Q2", status: "active",
  });
});

test("toApiUpdate never sends the employee or the project (frozen, D29) or the rating", () => {
  const body = toApiUpdate({ empId: "other", projectId: "other", rating: 3, ratedBy: "x", current: 10 });
  assert.deepEqual(body, { current_value: 10 });
});

test("a read followed by a write of the unchanged record sends nothing", () => {
  const original = fromApi(ROW);
  assert.deepEqual(toApiUpdate({ ...original }, { original }), {});
});

test("toApiUpdate with the original sends only the progress that changed", () => {
  const original = fromApi(ROW);
  assert.deepEqual(toApiUpdate({ ...original, current: 50 }, { original }), { current_value: 50 });
});

test("toApiRating accepts whole numbers 1 to 10 and sends { rating }", () => {
  assert.deepEqual(toApiRating(1), { rating: 1 });
  assert.deepEqual(toApiRating("7"), { rating: 7 });
  assert.deepEqual(toApiRating(10), { rating: 10 });
});

test("toApiRating refuses everything else before it reaches the server", () => {
  for (const bad of [0, 11, 5.5, -1, "", "abc", null, undefined, NaN]) {
    assert.throws(() => toApiRating(bad), (error) => error instanceof MappingError && error.code === "invalid-rating", String(bad));
  }
});
