import { z } from "zod";
import { userRoleSchema, uuidSchema } from "./commonSchemas.js";

// employees.employment_status enum (001_initial_core_hr_hierarchy.up.sql). Never part of
// employeeCreateSchema -- a new hire always starts 'active' (the column default); only
// update can transition it.
const employmentStatusSchema = z.enum(["active", "inactive", "on_leave", "terminated"]);

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO calendar date (YYYY-MM-DD)");
const nonNegativeAmount = z.number().nonnegative();

// .strict() rejects any key not listed below -- this is what subsumes the old Firestore
// field denylists (password, uid, empId, createdAt, claims, customClaims, isAdmin, ...):
// none of those are in the allowlist, so a strict schema refuses the whole request rather
// than silently dropping them or, worse, silently accepting them.

export const employeeCreateSchema = z.object({
  email: z.string().trim().min(1).max(254).email(),
  role: userRoleSchema,
  full_name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).nullable().optional(),
  // Optional: a manager/tl creating within their own scope gets this defaulted by
  // employeeMutationService.js; admin/hr must supply it explicitly.
  department_id: uuidSchema.optional(),
  position_title: z.string().trim().min(1).max(160),
  joined_on: dateStringSchema,
  basic: nonNegativeAmount,
  allowances: nonNegativeAmount,
  team_lead_id: uuidSchema.nullable().optional(),
}).strict();

export const employeeUpdateSchema = z.object({
  email: z.string().trim().min(1).max(254).email().optional(),
  role: userRoleSchema.optional(),
  full_name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  department_id: uuidSchema.optional(),
  position_title: z.string().trim().min(1).max(160).optional(),
  employment_status: employmentStatusSchema.optional(),
  joined_on: dateStringSchema.optional(),
  basic: nonNegativeAmount.optional(),
  allowances: nonNegativeAmount.optional(),
  team_lead_id: uuidSchema.nullable().optional(),
}).strict()
  .refine((changes) => Object.keys(changes).length > 0, { message: "At least one field must be provided." });

export const employeeDeleteSchema = z.object({
  replacement_team_lead_id: uuidSchema.nullable().optional(),
}).strict();
