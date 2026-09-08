import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "../src/db/migrator.js";
import { getEmployeeScope } from "../src/services/employeeScopeService.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, "..", "src", "db", "migrations");

test("core hierarchy migration defines the required PostgreSQL tables and roles", async () => {
  const migrations = await loadMigrations(migrationsDirectory);
  assert.equal(migrations.length, 1);
  const [migration] = migrations;
  for (const table of ["companies", "departments", "teams", "users", "employees"]) {
    assert.match(migration.sql, new RegExp(`CREATE TABLE ${table}`));
  }
  for (const role of ["admin", "hr", "manager", "tl", "employee"]) {
    assert.match(migration.sql, new RegExp(`'${role}'`));
  }
  assert.match(migration.sql, /employees_team_scope_foreign_key/);
  assert.match(migration.sql, /departments_manager_employee_foreign_key/);
  assert.match(migration.sql, /teams_team_lead_employee_foreign_key/);
  assert.match(migration.sql, /users_company_email_unique/);
});

test("employee scope foundation models the existing five role boundaries", () => {
  const base = { employeeId: "employee-id", companyId: "company-id" };
  assert.deepEqual(getEmployeeScope({ ...base, role: "admin" }), { type: "company" });
  assert.deepEqual(getEmployeeScope({ ...base, role: "hr" }), { type: "company" });
  assert.deepEqual(
    getEmployeeScope({ ...base, role: "manager", departmentId: "department-id" }),
    { type: "department", departmentId: "department-id" },
  );
  assert.deepEqual(
    getEmployeeScope({ ...base, role: "tl", teamId: "team-id" }),
    { type: "team", teamId: "team-id" },
  );
  assert.deepEqual(getEmployeeScope({ ...base, role: "employee" }), {
    type: "self",
    employeeId: "employee-id",
  });
});
