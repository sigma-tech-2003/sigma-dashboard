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

// The fields the API requires alongside a changed department.
const WITH_DEPARTMENT = FIELDS.filter(([pageKey]) => pageKey === "teamLeadId" || pageKey === "assignedEmployeeIds");

/**
 * PATCH /projects/:id. The server accepts a changed department ONLY together with team_lead_id and
 * assigned_employee_ids, even when neither changed (a project that never had a lead still has to say so, and a move
 * that keeps the same assignees still has to list them). So when the department changes, those two are sent from the
 * record being saved (or, for a partial change, from the original), not just when they differ. Nothing is invented:
 * if neither the changes nor the original holds a value, the key is left out and the API's own 400 explains it.
 */
export function toApiUpdate(changes, context = {}) {
  const kept = onlyChanged(changes, context.original);
  const body = { ...pickMapped(kept, FIELDS), ...departmentField(kept, context) };

  if (hasOwn(body, "department_id")) {
    const source = { ...context.original, ...changes };
    Object.assign(body, pickMapped(source, WITH_DEPARTMENT), pickMapped(kept, WITH_DEPARTMENT));
  }
  return body;
}
