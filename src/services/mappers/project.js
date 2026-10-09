import {
  emptyToNull,
  hasOwn,
  nullToEmpty,
  onlyChanged,
  pickMapped,
  resolveDepartmentId,
  trimmed,
} from "./common.js";

// Projects. `assignedEmployeeIds` is already in the page's shape on the API (it is the one field that was).

export function fromApi(row) {
  return {
    id: row.id,
    title: row.title,
    description: nullToEmpty(row.description),
    department: nullToEmpty(row.department_name),
    departmentId: row.department_id ?? "",
    teamLeadId: row.team_lead_id ?? "",
    assignedEmployeeIds: Array.isArray(row.assignedEmployeeIds) ? [...row.assignedEmployeeIds] : [],
    startDate: row.start_date,
    dueDate: row.due_date,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const FIELDS = [
  ["title", "title", trimmed],
  ["description", "description", (value) => trimmed(value) ?? ""],
  ["teamLeadId", "team_lead_id", (value) => emptyToNull(value)],
  ["startDate", "start_date"],
  ["dueDate", "due_date"],
  ["status", "status"],
  ["assignedEmployeeIds", "assigned_employee_ids", (ids) => (Array.isArray(ids) ? ids.map(String) : ids)],
];

function departmentField(record, { departments } = {}) {
  if (!hasOwn(record, "department") && !hasOwn(record, "departmentId")) return {};
  const id = resolveDepartmentId({ name: record.department, departmentId: record.departmentId, departments });
  return id === undefined ? {} : { department_id: id };
}

/** POST /projects. A manager or tl may omit the department: the server uses their own. */
export function toApiCreate(record, context = {}) {
  return { ...pickMapped(record, FIELDS), ...departmentField(record, context) };
}

/**
 * PATCH /projects/:id. The server only accepts a changed department together with a team lead and the
 * assignments; the mapper does not invent those, so a department change without them comes back as the API's own 400.
 */
export function toApiUpdate(changes, context = {}) {
  const kept = onlyChanged(changes, context.original);
  return { ...pickMapped(kept, FIELDS), ...departmentField(kept, context) };
}
