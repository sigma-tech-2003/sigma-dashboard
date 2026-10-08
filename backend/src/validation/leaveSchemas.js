import { z } from "zod";
import { uuidSchema } from "./commonSchemas.js";
import { LEAVE_TYPES } from "../utils/leaveTypes.js";

// z.iso.date() also rejects impossible calendar dates (2026-02-30), which a bare regex would not.
const dateSchema = z.iso.date();

// .strict() rejects any key not listed -- including employee_id (the applicant is ALWAYS the acting
// principal, never client-supplied), days (a generated column), status, applied_on and every
// decision field (all server-owned). Backdating is allowed and nothing limits how long a request may be
// or how many may be made (D40: no entitlements, no limits), so the only date rule is ordering.
export const leaveApplySchema = z.object({
  type: z.enum(LEAVE_TYPES),
  start_date: dateSchema,
  end_date: dateSchema,
  reason: z.string().trim().min(1).max(2000),
}).strict()
  .refine((leave) => leave.end_date >= leave.start_date, {
    message: "end_date must be on or after start_date.", path: ["end_date"],
  });

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
