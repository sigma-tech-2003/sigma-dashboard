import { z } from "zod";
import { uuidSchema } from "./commonSchemas.js";

// project_status enum (001_initial_core_hr_hierarchy.up.sql). Any value may follow any other (D29).
const projectStatusSchema = z.enum(["draft", "active", "completed"]);

// z.iso.date() also rejects impossible calendar dates (2026-02-30), which a bare regex would not.
const dateSchema = z.iso.date();

const titleSchema = z.string().trim().min(1).max(200);
// Text, trimmed, and may be empty -- the legacy callable accepted an empty description.
const descriptionSchema = z.string().trim().max(2000);

// At least one assignee, no duplicates (D29). "At least one" has no database constraint, so the
// schema is where it lives; the same-department part is forced by the composite foreign keys.
const assignedEmployeeIdsSchema = z.array(uuidSchema).min(1)
  .refine((ids) => new Set(ids).size === ids.length, { message: "An employee cannot be assigned more than once." });

const datesOrdered = [
  (data) => data.start_date === undefined || data.due_date === undefined || data.due_date >= data.start_date,
  { message: "due_date must be on or after start_date.", path: ["due_date"] },
];

// .strict() rejects any key not listed -- including id, company_id, created_at, updated_at,
// deleted_at, deleted_by_employee_id and Firestore's legacy `name`. Timestamps are server-set.
// The request field is assigned_employee_ids (D29); the response keeps the read shape's
// assignedEmployeeIds so a project reads the same whether just written or fetched.
export const projectCreateSchema = z.object({
  // Optional: projectMutationService defaults it to the principal's own for a manager or tl.
  department_id: uuidSchema.optional(),
  // Optional: defaults to the principal for a tl (who must lead what they create), else null.
  team_lead_id: uuidSchema.nullable().optional(),
  title: titleSchema,
  description: descriptionSchema.optional().default(""),
  start_date: dateSchema,
  due_date: dateSchema,
  // Defaults to `active`, not the column's `draft`: the frontend project form defaults to `active`
  // (ProjectsPage.jsx), so a project created through it must not silently land in draft -- that
  // would be a behavior change nobody asked for (D29). The column default is never consulted:
  // projectRepository.create always inserts the status explicitly.
  status: projectStatusSchema.optional().default("active"),
  assigned_employee_ids: assignedEmployeeIdsSchema,
}).strict()
  .refine(...datesOrdered);

export const projectUpdateSchema = z.object({
  department_id: uuidSchema.optional(),
  team_lead_id: uuidSchema.nullable().optional(),
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  start_date: dateSchema.optional(),
  due_date: dateSchema.optional(),
  status: projectStatusSchema.optional(),
  // When present it REPLACES the whole set atomically.
  assigned_employee_ids: assignedEmployeeIdsSchema.optional(),
}).strict()
  .refine((changes) => Object.keys(changes).length > 0, { message: "At least one field must be provided." })
  .refine(...datesOrdered)
  // The composite foreign keys tie both the lead and every assignment to the department, so a
  // department change is only expressible if both are restated alongside it (the lead may be null).
  .refine(
    (changes) => !Object.hasOwn(changes, "department_id")
      || (Object.hasOwn(changes, "team_lead_id") && Object.hasOwn(changes, "assigned_employee_ids")),
    { message: "Changing department_id requires team_lead_id and assigned_employee_ids too.", path: ["department_id"] },
  );
