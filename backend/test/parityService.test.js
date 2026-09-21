import assert from "node:assert/strict";
import test from "node:test";
import {
  SENSITIVE_FIELDS,
  compareDomain,
  compareRecordPair,
  getDomainFieldMap,
  hasMismatch,
} from "../src/services/parityService.js";

// Pure, no Firebase, no database. Fixture data only -- never real employee data, matching
// the instruction that no real PII appears anywhere, including in tests.

const DOMAINS = ["employees", "departments", "projects", "kpis", "leaves", "attendance", "payroll"];

// ---------------------------------------------------------------------------
// Structural guarantees that must hold for every domain
// ---------------------------------------------------------------------------

test("every domain has a field map with at least one comparable and one not-comparable field", () => {
  for (const domain of DOMAINS) {
    const { comparable, notComparable } = getDomainFieldMap(domain);
    assert.ok(comparable.length > 0, `${domain}: no comparable fields`);
    assert.ok(notComparable.length > 0, `${domain}: no not-comparable fields declared`);
  }
});

test("an unknown domain throws rather than silently returning an empty map", () => {
  assert.throws(() => getDomainFieldMap("not-a-real-domain"), RangeError);
});

test("no sensitive field's value ever appears in a comparison entry, match or mismatch, for any domain", () => {
  // Structural redaction: this must hold regardless of what fixture data is fed in, so the
  // harness cannot accidentally leak a real salary/phone/name no matter what it compares.
  const sensitiveProbe = "SHOULD-NEVER-APPEAR-IN-OUTPUT";
  for (const domain of DOMAINS) {
    const { comparable } = getDomainFieldMap(domain);
    for (const { firestoreField, apiField } of comparable) {
      if (!SENSITIVE_FIELDS.has(firestoreField) && !SENSITIVE_FIELDS.has(apiField)) continue;
      const firestoreRecord = { [firestoreField]: sensitiveProbe };
      const apiRecord = { [apiField]: "a-different-value" }; // force a mismatch, the riskier case
      const entries = compareRecordPair(domain, firestoreRecord, apiRecord);
      const entry = entries.find((candidate) => candidate.field === firestoreField || candidate.field === apiField);
      assert.ok(entry, `${domain}.${firestoreField}: no entry produced`);
      assert.equal(entry.result, "mismatch");
      assert.ok(!("firestoreValue" in entry), `${domain}.${firestoreField} leaked firestoreValue`);
      assert.ok(!("apiValue" in entry), `${domain}.${firestoreField} leaked apiValue`);
      assert.doesNotMatch(JSON.stringify(entry), new RegExp(sensitiveProbe));
    }
  }
});

test("non-sensitive comparable fields DO carry both values, for debuggability", () => {
  const entries = compareRecordPair("leaves", { type: "Annual" }, { type: "Sick" });
  const entry = entries.find((candidate) => candidate.field === "type");
  assert.equal(entry.result, "mismatch");
  assert.equal(entry.firestoreValue, "Annual");
  assert.equal(entry.apiValue, "Sick");
});

test("every not-comparable field is reported with a reason, never silently dropped", () => {
  for (const domain of DOMAINS) {
    const entries = compareRecordPair(domain, {}, {});
    const { notComparable } = getDomainFieldMap(domain);
    const notComparableEntries = entries.filter((entry) => entry.result === "not_comparable");
    assert.equal(notComparableEntries.length, notComparable.length, domain);
    for (const entry of notComparableEntries) {
      assert.equal(typeof entry.reason, "string", `${domain}.${entry.field} has no reason`);
      assert.ok(entry.reason.length > 0, `${domain}.${entry.field} has an empty reason`);
    }
  }
});

// ---------------------------------------------------------------------------
// employees
// ---------------------------------------------------------------------------

test("employees: a fully matching record produces all comparable-field matches", () => {
  const firestoreRecord = {
    name: "Person A", email: "a@x.com", phone: "0300", pos: "Developer",
    basic: 1000, allowances: 200, joinDate: "2022-01-01", role: "employee",
    status: "active", empId: "EMP-1",
  };
  const apiRecord = {
    full_name: "Person A", email: "a@x.com", phone: "0300", position_title: "Developer",
    basic: 1000, allowances: 200, joined_on: "2022-01-01", role: "employee",
    employment_status: "active", employee_number: "EMP-1",
  };
  const entries = compareRecordPair("employees", firestoreRecord, apiRecord);
  const comparable = entries.filter((entry) => entry.result !== "not_comparable");
  assert.ok(comparable.every((entry) => entry.result === "match"), JSON.stringify(comparable));
});

