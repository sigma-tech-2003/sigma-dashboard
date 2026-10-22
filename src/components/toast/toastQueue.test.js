import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TOASTS, toastReducer } from "./toastQueue.js";

const toast = (id, message) => ({ id, tone: "success", message, leaving: false });
const add = (state, t) => toastReducer(state, { type: "add", toast: t });

test("toasts are added in order and at most three stay on screen (the oldest goes first)", () => {
  let state = [];
  for (let id = 1; id <= 5; id += 1) state = add(state, toast(id, `message ${id}`));
  assert.equal(state.length, MAX_TOASTS);
  assert.deepEqual(state.map((t) => t.id), [3, 4, 5]);
});

test("the same message again replaces the earlier one instead of stacking", () => {
  let state = add([], toast(1, "Leave approved"));
  state = add(state, toast(2, "Payroll processed"));
  state = add(state, toast(3, "Leave approved"));
  assert.deepEqual(state.map((t) => t.id), [2, 3]);
});

test("leaving marks a toast without removing it, and remove takes it away", () => {
  let state = add([], toast(1, "a"));
  state = add(state, toast(2, "b"));
  state = toastReducer(state, { type: "leave", id: 1 });
  assert.deepEqual(state.map((t) => [t.id, t.leaving]), [[1, true], [2, false]]);
  state = toastReducer(state, { type: "remove", id: 1 });
  assert.deepEqual(state.map((t) => t.id), [2]);
});

test("an unknown action or id changes nothing", () => {
  const state = add([], toast(1, "a"));
  assert.equal(toastReducer(state, { type: "nope" }), state);
  assert.deepEqual(toastReducer(state, { type: "remove", id: 99 }), state);
  assert.deepEqual(toastReducer(state, { type: "leave", id: 99 }), state);
});
