import assert from "node:assert/strict";
import test from "node:test";
import { axisTick, chartCursor, shortLabel, tooltipStyle } from "./chartTheme.js";

test("shortLabel leaves short names alone and ends a long one with a real ellipsis", () => {
  assert.equal(shortLabel("Sales"), "Sales");
  assert.equal(shortLabel("Administration"), "Administr\u2026");
  assert.equal(shortLabel("Administration", 6), "Admin\u2026");
  assert.equal(shortLabel(undefined), "");
});

test("chart styling is read from the theme tokens, never hard-coded, so it follows dark and light", () => {
  for (const value of [tooltipStyle.background, tooltipStyle.border, tooltipStyle.color, axisTick.fill, chartCursor.fill, chartCursor.stroke]) {
    assert.match(value, /var\(--color-/);
    assert.doesNotMatch(value, /#[0-9a-f]{3,8}/i);
  }
});

test("axis text is at least 12px", () => {
  assert.ok(axisTick.fontSize >= 12);
  assert.ok(tooltipStyle.fontSize >= 12);
});
