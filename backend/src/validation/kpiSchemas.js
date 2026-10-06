import { z } from "zod";
import { uuidSchema } from "./commonSchemas.js";

// kpi_status enum has exactly one value (A1, carried forward unresolved).
const kpiStatusSchema = z.enum(["active"]);

// numeric(14,2): at most 12 integer digits and 2 decimals. Anything finer would be silently
// rounded by the column and anything larger would overflow it, so both are refused with a 400.
// The decimal-place check is done on the number's own string form, not by multiplying by 100 --
// the same reasoning as payrollSchemas.js: near the top of the range a double's spacing exceeds
// any usable tolerance. A value that stringifies with an exponent (1e-7) fails the pattern.
const MAX_AMOUNT = 999999999999.99;
const TWO_DECIMALS = /^\d+(\.\d{1,2})?$/;
const amount = () => z.number()
  .finite()
  .max(MAX_AMOUNT)
  .refine((value) => TWO_DECIMALS.test(String(value)), { message: "must have at most two decimal places" });

const titleSchema = z.string().trim().min(1).max(200);
const periodSchema = z.string().trim().min(1).max(40);
const weightSchema = z.number().int().min(1).max(100);

// .strict() rejects any key not listed -- including id, rating, rated_by_employee_id, rated_at,
// created_at, updated_at, deleted_at and deleted_by_employee_id. Names follow the database, so the
// KPI's progress is current_value (Firestore's `current`).
export const kpiCreateSchema = z.object({
  project_id: uuidSchema,
  employee_id: uuidSchema,
  title: titleSchema,
  target: amount().gt(0),
  current_value: amount().min(0).optional().default(0),
  weight: weightSchema,
  period: periodSchema,
  status: kpiStatusSchema.optional().default("active"),
}).strict();

// employee_id and project_id are deliberately NOT here (frozen, D29): .strict() rejects them, as
// kpiMutationService.js always did. A correction is delete and re-create, because a rating belongs
// to one employee on one project. The rating has its own operation, kpiRatingSchema.
export const kpiUpdateSchema = z.object({
  title: titleSchema.optional(),
  target: amount().gt(0).optional(),
  current_value: amount().min(0).optional(),
  weight: weightSchema.optional(),
  period: periodSchema.optional(),
  status: kpiStatusSchema.optional(),
}).strict()
  .refine((changes) => Object.keys(changes).length > 0, { message: "At least one field must be provided." });

// The body of POST /kpis/:id/rating: the rating alone. Who rated and when are the server's.
export const kpiRatingSchema = z.object({
  rating: z.number().int().min(1).max(10),
}).strict();