test("employees: dept/teamLeadId/uid are explicitly not_comparable, not silently matched", () => {
  const entries = compareRecordPair("employees", { dept: "Engineering", teamLeadId: "3", uid: "firebase-uid" }, { department_id: "uuid-1", team_lead_id: "uuid-2", user_id: "uuid-3" });
  for (const field of ["dept / department_id", "teamLeadId / team_lead_id", "uid / user_id"]) {
    const entry = entries.find((candidate) => candidate.field === field);
    assert.equal(entry.result, "not_comparable", field);
  }
});

// ---------------------------------------------------------------------------
// projects: the assignedEmployeeIds count-vs-elements distinction
// ---------------------------------------------------------------------------

test("projects: assignedEmployeeIds is compared by count as a separate aspect, and by element not at all", () => {
  const entries = compareRecordPair(
    "projects",
    { assignedEmployeeIds: ["fs-1", "fs-2", "fs-3"] },
    { assignedEmployeeIds: ["pg-a", "pg-b"] }, // different id space, different count
  );
  const countEntry = entries.find((entry) => entry.field === "assignedEmployeeIds.length");
  assert.equal(countEntry.result, "mismatch"); // 3 vs 2

  const elementEntry = entries.find((entry) => entry.field === "assignedEmployeeIds / assignedEmployeeIds");
  assert.equal(elementEntry.result, "not_comparable");
});

