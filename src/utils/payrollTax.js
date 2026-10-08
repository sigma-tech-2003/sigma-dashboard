// The progressive payroll tax, as a pure function (D38): no imports, no UI, no I/O, so a plain Node
// test can load it. It is the formula the payroll page uses for its tax and net PREVIEW; the figures
// that are stored come from the database (payroll_tax_for(), via generated columns, D7 and D28), never
// from this.
//
// It is the same expression as `calcTax` in ./helpers.js, which still exists because the payroll page
// still imports it from there. Phase 10 re-points that import here and deletes the copy; until then
// backend/test/payrollTaxClientParity.test.js checks that the two copies are textually identical, and
// that this one agrees with the database function's exact arithmetic across the range.
//
// Brackets: nothing up to 50,000; 5% of the excess to 100,000; 2,500 plus 10% of the excess over 100,000
// to 200,000; 12,500 plus 15% of the excess over 200,000 beyond that.
export const calcTax = (gross) =>
  gross <= 50000
    ? 0
    : gross <= 100000
      ? (gross - 50000) * 0.05
      : gross <= 200000
        ? 2500 + (gross - 100000) * 0.1
        : 12500 + (gross - 200000) * 0.15;

/** The whole-currency tax the database would compute for this gross: calcTax, rounded half up. */
export const payrollTax = (gross) => Math.round(calcTax(gross));
