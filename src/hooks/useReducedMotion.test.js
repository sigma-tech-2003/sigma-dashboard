import assert from "node:assert/strict";
import test from "node:test";
import { prefersReducedMotion } from "./useReducedMotion.js";

test("reduced motion is read from the system preference", () => {
  assert.equal(prefersReducedMotion(() => ({ matches: true })), true);
  assert.equal(prefersReducedMotion(() => ({ matches: false })), false);
});

test("without matchMedia (a test runner, an old browser) motion is allowed rather than throwing", () => {
  assert.equal(prefersReducedMotion(undefined), false);
  assert.equal(prefersReducedMotion(() => undefined), false);
});

test("the query asked for is prefers-reduced-motion: reduce", () => {
  let asked = "";
  prefersReducedMotion((query) => { asked = query; return { matches: false }; });
  assert.equal(asked, "(prefers-reduced-motion: reduce)");
});
