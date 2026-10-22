import assert from "node:assert/strict";
import test from "node:test";
import { payrollTrend } from "./payrollTrend.js";

const now = new Date(2027, 0, 15); // January 2027

test("the window is the last six calendar months ending with the current one, oldest first", () => {
  const { data } = payrollTrend([], now);
  assert.deepEqual(data.map((d) => d.m), ["Aug", "Sep", "Oct", "Nov", "Dec", "Jan"]);
});

test("processed records are summed into their own month, across the year boundary", () => {
  const { data, hasData } = payrollTrend([
    { month: "January", year: 2027, net: 78595, status: "processed" },
    { month: "January", year: 2027, net: 100, status: "processed" },
    { month: "November", year: 2026, net: 78500, status: "processed" },
    { month: "October", year: 2026, net: 82250, status: "processed" },
  ], now);
  assert.equal(hasData, true);
  assert.equal(data.find((d) => d.m === "Jan").total, 78695);
  assert.equal(data.find((d) => d.m === "Nov").total, 78500);
  assert.equal(data.find((d) => d.m === "Oct").total, 82250);
  assert.equal(data.find((d) => d.m === "Dec").total, 0);
});

test("drafts, other years and months outside the window are left out", () => {
  const { data, hasData } = payrollTrend([
    { month: "January", year: 2027, net: 5, status: "draft" },
    { month: "January", year: 2026, net: 5, status: "processed" },
    { month: "March", year: 2025, net: 5, status: "processed" },
  ], now);
  assert.equal(hasData, false);
  assert.ok(data.every((d) => d.total === 0));
});

test("bad records and a missing list never throw", () => {
  assert.equal(payrollTrend(undefined, now).hasData, false);
  assert.equal(payrollTrend([null, { month: "Smarch", year: 2027, net: 1, status: "processed" }, { month: "January", year: "x", net: 1, status: "processed" }], now).hasData, false);
});
