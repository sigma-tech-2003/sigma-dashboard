import { z } from "zod";
import { uuidSchema } from "./commonSchemas.js";
import { LEAVE_TYPES, MAX_LEAVE_DAYS, daysBetweenInclusive } from "../services/leaveEntitlements.js";

// z.iso.date() also rejects impossible calendar dates (2026-02-30), which a bare regex would not.
const dateSchema = z.iso.date();

// .strict() rejects any key not listed -- including employee_id (the applicant is ALWAYS the acting
// principal, never client-supplied), days (a generated column), status, applied_on and every
// decision field (all server-owned). Backdating is allowed and no future limit applies (D31), so the
// only date rules are ordering and a sanity bound.
export const leaveApplySchema = z.object({
  type: z.enum(LEAVE_TYPES),
  start_date: dateSchema,
  end_date: dateSchema,
  reason: z.string().trim().min(1).max(2000),
}).strict()
  .refine((leave) => leave.end_date >= leave.start_date, {
    message: "end_date must be on or after start_date.", path: ["end_date"],
  })
  // Not a management rule (D31 sets none): a defensive bound, so an absurd range cannot make the usage
  // view generate millions of rows. A year-long Maternity request fits.
  .refine(
    (leave) => leave.end_date < leave.start_date || daysBetweenInclusive(leave.start_date, leave.end_date) <= MAX_LEAVE_DAYS,
    { message: `A leave request cannot span more than ${MAX_LEAVE_DAYS} days.`, path: ["end_date"] },
  );

// A decision is `{ status }` and nothing else: there is no edit (cancel and re-apply instead) and no
// way to put a request back to pending.
export const leaveDecisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
}).strict();

// GET /leave-balances?employee_id=&as_of=
export const leaveBalanceQuerySchema = z.object({
  employee_id: uuidSchema.optional(),
  as_of: dateSchema.optional(),
}).strict();
