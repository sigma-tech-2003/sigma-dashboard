import { z } from "zod";
import { uuidSchema } from "./commonSchemas.js";

// attendance_status enum (001_initial_core_hr_hierarchy.up.sql).
const attendanceStatusSchema = z.enum(["present", "absent", "late", "leave"]);

// z.iso.date() also rejects impossible calendar dates (2026-02-30), which a bare regex would not.
const workDateSchema = z.iso.date();

// HH:MM, 24-hour, or null (D27: no "" sentinel). Fixed-width, so string comparison orders times.
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a 24-hour time (HH:MM)");

const notesSchema = z.string().trim().max(2000);

const hasTimes = (data) => data.check_in != null || data.check_out != null;

// The same two rules the database enforces (attendance_absent_has_no_times,
// attendance_times_ordered), checked here first for a clearer 400. They only see the fields in
// the payload: a PATCH that, say, sets status to absent while the stored record still has times
// is caught by the database CHECK and translated by attendanceRepository.js instead.
const absentHasNoTimes = [
  (data) => !(data.status === "absent" || data.status === "leave") || !hasTimes(data),
  { message: "Absent and leave records cannot have a check-in or check-out time.", path: ["status"] },
];
const timesOrdered = [
  (data) => data.check_in == null || data.check_out == null || data.check_out > data.check_in,
  { message: "check_out must be later than check_in.", path: ["check_out"] },
];

// .strict() rejects any key not listed -- including id, created_at, updated_at, deleted_at and
// deleted_by_employee_id. Timestamps are server-set (D27), so a client supplying one is refused
// outright rather than silently ignored.
export const attendanceCreateSchema = z.object({
  employee_id: uuidSchema,
  work_date: workDateSchema,
  status: attendanceStatusSchema,
  check_in: timeSchema.nullable().optional().default(null),
  check_out: timeSchema.nullable().optional().default(null),
  notes: notesSchema.nullable().optional().default(null),
}).strict()
  .refine(...absentHasNoTimes)
  .refine(...timesOrdered);

export const attendanceUpdateSchema = z.object({
  employee_id: uuidSchema.optional(),
  work_date: workDateSchema.optional(),
  status: attendanceStatusSchema.optional(),
  check_in: timeSchema.nullable().optional(),
  check_out: timeSchema.nullable().optional(),
  notes: notesSchema.nullable().optional(),
}).strict()
  .refine((changes) => Object.keys(changes).length > 0, { message: "At least one field must be provided." })
  .refine(...absentHasNoTimes)
  .refine(...timesOrdered);