test("projects: matching counts produce a match on the count aspect even though the ids differ entirely", () => {
  const entries = compareRecordPair(
    "projects",
    { assignedEmployeeIds: ["fs-1", "fs-2"] },
    { assignedEmployeeIds: ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"] },
  );
  const countEntry = entries.find((entry) => entry.field === "assignedEmployeeIds.length");
  assert.equal(countEntry.result, "match");
});

// ---------------------------------------------------------------------------
// kpis: ratedAt is comparable; createdAt/updatedAt are not
// ---------------------------------------------------------------------------

test("kpis: ratedAt is genuinely compared, unlike createdAt/updatedAt", () => {
  const { comparable, notComparable } = getDomainFieldMap("kpis");
  assert.ok(comparable.some((field) => field.firestoreField === "ratedAt"));
  assert.ok(notComparable.some((field) => field.firestoreField === "createdAt"));
  assert.ok(notComparable.some((field) => field.firestoreField === "updatedAt"));
});

test("kpis: a matching ratedAt/rated_at pair matches; a differing one mismatches", () => {
  const matching = compareRecordPair("kpis", { ratedAt: "2025-03-01T00:00:00.000Z" }, { rated_at: "2025-03-01T10:00:00.000Z" });
  assert.equal(matching.find((entry) => entry.field === "ratedAt").result, "match"); // same calendar date

  const both_null = compareRecordPair("kpis", { ratedAt: null }, { rated_at: null });
  assert.equal(both_null.find((entry) => entry.field === "ratedAt").result, "match");

  const differing = compareRecordPair("kpis", { ratedAt: "2025-03-01T00:00:00.000Z" }, { rated_at: null });
  assert.equal(differing.find((entry) => entry.field === "ratedAt").result, "mismatch");
});

test("kpis: rating travels as both-null-or-both-set", () => {
  assert.equal(compareRecordPair("kpis", { rating: null }, { rating: null }).find((e) => e.field === "rating").result, "match");
  assert.equal(compareRecordPair("kpis", { rating: 8 }, { rating: null }).find((e) => e.field === "rating").result, "mismatch");
});

// ---------------------------------------------------------------------------
// leaves: the three fields with no Firestore source at all
// ---------------------------------------------------------------------------

test("leaves: decided_by_employee_id, decided_at and decision_recorded have no Firestore source", () => {
  const { notComparable } = getDomainFieldMap("leaves");
  const newFields = notComparable.filter((field) => field.firestoreField === null);
  assert.deepEqual(
    newFields.map((field) => field.apiField).sort(),
    ["decided_at", "decided_by_employee_id", "decision_recorded"],
  );
  for (const field of newFields) {
    assert.match(field.reason, /no firestore source/i, field.apiField);
  }
});

// ---------------------------------------------------------------------------
// attendance: the "" vs null time sentinel
// ---------------------------------------------------------------------------

test("attendance: an empty-string checkIn matches a null check_in", () => {
  const entries = compareRecordPair("attendance", { checkIn: "", checkOut: "17:00" }, { check_in: null, check_out: "17:00" });
  assert.equal(entries.find((e) => e.field === "checkIn").result, "match");
});

// ---------------------------------------------------------------------------
// payroll: month-name mapping, and the deliberate tax/net exclusion
// ---------------------------------------------------------------------------

test("payroll: every one of the twelve English month names maps to its correct 1-12 number", () => {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  months.forEach((month, index) => {
    const entries = compareRecordPair("payroll", { month, year: 2025 }, { period_month: index + 1, period_year: 2025 });
    assert.equal(entries.find((e) => e.field === "month").result, "match", month);
  });
});

test("payroll: a mismatched month number is caught, not silently accepted", () => {
  const entries = compareRecordPair("payroll", { month: "March" }, { period_month: 4 });
  assert.equal(entries.find((e) => e.field === "month").result, "mismatch");
});

test("payroll: tax and net are deliberately not_comparable, with the reasoning stated", () => {
  // Postgres computes these; a Firestore value that disagrees means the SOURCE was wrong,
  // which Phase 2's import already reports as its own advisory. Re-litigating that here
  // would muddy this harness's actual job (scope correctness), so they are excluded on
  // purpose, not by oversight -- this test pins that down explicitly.
  const { notComparable } = getDomainFieldMap("payroll");
  const tax = notComparable.find((field) => field.firestoreField === "tax");
  const net = notComparable.find((field) => field.firestoreField === "net");
  assert.ok(tax && net);
  assert.match(tax.reason, /Postgres computes/);
  const gross = notComparable.find((field) => field.apiField === "gross");
  assert.ok(gross, "gross has no Firestore source and must be declared not_comparable");
});

// ---------------------------------------------------------------------------
// compareDomain: set membership, known orphans, and the summary counts
// ---------------------------------------------------------------------------

test("compareDomain: firestoreOnly is a mismatch by default, unless the key is a known orphan", () => {
  const report = compareDomain("kpis", {
    matchedPairs: [],
    firestoreOnly: [{ key: "orphaned-1" }, { key: "real-bug-1" }],
    apiOnly: [],
    knownOrphanKeys: new Set(["orphaned-1"]),
  });
  const orphanEntry = report.setMembership.find((entry) => entry.key === "orphaned-1");
  const bugEntry = report.setMembership.find((entry) => entry.key === "real-bug-1");
  assert.equal(orphanEntry.result, "not_comparable");
  assert.equal(bugEntry.result, "mismatch");
  assert.equal(report.summary.mismatches, 1);
});

test("compareDomain: apiOnly is always a mismatch -- there is no such thing as a known apiOnly exception", () => {
  // Unlike firestoreOnly (which can be an expected, already-reported orphan), a record
  // the API returns that Firestore would never have shown this principal is always a
  // scope over-inclusion bug -- a privacy leak, not a data-quality artifact to excuse.
  const report = compareDomain("leaves", {
    matchedPairs: [],
    firestoreOnly: [],
    apiOnly: [{ key: "leaked-1" }],
    knownOrphanKeys: new Set(["leaked-1"]), // even if (mistakenly) listed, must not help
  });
  assert.equal(report.setMembership[0].result, "mismatch");
  assert.match(report.setMembership[0].reason, /over-inclusion/);
});

test("compareDomain: summary counts matched pairs, mismatches and not_comparable across both set-membership and field comparisons", () => {
  const report = compareDomain("attendance", {
    matchedPairs: [
      { key: "a1", firestoreRecord: { date: "2025-01-01", status: "present" }, apiRecord: { work_date: "2025-01-01", status: "present" } },
      { key: "a2", firestoreRecord: { date: "2025-01-02", status: "present" }, apiRecord: { work_date: "2025-01-02", status: "absent" } },
    ],
    firestoreOnly: [{ key: "a3" }],
    apiOnly: [],
  });
  assert.equal(report.summary.matched, 2);
  assert.equal(report.summary.firestoreOnly, 1);
  // a2's status mismatch + a3's set-membership mismatch
  assert.equal(report.summary.mismatches, 2);
});

test("hasMismatch is true if any report (or any in an array of reports) has a mismatch", () => {
  const clean = compareDomain("departments", { matchedPairs: [], firestoreOnly: [], apiOnly: [] });
  const dirty = compareDomain("departments", { matchedPairs: [], firestoreOnly: [{ key: "x" }], apiOnly: [] });

  assert.equal(hasMismatch(clean), false);
  assert.equal(hasMismatch(dirty), true);
  assert.equal(hasMismatch([clean, clean]), false);
  assert.equal(hasMismatch([clean, dirty]), true);
});
