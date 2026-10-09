import { emptyToNull, idOrEmpty, nullToEmpty, onlyChanged, pickMapped, trimmed } from "./common.js";

// Attendance. `empId` here is the employee's id (the foreign key). Times are "HH:MM" text; the pages hold "" for
// no time where the API holds null.

export function fromApi(row) {
  return {
    id: row.id,
    empId: row.employee_id,
    date: row.work_date,
    status: row.status,
    checkIn: nullToEmpty(row.check_in),
    checkOut: nullToEmpty(row.check_out),
    notes: nullToEmpty(row.notes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const FIELDS = [
  ["empId", "employee_id", idOrEmpty],
  ["date", "work_date", trimmed],
  ["status", "status"],
  ["checkIn", "check_in", (value) => emptyToNull(trimmed(value))],
  ["checkOut", "check_out", (value) => emptyToNull(trimmed(value))],
  ["notes", "notes", (value) => emptyToNull(trimmed(value))],
];

/** POST /attendance. The page's `createdAt`/`updatedAt` are not sent: the server owns timestamps. */
export function toApiCreate(record) {
  return pickMapped(record, FIELDS);
}

/** PATCH /attendance/:id. */
export function toApiUpdate(changes, context = {}) {
  return pickMapped(onlyChanged(changes, context.original), FIELDS);
}
