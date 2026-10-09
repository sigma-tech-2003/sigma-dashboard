import { MONTHS, MappingError, idOrEmpty, onlyChanged, pickMapped } from "./common.js";

// Payroll. `empId` here is the employee's id (the foreign key). The pages hold the month as an English name and
// the API as 1-12.

export function monthNameToNumber(name) {
  const index = MONTHS.indexOf(name);
  if (index === -1) throw new MappingError("invalid-month", `"${name}" is not a month name.`);
  return index + 1;
}

export function monthNumberToName(number) {
  const name = MONTHS[Number(number) - 1];
  if (!name) throw new MappingError("invalid-month", `${number} is not a month number.`);
  return name;
}

export function fromApi(row) {
  return {
    id: row.id,
    empId: row.employee_id,
    month: monthNumberToName(row.period_month),
    year: row.period_year,
    basic: row.basic,
    allowances: row.allowances,
    bonus: row.bonus,
    deductions: row.deductions,
    gross: row.gross,
    tax: row.tax,
    net: row.net,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const FIELDS = [
  ["empId", "employee_id", idOrEmpty],
  ["year", "period_year", Number],
  ["month", "period_month", monthNameToNumber],
  ["basic", "basic", Number],
  ["allowances", "allowances", Number],
  ["bonus", "bonus", Number],
  ["deductions", "deductions", Number],
  ["status", "status"],
];

/**
 * POST /payroll. `tax`, `net` and `gross` are never sent: they are generated columns in the database (D7, D28),
 * which also rejects an attempt to write them, and the page's `id: Date.now()` is not sent either. Whatever tax
 * and net the page previews, the stored figures are the database's.
 */
export function toApiCreate(record) {
  return pickMapped(record, FIELDS);
}

/** PATCH /payroll/:id. */
export function toApiUpdate(changes, context = {}) {
  return pickMapped(onlyChanged(changes, context.original), FIELDS);
}
