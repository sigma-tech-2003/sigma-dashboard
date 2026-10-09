import { MappingError, idOrEmpty, onlyChanged, pickMapped, trimmed } from "./common.js";

// KPIs. `empId` here is the employee's id (the foreign key), unlike on an employee record.

export function fromApi(row) {
  return {
    id: row.id,
    empId: row.employee_id,
    projectId: row.project_id ?? "",
    title: row.title,
    target: row.target,
    current: row.current_value,
    weight: row.weight,
    period: row.period,
    status: row.status,
    rating: row.rating ?? null,
    ratedBy: row.rated_by_employee_id ?? "",
    ratedAt: row.rated_at ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPDATABLE_FIELDS = [
  ["title", "title", trimmed],
  ["target", "target", Number],
  ["current", "current_value", Number],
  ["weight", "weight", Number],
  ["period", "period", trimmed],
  ["status", "status"],
];

/**
 * POST /kpis. The employee and the project are both required and, once set, never change (D29). `rating`,
 * `ratedBy` and `ratedAt` are not sent: a rating is its own operation.
 */
export function toApiCreate(record) {
  return {
    ...pickMapped(record, [["projectId", "project_id", idOrEmpty], ["empId", "employee_id", idOrEmpty], ...UPDATABLE_FIELDS]),
  };
}

/** PATCH /kpis/:id. The employee and project are frozen, so `empId` and `projectId` are never sent. */
export function toApiUpdate(changes, context = {}) {
  return pickMapped(onlyChanged(changes, context.original), UPDATABLE_FIELDS);
}

/** POST /kpis/:id/rating. A whole number from 1 to 10; anything else is not sent to the server at all. */
export function toApiRating(rating) {
  const value = Number(rating);
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new MappingError("invalid-rating", "A rating is a whole number from 1 to 10.");
  }
  return { rating: value };
}
