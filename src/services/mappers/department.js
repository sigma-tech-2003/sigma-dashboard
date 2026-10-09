import { MappingError, emptyToNull, nullToEmpty, onlyChanged, pickMapped, trimmed } from "./common.js";

// Departments. The pages write and compare "Active" / "Inactive"; the API enum is lowercase.

const TO_PAGE_STATUS = Object.freeze({ active: "Active", inactive: "Inactive" });
const TO_API_STATUS = Object.freeze({ Active: "active", Inactive: "inactive" });

export function statusToApi(status) {
  const mapped = TO_API_STATUS[status];
  if (!mapped) throw new MappingError("invalid-status", `"${status}" is not a department status.`);
  return mapped;
}

export function fromApi(row) {
  return {
    id: row.id,
    name: row.name,
    description: nullToEmpty(row.description),
    status: TO_PAGE_STATUS[row.status] ?? row.status,
    managerId: row.manager_employee_id ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COMMON_FIELDS = [
  ["name", "name", trimmed],
  ["description", "description", (value) => emptyToNull(trimmed(value))],
  ["status", "status", statusToApi],
];

/**
 * POST /departments. The create schema has no manager: a manager is chosen afterwards, by an update, once the
 * department exists (the manager must already work in it). So `managerId` is deliberately not sent here.
 */
export function toApiCreate(record) {
  return pickMapped(record, COMMON_FIELDS);
}

/** PATCH /departments/:id. `managerId: ""` clears the manager. */
export function toApiUpdate(changes, context = {}) {
  const kept = onlyChanged(changes, context.original);
  return pickMapped(kept, [...COMMON_FIELDS, ["managerId", "manager_employee_id", (value) => emptyToNull(value)]]);
}
