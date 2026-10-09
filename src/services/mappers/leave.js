import { MappingError, nullToEmpty, trimmed } from "./common.js";

// Leaves. `empId` here is the employee's id (the foreign key).

export function fromApi(row) {
  return {
    id: row.id,
    empId: row.employee_id,
    type: row.type,
    start: row.start_date,
    end: row.end_date,
    days: row.days,
    reason: nullToEmpty(row.reason),
    status: row.status,
    applied: row.applied_on,
    decidedBy: row.decided_by_employee_id ?? "",
    decidedAt: row.decided_at ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * POST /leaves. Exactly four fields. The page also builds `id`, `empId`, `days`, `status` and `applied`; none is
 * sent, because the server takes the employee from the signed-in user, computes the days, sets the status to
 * pending and stamps the application date itself, and its strict schema rejects any extra key.
 */
export function toApiCreate(record) {
  return {
    type: record.type,
    start_date: record.start,
    end_date: record.end,
    reason: trimmed(record.reason),
  };
}

/** PATCH /leaves/:id — a decision. Only "approved" and "rejected" exist as decisions. */
export function toApiDecision(status) {
  if (status !== "approved" && status !== "rejected") {
    throw new MappingError("invalid-decision", `"${status}" is not a leave decision.`);
  }
  return { status };
}
