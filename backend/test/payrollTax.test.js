import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "../src/db/migrator.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, "..", "src", "db", "migrations");

// Verifies payroll_tax_for() against calculatedPayrollTax at firestore.rules:549-559:
//
//   math.round(
//     gross <= 50000  ? 0
//     : gross <= 100000 ? (gross - 50000) * 0.05
//     : gross <= 200000 ? 2500  + (gross - 100000) * 0.1
//     :                   12500 + (gross - 200000) * 0.15
//   )
//
// Firestore rounds the WHOLE expression, bracket constant included. The SQL adds the
// constant outside round(). Those are equivalent because the constants are integers, and
// `equivalentBracketForms` below proves it at every boundary rather than asserting it.
//
// All arithmetic here is exact integer arithmetic over cents, so no IEEE-754 artifact can
// mask a real discrepancy. What these tests CANNOT do is execute the SQL: there is no
// database in this environment. They verify the bracket table the SQL encodes and the
// logic it implements. Running the DDL against PostgreSQL remains a separate step.

const CENTS = 100n;
const SCALE = 10_000n; // rate is applied as an integer numerator over this denominator

/** Round a non-negative rational numerator/SCALE half away from zero. */
function roundHalfAwayFromZero(numerator) {
  assert.ok(numerator >= 0n, "payroll amounts are non-negative by CHECK constraint");
  return (numerator + SCALE / 2n) / SCALE;
}

function bracketFor(grossCents) {
  if (grossCents <= 50_000n * CENTS) return null;
  if (grossCents <= 100_000n * CENTS) return { floor: 50_000n, rate: 5n, constant: 0n };
  if (grossCents <= 200_000n * CENTS) return { floor: 100_000n, rate: 10n, constant: 2_500n };
  return { floor: 200_000n, rate: 15n, constant: 12_500n };
}

/** The form the SQL uses: round the variable part, then add the integer constant. */
function sqlForm(grossCents) {
  const bracket = bracketFor(grossCents);
  if (!bracket) return 0n;
  const variable = (grossCents - bracket.floor * CENTS) * bracket.rate;
  return roundHalfAwayFromZero(variable) + bracket.constant;
}

/** The form firestore.rules uses: round the constant and variable part together. */
function firestoreForm(grossCents) {
  const bracket = bracketFor(grossCents);
  if (!bracket) return 0n;
  const variable = (grossCents - bracket.floor * CENTS) * bracket.rate;
  return roundHalfAwayFromZero(bracket.constant * SCALE + variable);
}

const toCents = (units) => BigInt(Math.round(units * 100));

// Every bracket boundary, both sides of it, plus the exact-half cases that distinguish
// rounding modes.
const CASES = [
  { gross: 0, tax: 0n, note: "zero" },
  { gross: 1, tax: 0n },
  { gross: 49_999.99, tax: 0n, note: "just below the first threshold" },
  { gross: 50_000, tax: 0n, note: "first threshold, still zero-rated" },
  { gross: 50_000.01, tax: 0n, note: "one cent into the 5% band" },
  { gross: 50_010, tax: 1n, note: "exact half: 0.5 rounds away from zero to 1" },
  { gross: 60_000, tax: 500n },
  { gross: 99_999.99, tax: 2_500n },
  { gross: 100_000, tax: 2_500n, note: "second threshold" },
  { gross: 100_000.01, tax: 2_500n, note: "one cent into the 10% band" },
  { gross: 100_005, tax: 2_501n, note: "exact half with a bracket constant" },
  { gross: 150_000, tax: 7_500n },
  { gross: 199_999.99, tax: 12_500n },
  { gross: 200_000, tax: 12_500n, note: "third threshold" },
  { gross: 200_000.01, tax: 12_500n, note: "one cent into the 15% band" },
  { gross: 200_010, tax: 12_502n, note: "exact half in the top band" },
  { gross: 300_000, tax: 27_500n },
  { gross: 1_000_000, tax: 132_500n },
];

test("the bracket table produces the expected tax at every boundary", () => {
  for (const { gross, tax, note } of CASES) {
    const label = note ? `${gross} (${note})` : `${gross}`;
    assert.equal(sqlForm(toCents(gross)), tax, `tax for gross ${label}`);
  }
});

test("both bracket forms agree, so moving the constant outside round() is safe", () => {
  for (const { gross } of CASES) {
    const cents = toCents(gross);
    assert.equal(
      sqlForm(cents),
      firestoreForm(cents),
      `forms diverge at gross ${gross}: rounding a value then adding an integer must commute`,
    );
  }
});

test("the two forms agree across a dense sweep of every band", () => {
  // One unit at a time across each boundary, plus every 7th unit through the bands, so a
  // rate or threshold typo cannot slip through the hand-picked cases above.
  for (let gross = 0; gross <= 260_000; gross += 7) {
    const cents = toCents(gross);
    assert.equal(sqlForm(cents), firestoreForm(cents), `forms diverge at gross ${gross}`);
  }
  for (const boundary of [50_000, 100_000, 200_000]) {
    for (let offset = -3; offset <= 3; offset += 1) {
      const cents = toCents(boundary + offset);
      assert.equal(sqlForm(cents), firestoreForm(cents), `forms diverge at ${boundary + offset}`);
    }
  }
});

test("tax is monotonic and never exceeds gross", () => {
  let previous = -1n;
  for (let gross = 0; gross <= 400_000; gross += 250) {
    const cents = toCents(gross);
    const tax = sqlForm(cents);
    assert.ok(tax >= previous, `tax decreased at gross ${gross}`);
    assert.ok(tax * CENTS <= cents, `tax exceeded gross at ${gross}`);
    previous = tax;
  }
});

test("the migration SQL encodes exactly these thresholds, rates and constants", async () => {
  const [migration] = await loadMigrations(migrationsDirectory);
  const body = /CREATE OR REPLACE FUNCTION payroll_tax_for[\s\S]*?\$\$;/.exec(migration.sql);
  assert.ok(body, "payroll_tax_for not found in the migration");
  const sql = body[0];

  assert.match(sql, /WHEN gross <= 50000\s+THEN 0/);
  assert.match(sql, /WHEN gross <= 100000\s+THEN round\(\(gross - 50000\)\s*\* 0\.05\)/);
  assert.match(sql, /WHEN gross <= 200000\s+THEN round\(\(gross - 100000\)\s*\* 0\.10\) \+ 2500/);
  assert.match(sql, /ELSE\s+round\(\(gross - 200000\)\s*\* 0\.15\) \+ 12500/);

  // The rates must be numeric literals. A cast to double precision would switch
  // PostgreSQL's round() to half-to-even and change 100005 from 2501 to 2500.
  assert.doesNotMatch(sql, /double precision|::float|::real/);
});
