import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DENSITY, DENSITY_STORAGE_KEY, applyDensity, normalizeDensity, readDensity, writeDensity } from "./density.js";

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); }, data };
};

test("comfortable is the default when nothing is stored or the stored value is unrecognised", () => {
  assert.equal(DEFAULT_DENSITY, "comfortable");
  assert.equal(readDensity(memoryStorage()), "comfortable");
  assert.equal(readDensity(memoryStorage({ [DENSITY_STORAGE_KEY]: "huge" })), "comfortable");
  assert.equal(normalizeDensity(undefined), "comfortable");
});

test("the compact choice is remembered across a reload (written, then read back)", () => {
  const storage = memoryStorage();
  writeDensity(storage, "compact");
  assert.equal(storage.data[DENSITY_STORAGE_KEY], "compact");
  assert.equal(readDensity(storage), "compact");
  writeDensity(storage, "comfortable");
  assert.equal(readDensity(storage), "comfortable");
});

test("a bad value is never written, so a corrupted choice cannot stick", () => {
  const storage = memoryStorage();
  writeDensity(storage, "<script>");
  assert.equal(storage.data[DENSITY_STORAGE_KEY], "comfortable");
});

test("blocked storage (private mode) falls back to the default instead of throwing", () => {
  const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.equal(readDensity(blocked), "comfortable");
  assert.doesNotThrow(() => writeDensity(blocked, "compact"));
  assert.equal(readDensity(undefined), "comfortable");
});

test("applyDensity sets data-density on the root element, which tokens.css reads", () => {
  const root = { dataset: {} };
  applyDensity(root, "compact");
  assert.equal(root.dataset.density, "compact");
  applyDensity(root, "nonsense");
  assert.equal(root.dataset.density, "comfortable");
  assert.doesNotThrow(() => applyDensity(null, "compact"));
});
