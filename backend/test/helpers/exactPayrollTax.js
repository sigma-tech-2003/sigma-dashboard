import assert from "node:assert/strict";

// The exact-integer transcription of payroll_tax_for() (migration 001) and of firestore.rules'
// calculatedPayrollTax, shared by:
//   - payrollTax.test.js, which ties this transcription to the migration's SQL text, and
//   - payrollTaxClientParity.test.js, which compares the frontend's calcTax with it (D38).
// Between them: client <-> this transcription <-> the SQL. It lives in one place so there is one
// transcription to keep right, not two.
//
// All arithmetic is exact integer arithmetic over cents, so no IEEE-754 artifact can mask a real
// discrepancy.

export const CENTS = 100n;
export const SCALE = 10_000n; // rate is applied as an integer numerator over this denominator

/** Round a non-negative rational numerator/SCALE half away from zero. */
export function roundHalfAwayFromZero(numerator) {
  assert.ok(numerator >= 0n, "payroll amounts are non-negative by CHECK constraint");
  return (numerator + SCALE / 2n) / SCALE;
}

export function bracketFor(grossCents) {
  if (grossCents <= 50_000n * CENTS) return null;
  if (grossCents <= 100_000n * CENTS) return { floor: 50_000n, rate: 5n, constant: 0n };
  if (grossCents <= 200_000n * CENTS) return { floor: 100_000n, rate: 10n, constant: 2_500n };
  return { floor: 200_000n, rate: 15n, constant: 12_500n };
}

/** The form the SQL uses: round the variable part, then add the integer constant. */
export function sqlForm(grossCents) {
  const bracket = bracketFor(grossCents);
  if (!bracket) return 0n;
  const variable = (grossCents - bracket.floor * CENTS) * bracket.rate;
  return roundHalfAwayFromZero(variable) + bracket.constant;
}

/** The form firestore.rules uses: round the constant and variable part together. */
export function firestoreForm(grossCents) {
  const bracket = bracketFor(grossCents);
  if (!bracket) return 0n;
  const variable = (grossCents - bracket.floor * CENTS) * bracket.rate;
  return roundHalfAwayFromZero(bracket.constant * SCALE + variable);
}

export const toCents = (units) => BigInt(Math.round(units * 100));
