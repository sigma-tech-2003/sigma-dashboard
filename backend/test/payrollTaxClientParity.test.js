import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { calcTax, payrollTax } from "../../src/utils/payrollTax.js";
import { sqlForm, toCents } from "./helpers/exactPayrollTax.js";

// D38: the payroll page keeps a client-side preview of tax, and the database computes the stored figure
// (payroll_tax_for(), via generated columns). This is what stops the two drifting apart unnoticed.
//
// The chain of evidence is: the CLIENT module (src/utils/payrollTax.js) is compared here with an
// exact-integer transcription of the SQL (test/helpers/exactPayrollTax.js), and payrollTax.test.js ties
// that transcription to the real migration text. So a change to the SQL's brackets, or to the client's,
// fails a test until they agree again.
//
// The module under test is in the FRONTEND tree. It is imported across the package boundary because the
// frontend has no test runner, and because it is pure (no imports at all) so it loads in plain Node.
//
// Not covered here, because it would take minutes inside `npm test`: an ad hoc run (2026-10-09) compared
// every single cent from 0.00 to 400,000.00 -- 40 million values -- and 2 million random float sums, with
// no mismatch. The sweeps below are sampled for speed but include the regions that matter.

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(directory, "..", "..", "src", "utils");

const BOUNDARIES = [50_000, 100_000, 200_000];

/** The client's tax for a gross given in cents, through the float path the page takes (cents / 100). */
const clientTaxForCents = (cents) => payrollTax(cents / 100);

test("the client's tax equals the database's at every cent within 25.00 either side of each bracket boundary", () => {
  for (const boundary of BOUNDARIES) {
    const centre = boundary * 100;
    for (let cents = centre - 2500; cents <= centre + 2500; cents += 1) {
      assert.equal(BigInt(clientTaxForCents(cents)), sqlForm(BigInt(cents)), `gross ${cents / 100}`);
    }
  }
});

test("the client's tax equals the database's at the exact-half cases that distinguish rounding modes", () => {
  // 0.5 must round UP (away from zero) in all three bands, with and without a bracket constant.
  for (const [gross, expected] of [[50_010, 1n], [100_005, 2_501n], [200_010, 12_502n]]) {
    assert.equal(BigInt(payrollTax(gross)), expected, `client at ${gross}`);
    assert.equal(sqlForm(toCents(gross)), expected, `database at ${gross}`);
  }
});

test("the client's tax equals the database's across a dense sweep of 0 to 1,000,000 (every 0.97)", () => {
  for (let cents = 0; cents <= 100_000_000; cents += 97) {
    assert.equal(BigInt(clientTaxForCents(cents)), sqlForm(BigInt(cents)), `gross ${cents / 100}`);
  }
});

test("... and across a coarser sweep out to 5,000,000, beyond anything D38's earlier check covered", () => {
  for (let cents = 0; cents <= 500_000_000; cents += 9_973) {
    assert.equal(BigInt(clientTaxForCents(cents)), sqlForm(BigInt(cents)), `gross ${cents / 100}`);
  }
});

test("the client's tax equals the database's for gross computed the way the page computes it: basic + allowances + bonus as floats", () => {
  // Deterministic pseudo-random amounts in cents, summed as floating-point numbers like the page does,
  // against the exact sum in integer cents the database sees (numeric(12,2)).
  let seed = 20_261_009;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 200_000; i += 1) {
    const basic = Math.floor(next() * 25_000_000);
    const allowances = Math.floor(next() * 5_000_000);
    const bonus = Math.floor(next() * 2_000_000);
    const floatGross = basic / 100 + allowances / 100 + bonus / 100;

    assert.equal(
      BigInt(payrollTax(floatGross)), sqlForm(BigInt(basic + allowances + bonus)),
      `basic ${basic / 100} + allowances ${allowances / 100} + bonus ${bonus / 100}`,
    );
  }
});

test("the client's tax is a whole number, non-negative, never above gross, and never decreases as gross rises", () => {
  let previous = -1;
  for (let gross = 0; gross <= 2_000_000; gross += 251) {
    const tax = payrollTax(gross);
    assert.ok(Number.isInteger(tax), `tax at ${gross} is whole`);
    assert.ok(tax >= 0 && tax <= gross, `tax at ${gross} is within [0, gross]`);
    assert.ok(tax >= previous, `tax decreased at ${gross}`);
    previous = tax;
  }
});

test("calcTax is the unrounded formula and payrollTax rounds it half up", () => {
  assert.equal(calcTax(50_000), 0);
  assert.equal(calcTax(60_000), 500);
  assert.equal(calcTax(100_005), 2_500.5);
  assert.equal(payrollTax(100_005), 2_501);
});

test("the module is pure: it imports nothing, so a plain Node process (and a test) can load it", async () => {
  const source = await readFile(path.join(sourceRoot, "payrollTax.js"), "utf8");
  const code = source.replace(/\/\/.*$/gm, "");

  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /\brequire\(|\bfetch\(|\bwindow\b|\bdocument\b/);
});

test("while helpers.js keeps its own calcTax for the page, the two copies are the same expression", async () => {
  // Phase 10 re-points the page at payrollTax.js and deletes the copy in helpers.js. Until then there are
  // two, and this is what stops them drifting while the frontend is not being touched.
  const normalised = (text) => text.replace(/\/\/.*$/gm, "").replace(/\s+/g, "");
  const pull = (source) => /export const calcTax = \(gross\) =>[\s\S]*?;/.exec(source)?.[0];

  const helpers = pull(await readFile(path.join(sourceRoot, "helpers.js"), "utf8"));
  const extracted = pull(await readFile(path.join(sourceRoot, "payrollTax.js"), "utf8"));

  assert.ok(helpers, "calcTax found in helpers.js");
  assert.ok(extracted, "calcTax found in payrollTax.js");
  assert.equal(normalised(extracted), normalised(helpers));
});
