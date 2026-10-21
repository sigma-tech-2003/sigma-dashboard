import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ApiError } from "../services/apiClient.js";
import {
  DEFAULT_SAVE_MESSAGE, LEAVE_DATES_MESSAGE, NETWORK_MESSAGE, SERVER_MESSAGE, describeSaveError, guardedSave, leaveDatesError,
} from "./saveErrors.js";

const api = (status, code, message = "server wording") => new ApiError({ status, code, message });

// ---- the messages -------------------------------------------------------------------------------------------------------

test("each failure the pages used to swallow has its own plain message, chosen by the API's error code", () => {
  // The four reported silent failures, as the server really answers them (backend repositories and services).
  assert.match(describeSaveError(api(400, "invalid_manager", "manager_employee_id must reference an employee who already works in this department.")), /manager who already works in this department/);
  assert.match(describeSaveError(api(409, "payroll_already_recorded", "A payroll record already exists for this employee and period.")), /already been recorded/);
  assert.match(describeSaveError(api(409, "leave_overlaps", "This request overlaps another pending or approved leave of yours.")), /overlap a leave request you already have/);
  assert.match(describeSaveError(api(400, "invalid_request", "The leave request payload is invalid.")), /not valid/);
});

test("the server's raw field names never reach the screen when a friendlier message exists", () => {
  for (const [code, raw] of [["invalid_manager", "manager_employee_id must reference ..."], ["invalid_request", "payload is invalid"]]) {
    assert.doesNotMatch(describeSaveError(api(400, code, raw)), /manager_employee_id|payload/);
  }
});

test("other leave and department refusals are also worded for a person", () => {
  assert.match(describeSaveError(api(409, "leave_already_decided")), /already been decided/);
  assert.match(describeSaveError(api(403, "self_approval_denied")), /your own leave/);
  assert.match(describeSaveError(api(403, "leave_scope_denied")), /outside the people you manage/);
  assert.match(describeSaveError(api(409, "name_already_exists")), /already exists/);
  assert.match(describeSaveError(api(409, "department_has_employees")), /still has employees/);
});

test("an unknown code falls back to the status: offline, outage, expired session, refusal, missing record", () => {
  assert.equal(describeSaveError(api(0, "network")), NETWORK_MESSAGE);
  assert.equal(describeSaveError(api(503, "unavailable")), SERVER_MESSAGE);
  assert.equal(describeSaveError(api(500, "internal")), SERVER_MESSAGE);
  assert.match(describeSaveError(api(401, "unauthenticated")), /session has expired/);
  assert.match(describeSaveError(api(403, "something_new")), /do not have permission/);
  assert.match(describeSaveError(api(404, "not_found")), /no longer exists/);
});

test("an unrecognised 400 or 409 shows the server's own sentence, and an empty one falls back", () => {
  assert.equal(describeSaveError(api(409, "brand_new_conflict", "That slot is taken.")), "That slot is taken.");
  assert.equal(describeSaveError(api(400, "brand_new_rule", "   "), "Could not save."), "Could not save.");
});

test("the mutation services' own errors (employee, project, KPI) already carry safe, curated messages and pass through", () => {
  const wrapped = (name, message) => Object.assign(new Error(message), { name });

  assert.equal(describeSaveError(wrapped("KpiMutationError", "Review the KPI details and try again.")), "Review the KPI details and try again.");
  assert.equal(describeSaveError(wrapped("ProjectMutationError", "Project management is temporarily unavailable. Please try again.")), "Project management is temporarily unavailable. Please try again.");
  assert.equal(describeSaveError(wrapped("EmployeeMutationError", "You do not have permission to manage this employee.")), "You do not have permission to manage this employee.");
  assert.equal(describeSaveError(wrapped("EmployeeInvitationError", "An employee account with this email already exists.")), "An employee account with this email already exists.");
});

test("only those exact classes pass through: an error that merely LOOKS similar does not leak its text", () => {
  const lookalike = (name) => Object.assign(new Error("Cannot read properties of undefined"), { name });

  for (const name of ["Error", "TypeError", "MutationError", "XProjectMutationError", "ProjectMutationErrorX", "KpiError"]) {
    assert.equal(describeSaveError(lookalike(name), "fallback"), "fallback", name);
  }
  assert.equal(describeSaveError(Object.assign(new Error("   "), { name: "KpiMutationError" }), "fallback"), "fallback", "an empty message falls back");
});

