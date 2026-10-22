import assert from "node:assert/strict";
import test from "node:test";
import { nextFocusIndex, shouldCloseOnBackdrop } from "./modalBehavior.js";

test("a clean dialog closes when the backdrop is clicked", () => {
  assert.equal(shouldCloseOnBackdrop({ pressStartedOnBackdrop: true, dirty: false }), true);
});

test("once the person has typed into the dialog, the backdrop no longer closes it", () => {
  assert.equal(shouldCloseOnBackdrop({ pressStartedOnBackdrop: true, dirty: true }), false);
});

test("selecting text inside the dialog and releasing on the backdrop does not close it", () => {
  assert.equal(shouldCloseOnBackdrop({ pressStartedOnBackdrop: false, dirty: false }), false);
});

test("Tab wraps from the last control to the first, and Shift+Tab from the first to the last", () => {
  assert.equal(nextFocusIndex({ count: 4, current: 3, shift: false }), 0);
  assert.equal(nextFocusIndex({ count: 4, current: 0, shift: true }), 3);
  assert.equal(nextFocusIndex({ count: 4, current: -1, shift: true }), 3, "focus on the dialog itself counts as before the first control");
});

test("Tab in the middle of the dialog is left to the browser", () => {
  assert.equal(nextFocusIndex({ count: 4, current: 1, shift: false }), null);
  assert.equal(nextFocusIndex({ count: 4, current: 2, shift: true }), null);
});

test("a dialog with nothing focusable has nowhere to wrap to", () => {
  assert.equal(nextFocusIndex({ count: 0, current: -1, shift: false }), null);
});
