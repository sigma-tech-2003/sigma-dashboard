import assert from "node:assert/strict";
import test from "node:test";
import { formatCountable, parseCountable, pickAboveFold } from "./motionMath.js";

test("figures with text around them are counted and the text is kept", () => {
  assert.deepEqual(parseCountable("PKR 239,345"), { prefix: "PKR ", target: 239345, decimals: 0, grouped: true, suffix: "" });
  assert.deepEqual(parseCountable("7.5/10"), { prefix: "", target: 7.5, decimals: 1, grouped: false, suffix: "/10" });
  assert.deepEqual(parseCountable("50%"), { prefix: "", target: 50, decimals: 0, grouped: false, suffix: "%" });
  assert.deepEqual(parseCountable("0/9"), { prefix: "", target: 0, decimals: 0, grouped: false, suffix: "/9" });
  assert.deepEqual(parseCountable(9), { prefix: "", target: 9, decimals: 0, grouped: false, suffix: "" });
  assert.equal(parseCountable(2.5).decimals, 1);
});

test("words, dashes and bad input have nothing to count", () => {
  for (const value of ["Not rated", "—", "No data", "", null, undefined, {}, NaN, Infinity]) {
    assert.equal(parseCountable(value), null, String(value));
  }
});

test("at the end of the count the text is exactly what was passed in, for every shape of figure", () => {
  for (const text of ["PKR 239,345", "PKR 5,100", "9", "7.5/10", "50%", "0/9", "PKR 1,234,567", "12.25%", "PKR 0"]) {
    assert.equal(formatCountable(parseCountable(text), 1), text, text);
  }
});

test("the count starts at zero, rises, and never overshoots", () => {
  const parsed = parseCountable("PKR 239,345");
  assert.equal(formatCountable(parsed, 0), "PKR 0");
  const mid = formatCountable(parsed, 0.5);
  assert.equal(mid, "PKR 119,673");
  assert.equal(formatCountable(parsed, 5), "PKR 239,345");
  assert.equal(formatCountable(parsed, -1), "PKR 0");
});

test("decimals keep their width while counting", () => {
  assert.equal(formatCountable(parseCountable("7.5/10"), 0), "0.0/10");
  assert.equal(formatCountable(parseCountable("7.5/10"), 0.4), "3.0/10");
});

test("only boxes that start on screen get an entrance, in order, up to the cap", () => {
  assert.deepEqual(pickAboveFold([0, 120, 400, 900, 1500], 800, 14), [0, 1, 2]);
  assert.deepEqual(pickAboveFold([0, 50, 100, 150], 800, 2), [0, 1]);
  assert.deepEqual(pickAboveFold([], 800, 14), []);
  assert.deepEqual(pickAboveFold([900, 1000], 800, 14), []);
});
