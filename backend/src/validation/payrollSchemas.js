import { z } from "zod";
import { uuidSchema } from "./commonSchemas.js";

// payroll_status enum (001_initial_core_hr_hierarchy.up.sql). 'draft' is reachable here (D28,
// resolving A5); 'processed' is the default so today's behaviour is unchanged.
const payrollStatusSchema = z.enum(["draft", "processed"]);

// period_month is an integer 1-12 on the wire (D28); Firestore's English month names are an ETL
// concern only. The same bounds are database CHECKs (payroll_year_range / payroll_month_range).
const periodYearSchema = z.number().int().min(1).max(9999);
const periodMonthSchema = z.number().int().min(1).max(12);

// numeric(12,2): at most 10 integer digits and 2 decimals. Anything finer would be silently
// rounded by the column and anything larger would overflow it, so both are refused with a 400.
// The decimal-place check is done on the number's own string form, not by multiplying by 100:
// near 1e10 a double's spacing exceeds any usable tolerance, so `value * 100` cannot tell 0.30
// from 0.30000000000000004. A value that stringifies with an exponent (1e-7) fails the pattern
// and is rejected too.
const MAX_AMOUNT = 9999999999.99;
const TWO_DECIMALS = /^\d+(\.\d{1,2})?$/;
const amountSchema = z.number()
  .finite()
  .min(0)
  .max(MAX_AMOUNT)
  .refine((value) => TWO_DECIMALS.test(String(value)), { message: "must have at most two decimal places" });

// .strict() rejects any key not listed -- including gross, tax and net (generated columns, never
// accepted from a client), id, created_at, updated_at, deleted_at and deleted_by_employee_id.
// Amounts are not nullable: the columns are NOT NULL.
export const payrollCreateSchema = z.object({
  employee_id: uuidSchema,
  period_year: periodYearSchema,
  period_month: periodMonthSchema,
  // Optional: payrollMutationService defaults them to the employee's current values (D28).
  basic: amountSchema.optional(),
  allowances: amountSchema.optional(),
  bonus: amountSchema.optional().default(0),
  deductions: amountSchema.optional().default(0),
  status: payrollStatusSchema.optional().default("processed"),
}).strict();

export const payrollUpdateSchema = z.object({
  employee_id: uuidSchema.optional(),
  period_year: periodYearSchema.optional(),
  period_month: periodMonthSchema.optional(),
  basic: amountSchema.optional(),
  allowances: amountSchema.optional(),
  bonus: amountSchema.optional(),
  deductions: amountSchema.optional(),
  status: payrollStatusSchema.optional(),
}).strict()
  .refine((changes) => Object.keys(changes).length > 0, { message: "At least one field must be provided." });
