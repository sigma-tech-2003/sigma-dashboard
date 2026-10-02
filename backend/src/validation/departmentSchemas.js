import { z } from "zod";
import { uuidSchema } from "./commonSchemas.js";

// departments.status is typed account_status in the schema (active/inactive/invited/
// suspended) -- the same enum type users.status uses, reused rather than given a dedicated
// type. 'invited' and 'suspended' have never had a defined meaning for a department (the
// Firestore source only ever had Active/Inactive), so the schema narrows to the two values
// that are actually meaningful here rather than exposing the full account_status range.
const departmentStatusSchema = z.enum(["active", "inactive"]);

// .strict() rejects any key not listed below, matching employeeSchemas.js's reasoning.
// manager_employee_id is deliberately absent from create: departments_manager_employee_
// foreign_key requires the manager to already work IN this department, which is impossible
// before the department exists -- assigning one is necessarily a follow-up update.
export const departmentCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  status: departmentStatusSchema.optional().default("active"),
}).strict();

export const departmentUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  status: departmentStatusSchema.optional(),
  // D15: may be set to null freely (clearing a manager auto-nulls, no forced
  // reassignment) or to a real employee id, validated against
  // departments_manager_employee_foreign_key by the repository.
  manager_employee_id: uuidSchema.nullable().optional(),
}).strict()
  .refine((changes) => Object.keys(changes).length > 0, { message: "At least one field must be provided." });
