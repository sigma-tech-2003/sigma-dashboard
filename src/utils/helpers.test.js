import assert from "node:assert/strict";
import test from "node:test";
import { AVATAR_PALETTE, aColor, initials } from "./helpers.js";

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test("every avatar colour carries white initials at 4.5:1 or better", () => {
  for (const colour of AVATAR_PALETTE) {
    const ratio = 1.05 / (luminance(colour) + 0.05);
    assert.ok(ratio >= 4.5, `${colour} is ${ratio.toFixed(2)}:1 against white`);
  }
});

test("aColor works for the UUID ids the API returns, and a person keeps one colour", () => {
  const id = "5f0c7a3e-9d41-4b7e-8a52-3b1c2d4e6f70";
  assert.ok(AVATAR_PALETTE.includes(aColor(id)), "a UUID maps into the palette (it used to be undefined, so the avatar had no fill)");
  assert.equal(aColor(id), aColor(id));
});

test("aColor always returns a palette colour, whatever the id looks like", () => {
  for (const id of [1, 2, 99, "", undefined, null, "a", "emp-001"]) {
    assert.ok(AVATAR_PALETTE.includes(aColor(id)), `id ${String(id)}`);
  }
});

test("different people spread across the palette instead of all landing on one colour", () => {
  const colours = new Set(Array.from({ length: 40 }, (_, i) => aColor(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)));
  assert.ok(colours.size >= 5, `${colours.size} distinct colours across 40 ids`);
});

test("initials are the first letters of the first two words, upper case", () => {
  assert.equal(initials("Sara Ali"), "SA");
  assert.equal(initials("Mary Jane Watson"), "MJ");
  assert.equal(initials(undefined), "??");
});
