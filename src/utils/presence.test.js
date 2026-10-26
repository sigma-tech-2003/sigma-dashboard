import assert from "node:assert/strict";
import test from "node:test";
import { mergePresence, removeEntry } from "./presence.js";

const key = (item) => item.id;
const a = { id: "a", n: 1 };
const b = { id: "b", n: 1 };
const c = { id: "c", n: 1 };

test("a first list is every item, none leaving", () => {
  assert.deepEqual(mergePresence([], [a, b], key).map((e) => [e.key, e.exiting]), [["a", false], ["b", false]]);
});

test("an item that disappears stays in its place, marked as leaving, until it is removed", () => {
  const first = mergePresence([], [a, b, c], key);
  const second = mergePresence(first, [a, c], key);
  assert.deepEqual(second.map((e) => [e.key, e.exiting]), [["a", false], ["b", true], ["c", false]]);
  assert.deepEqual(removeEntry(second, "b").map((e) => e.key), ["a", "c"]);
});

test("an item that is already leaving is not marked again, and stays when other things change", () => {
  const first = mergePresence([], [a, b], key);
  const second = mergePresence(first, [a], key);
  const third = mergePresence(second, [a], key);
  assert.equal(third[1].exiting, true);
  assert.equal(third[1].item, b);
});

test("an item that comes back before it has gone is no longer leaving", () => {
  const first = mergePresence([], [a, b], key);
  const second = mergePresence(first, [a], key);
  const third = mergePresence(second, [a, b], key);
  assert.deepEqual(third.map((e) => [e.key, e.exiting]), [["a", false], ["b", false]]);
});

test("new items are added after the ones already shown, and current data replaces the old copy", () => {
  const first = mergePresence([], [a], key);
  const newer = { id: "a", n: 2 };
  const second = mergePresence(first, [newer, b], key);
  assert.deepEqual(second.map((e) => e.key), ["a", "b"]);
  assert.equal(second[0].item.n, 2);
});

test("removing a key that is not there changes nothing", () => {
  const list = mergePresence([], [a], key);
  assert.deepEqual(removeEntry(list, "zzz"), list);
});
