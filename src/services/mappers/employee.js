import {
  emptyToNull,
  hasOwn,
  idOrEmpty,
  nullToEmpty,
  onlyChanged,
  pickMapped,
  resolveDepartmentId,
  trimmed,
} from "./common.js";

// Employees. NOTE: `empId` on an employee is the human-readable employee NUMBER ("EMP-001", from
// employee_number). On every other record (leave, attendance, payroll, KPI) `empId` is the foreign key to the
// employee's id. See the other mappers.

/** API employee row -> the record the pages consume. `status` passes through, including on_leave/terminated. */
export function fromApi(row) {
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    phone: nullToEmpty(row.phone),
    dept: nullToEmpty(row.department_name),
    // Not a field the pages know. Carried so a read followed by a write resolves the department without the
    // departments list, which only admin and hr can read.
    departmentId: row.department_id ?? "",
    pos: row.position_title,
    basic: row.basic,
    allowances: row.allowances,
    joinDate: row.joined_on,
    role: row.role,
    status: row.employment_status,
    teamLeadId: row.team_lead_id ?? "",
    empId: row.employee_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SCALAR_FIELDS = [
  ["name", "full_name", trimmed],
  ["email", "email", (value) => trimmed(value)?.toLowerCase()],
  ["phone", "phone", (value) => emptyToNull(trimmed(value))],
  ["pos", "position_title", trimmed],
  ["joinDate", "joined_on"],
  ["basic", "basic", Number],
  ["allowances", "allowances", Number],
  ["role", "role"],
  ["teamLeadId", "team_lead_id", (value) => emptyToNull(value)],
];

function departmentField(record, { departments } = {}) {
  if (!hasOwn(record, "dept") && !hasOwn(record, "departmentId")) return {};
  const id = resolveDepartmentId({ name: record.dept, departmentId: record.departmentId, departments });
  return id === undefined ? {} : { department_id: id };
}

/**
 * A page's new-employee payload -> POST /employees. `status` becomes employment_status and is sent only when
 * it is "active" or "inactive" (D35); the API rejects anything else on create. `id`, `empId` and the timestamps
 * are never sent: the server assigns them.
 */
export function toApiCreate(record, context = {}) {
  const body = { ...pickMapped(record, SCALAR_FIELDS), ...departmentField(record, context) };
  if (hasOwn(record, "status")) body.employment_status = record.status;
  return body;
}

/** A page's edit -> PATCH /employees/:id. */
export function toApiUpdate(changes, context = {}) {
  const kept = onlyChanged(changes, context.original);
  const body = { ...pickMapped(kept, SCALAR_FIELDS), ...departmentField(kept, context) };
  if (hasOwn(kept, "status")) body.employment_status = kept.status;
  return body;
}

/** The delete body: the API's replacement team lead, or none. */
export function toApiDelete({ replacementTeamLeadId } = {}) {
  return replacementTeamLeadId == null || replacementTeamLeadId === ""
    ? {}
    : { replacement_team_lead_id: idOrEmpty(replacementTeamLeadId) };
}