test("a non-API error never leaks its text, and the page's own fallback is used", () => {
  assert.equal(describeSaveError(new Error("Cannot read properties of undefined (reading 'id')")), DEFAULT_SAVE_MESSAGE);
  assert.equal(describeSaveError(new TypeError("boom"), "The department could not be saved."), "The department could not be saved.");
  for (const nothing of [null, undefined, "x", 42]) assert.equal(describeSaveError(nothing), DEFAULT_SAVE_MESSAGE);
});

// ---- the leave dates are checked before anything is sent --------------------------------------------------------------------

test("an end date before the start date is explained up front", () => {
  assert.equal(leaveDatesError("2026-12-05", "2026-12-01"), LEAVE_DATES_MESSAGE);
  assert.equal(leaveDatesError("2027-01-01", "2026-12-31"), LEAVE_DATES_MESSAGE, "across a year boundary");
  assert.equal(leaveDatesError("2026-02-10", "2026-02-09"), LEAVE_DATES_MESSAGE, "by a single day");
});

test("valid dates and a single-day request are fine; missing dates are the form's own required problem", () => {
  assert.equal(leaveDatesError("2026-12-01", "2026-12-05"), "");
  assert.equal(leaveDatesError("2026-12-01", "2026-12-01"), "", "the same day is one day of leave");
  for (const [start, end] of [["", "2026-12-01"], ["2026-12-01", ""], [undefined, undefined], [null, null]]) {
    assert.equal(leaveDatesError(start, end), "");
  }
});

// ---- guardedSave: a write that fails resolves to a message, it never throws ----------------------------------------------

test("guardedSave resolves ok with the value when the write succeeds", async () => {
  const result = await guardedSave(async () => "created-id");

  assert.deepEqual(result, { ok: true, value: "created-id" });
});

test("guardedSave NEVER rejects: a failing write resolves with a message the page can show", async () => {
  for (const failure of [api(409, "payroll_already_recorded"), api(0, "network"), new Error("boom"), "a string", undefined]) {
    const result = await guardedSave(async () => { throw failure; });

    assert.equal(result.ok, false);
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0);
  }
});

test("guardedSave also catches a write that throws synchronously, and uses the page's fallback for non-API errors", async () => {
  const result = await guardedSave(() => { throw new Error("sync"); }, { fallback: "The leave request could not be sent." });

  assert.deepEqual(result, { ok: false, message: "The leave request could not be sent." });
});

// ---- the pages really use it (a bare awaited write is what made these failures silent) -------------------------------------

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const without = (source, ...patterns) => patterns.every((pattern) => !pattern.test(source));

test("DepartmentsPage: save and delete go through guardedSave and show the message", async () => {
  const page = await read("../pages/departments/DepartmentsPage.jsx");

  assert.match(page, /guardedSave\(\s*\(\) => \(modal === "add"/);
  assert.match(page, /guardedSave\(\(\) => deleteDepartment/);
  assert.ok(without(page, /await addDepartment\(/, /await updateDepartment\(/, /await deleteDepartment\(/), "no bare awaited writes");
  assert.match(page, /<FormFeedback>\{saveError\}<\/FormFeedback>/);
});

test("PayrollPage: processing and marking processed go through guardedSave and show the message", async () => {
  const page = await read("../pages/payroll/PayrollPage.jsx");

  assert.match(page, /guardedSave\(\(\) => addPayroll/);
  assert.match(page, /guardedSave\(\(\) => updatePayrollStatus/);
  assert.ok(without(page, /await addPayroll\(/, /onClick=\{\(\) => updatePayrollStatus\(/), "no bare writes");
  assert.match(page, /\{processError\}/);
  assert.match(page, /\{actionError\}/);
});

test("LeavePage: applying and deciding go through guardedSave, and the dates are checked before sending", async () => {
  const page = await read("../pages/leave/LeavePage.jsx");

  assert.match(page, /guardedSave\(\(\) => addLeave/);
  assert.match(page, /guardedSave\(\(\) => updateLeaveStatus/);
  assert.ok(without(page, /await addLeave\(/, /onClick=\{\(\) => updateLeaveStatus\(/), "no bare writes");
  assert.match(page, /leaveDatesError\(form\.start, form\.end\)/);
  assert.match(page, /\{applyError\}/);
  assert.match(page, /\{decisionError\}/);
});

test("KPIPage: the 'Update current' field goes through guardedSave and shows the message", async () => {
  const page = await read("../pages/kpi/KPIPage.jsx");

  assert.match(page, /guardedSave\(\(\) => updateKpi\(id, \{ current:/);
  assert.ok(without(page, /await updateKpi\(id, \{ current:/), "no bare awaited write");
  assert.match(page, /updateErrors\[k\.id\] && \([\s\S]{0,120}role="alert"[\s\S]{0,120}\{updateErrors\[k\.id\]\}/);
});
