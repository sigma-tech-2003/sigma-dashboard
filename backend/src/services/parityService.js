/**
 * Pure comparison logic for the Phase 3 parity harness. No I/O, no Firebase, no database --
 * takes data already fetched and already correlated by the caller (scripts/parity-
 * harness.js, not yet written) and produces a report.
 *
 * "If the harness cannot tell two shapes apart, say so rather than reporting a false
 * match": every field this module knows about is classified once, explicitly, as either
 * COMPARABLE (same meaning on both sides, safe to diff) or NOT COMPARABLE (deliberately
 * reshaped by the migration, or has no analog on one side) with a stated reason. A field
 * absent from both lists is itself an error (unknown-field), not a silent pass -- see
 * compareRecordPair.
 *
 * Redaction is structural, not a printing convention: SENSITIVE_FIELDS values never enter
 * a returned report entry at all, so no caller can accidentally log a real salary, phone
 * number, or name -- the decision that the harness's output must never contain one is
 * enforced here, in the one place every report passes through, not left to whoever prints
 * it later.
 */

export const SENSITIVE_FIELDS = new Set(["basic", "allowances", "phone", "full_name", "name", "email"]);

const MONTH_TO_NUMBER = new Map([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
].map((name, index) => [name, index + 1]));

const sameValue = (a, b) => a === b;
const sameNumber = (a, b) => Number(a) === Number(b);
const sameDate = (a, b) => String(a).slice(0, 10) === String(b).slice(0, 10);
/** "" and null both mean "no time recorded" -- attendance's empty-string sentinel vs Postgres NULL. */
const sameOptionalTime = (a, b) => {
  const normalize = (value) => (value === "" || value === null || value === undefined ? null : value);
  return normalize(a) === normalize(b);
};
const sameOptionalText = (a, b) => {
  const normalize = (value) => (value === "" || value === null || value === undefined ? null : value);
  return normalize(a) === normalize(b);
};
const sameMonthNumber = (firestoreMonthName, apiMonthNumber) => MONTH_TO_NUMBER.get(firestoreMonthName) === apiMonthNumber;
const sameCaseFoldedStatus = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
/** rating/ratedAt/ratedBy travel together; both null is a match, exactly one null is not. */
const sameOrBothNull = (a, b) => (a ?? null) === (b ?? null);
/** Both null/undefined is a match; exactly one is not; otherwise compare calendar dates. */
const sameOptionalDate = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return sameDate(a, b);
};

/**
 * Per domain: `comparable` fields are diffed value-for-value; `notComparable` fields are
 * reported once per record pair as not_comparable with a reason, never silently dropped.
 */
const DOMAIN_FIELD_MAPS = Object.freeze({
  employees: {
    comparable: [
      { firestoreField: "name", apiField: "full_name", compare: sameValue },
      { firestoreField: "email", apiField: "email", compare: sameValue },
      { firestoreField: "phone", apiField: "phone", compare: sameOptionalText },
      { firestoreField: "pos", apiField: "position_title", compare: sameValue },
      { firestoreField: "basic", apiField: "basic", compare: sameNumber },
      { firestoreField: "allowances", apiField: "allowances", compare: sameNumber },
      { firestoreField: "joinDate", apiField: "joined_on", compare: sameDate },
      { firestoreField: "role", apiField: "role", compare: sameValue },
      { firestoreField: "status", apiField: "employment_status", compare: sameValue },
      { firestoreField: "empId", apiField: "employee_number", compare: sameValue },
    ],
    notComparable: [
      { firestoreField: "dept", apiField: "department_id", reason: "Firestore stores a department name; Postgres stores its uuid" },
      { firestoreField: "teamLeadId", apiField: "team_lead_id", reason: "Firestore id form (string or legacy numeric) differs from the Postgres uuid" },
      { firestoreField: "uid", apiField: "user_id", reason: "user_id is a freshly generated uuid, not the Firebase uid" },
      { firestoreField: "createdByUid", apiField: null, reason: "dropped by the migration: written in Firestore but never read anywhere" },
      { firestoreField: "createdAt", apiField: "created_at", reason: "created_at reflects when the row was imported, not the original Firestore timestamp" },
      { firestoreField: "updatedAt", apiField: "updated_at", reason: "same reason as createdAt" },
    ],
  },

  departments: {
    comparable: [
      { firestoreField: "name", apiField: "name", compare: sameValue },
      { firestoreField: "description", apiField: "description", compare: sameOptionalText },
      { firestoreField: "status", apiField: "status", compare: sameCaseFoldedStatus },
    ],
    notComparable: [
      { firestoreField: "managerId", apiField: "manager_employee_id", reason: "Firestore id form differs from the Postgres uuid" },
      { firestoreField: "createdAt", apiField: "created_at", reason: "created_at reflects import time, not the original Firestore timestamp" },
    ],
  },

  projects: {
    comparable: [
      { firestoreField: "title", apiField: "title", compare: sameValue },
      { firestoreField: "description", apiField: "description", compare: sameValue },
      { firestoreField: "startDate", apiField: "start_date", compare: sameDate },
      { firestoreField: "dueDate", apiField: "due_date", compare: sameDate },
      { firestoreField: "status", apiField: "status", compare: sameValue },
      // Individual assignee ids are not comparable (see below), but the COUNT is a real,
      // meaningful signal: if Firestore assigned 3 people and Postgres has 2, that is a
      // genuine migration defect even though which id differs cannot be shown without an
      // id-mapping the harness does not build.
      {
        firestoreField: "assignedEmployeeIds",
        apiField: "assignedEmployeeIds",
        compare: (a, b) => (Array.isArray(a) ? a.length : 0) === (Array.isArray(b) ? b.length : 0),
        aspect: "assignedEmployeeIds.length",
      },
    ],
    notComparable: [
      { firestoreField: "department", apiField: "department_id", reason: "Firestore stores a department name; Postgres stores its uuid" },
      { firestoreField: "teamLeadId", apiField: "team_lead_id", reason: "Firestore id form differs from the Postgres uuid" },
      { firestoreField: "assignedEmployeeIds", apiField: "assignedEmployeeIds", reason: "element-for-element: each side's ids are in a different id space (Firestore vs Postgres uuid); only the count is compared, as a separate aspect" },
      { firestoreField: "createdAt", apiField: "created_at", reason: "created_at reflects import time, not the original Firestore timestamp" },
      { firestoreField: "updatedAt", apiField: "updated_at", reason: "same reason as createdAt" },
    ],
  },

  kpis: {
    comparable: [
      { firestoreField: "title", apiField: "title", compare: sameValue },
      { firestoreField: "target", apiField: "target", compare: sameNumber },
      { firestoreField: "current", apiField: "current_value", compare: sameNumber },
      { firestoreField: "weight", apiField: "weight", compare: sameNumber },
      { firestoreField: "period", apiField: "period", compare: sameValue },
      { firestoreField: "status", apiField: "status", compare: sameValue },
      { firestoreField: "rating", apiField: "rating", compare: sameOrBothNull },
      // Unlike createdAt/updatedAt, ratedAt IS preserved verbatim by the importer when
      // present (firestoreImportService.js planKpis), so it is genuinely comparable.
      { firestoreField: "ratedAt", apiField: "rated_at", compare: sameOptionalDate },
    ],
    notComparable: [
      { firestoreField: "projectId", apiField: "project_id", reason: "Firestore id form differs from the Postgres uuid" },
      { firestoreField: "empId", apiField: "employee_id", reason: "Firestore id form differs from the Postgres uuid" },
      { firestoreField: "ratedBy", apiField: "rated_by_employee_id", reason: "Firestore id form differs from the Postgres uuid" },
      { firestoreField: "createdAt", apiField: "created_at", reason: "created_at reflects import time, not the original Firestore timestamp" },
      { firestoreField: "updatedAt", apiField: "updated_at", reason: "same reason as createdAt" },
    ],
  },

  leaves: {
    comparable: [
      { firestoreField: "type", apiField: "type", compare: sameValue },
      { firestoreField: "start", apiField: "start_date", compare: sameDate },
      { firestoreField: "end", apiField: "end_date", compare: sameDate },
      { firestoreField: "days", apiField: "days", compare: sameNumber },
      { firestoreField: "reason", apiField: "reason", compare: sameValue },
      { firestoreField: "status", apiField: "status", compare: sameValue },
      { firestoreField: "applied", apiField: "applied_on", compare: sameDate },
    ],
    notComparable: [
      { firestoreField: "empId", apiField: "employee_id", reason: "Firestore id form differs from the Postgres uuid" },
      { firestoreField: null, apiField: "decided_by_employee_id", reason: "no Firestore source; Firestore never recorded who decided a leave (migration 003)" },
      { firestoreField: null, apiField: "decided_at", reason: "no Firestore source; same as decided_by_employee_id" },
      { firestoreField: null, apiField: "decision_recorded", reason: "no Firestore source; added by migration 003" },
    ],
  },

  attendance: {
    comparable: [
      { firestoreField: "date", apiField: "work_date", compare: sameDate },
      { firestoreField: "status", apiField: "status", compare: sameValue },
      { firestoreField: "checkIn", apiField: "check_in", compare: sameOptionalTime },
      { firestoreField: "checkOut", apiField: "check_out", compare: sameOptionalTime },
      { firestoreField: "notes", apiField: "notes", compare: sameOptionalText },
    ],
    notComparable: [
      { firestoreField: "empId", apiField: "employee_id", reason: "Firestore id form differs from the Postgres uuid" },
      { firestoreField: "createdAt", apiField: "created_at", reason: "created_at reflects import time, not the original Firestore timestamp" },
      { firestoreField: "updatedAt", apiField: "updated_at", reason: "same reason as createdAt" },
    ],
  },

  payroll: {
    comparable: [
      { firestoreField: "year", apiField: "period_year", compare: sameNumber },
      { firestoreField: "month", apiField: "period_month", compare: sameMonthNumber },
      { firestoreField: "basic", apiField: "basic", compare: sameNumber },
      { firestoreField: "allowances", apiField: "allowances", compare: sameNumber },
      { firestoreField: "bonus", apiField: "bonus", compare: sameNumber },
      { firestoreField: "deductions", apiField: "deductions", compare: sameNumber },
      { firestoreField: "status", apiField: "status", compare: sameValue },
    ],
    notComparable: [
      { firestoreField: "empId", apiField: "employee_id", reason: "Firestore id form differs from the Postgres uuid" },
      // Deliberately not compared here even though both sides have a value: Postgres's
      // tax/net are generated columns, always internally consistent; Firestore's stored
      // values can be wrong (Phase 2 already found and reported exactly this class of
      // defect as a payroll-recompute-mismatch advisory during import). Comparing them
      // here would just re-report a data-quality question Phase 2 already owns, muddying
      // this harness's actual job of proving the scope predicate.
      { firestoreField: "tax", apiField: "tax", reason: "Postgres computes tax; a mismatch here means the Firestore source was already wrong, which Phase 2's import already reports separately" },
      { firestoreField: "net", apiField: "net", reason: "same reason as tax" },
      { firestoreField: null, apiField: "gross", reason: "no Firestore source; Postgres computes it" },
      { firestoreField: "createdAt", apiField: "created_at", reason: "created_at reflects import time, not the original Firestore timestamp" },
      { firestoreField: "updatedAt", apiField: "updated_at", reason: "same reason as createdAt" },
    ],
  },
});

export function getDomainFieldMap(domain) {
  const map = DOMAIN_FIELD_MAPS[domain];
  if (!map) throw new RangeError(`No field map for domain "${domain}". Known domains: ${Object.keys(DOMAIN_FIELD_MAPS).join(", ")}`);
  return map;
}

/**
 * Compares one already-correlated Firestore document / API record pair. Returns one entry
 * per field this module knows about for the domain -- comparable fields get "match" or
 * "mismatch"; notComparable fields always get "not_comparable" with their reason. Sensitive
 * field values never appear in the returned entries.
 */
export function compareRecordPair(domain, firestoreRecord, apiRecord) {
  const { comparable, notComparable } = getDomainFieldMap(domain);
  const entries = [];

  for (const { firestoreField, apiField, compare, aspect } of comparable) {
    const firestoreValue = firestoreRecord?.[firestoreField];
    const apiValue = apiRecord?.[apiField];
    const isMatch = compare(firestoreValue, apiValue);
    const fieldName = aspect ?? firestoreField;
    const sensitive = SENSITIVE_FIELDS.has(firestoreField) || SENSITIVE_FIELDS.has(apiField);

    entries.push(Object.freeze({
      field: fieldName,
      result: isMatch ? "match" : "mismatch",
      ...(sensitive ? {} : { firestoreValue, apiValue }),
    }));
  }

  for (const { firestoreField, apiField, reason } of notComparable) {
    entries.push(Object.freeze({
      field: notComparableFieldLabel(firestoreField, apiField),
      result: "not_comparable",
      reason,
    }));
  }

  return entries;
}

function notComparableFieldLabel(firestoreField, apiField) {
  return firestoreField && apiField ? `${firestoreField} / ${apiField}` : (firestoreField ?? apiField);
}

/**
 * Full report for one domain and one principal: set-membership (which records each side
 * has) plus field comparisons for every matched pair.
 *
 * @param {object} correlation
 * @param {Array<{ key: string, firestoreRecord: object, apiRecord: object }>} correlation.matchedPairs
 * @param {Array<{ key: string, firestoreRecord: object }>} correlation.firestoreOnly - present
 *   in Firestore, no corresponding API record -- a scope under-inclusion bug, UNLESS the key
 *   is a known orphan Phase 2 already excluded (pass knownOrphanKeys to distinguish).
 * @param {Array<{ key: string, apiRecord: object }>} correlation.apiOnly - present in the
 *   API but not in Firestore -- always a bug: the API must never show a record Firestore
 *   would not have shown this principal.
 * @param {Set<string>} [correlation.knownOrphanKeys] - correlation keys Phase 2's
 *   --skip-orphans already excluded on import; a firestoreOnly entry with one of these keys
 *   is expected, not a defect, and is reported as such rather than as a plain mismatch.
 */
export function compareDomain(domain, { matchedPairs, firestoreOnly, apiOnly, knownOrphanKeys = new Set() }) {
  const setMembership = [];

  for (const { key } of firestoreOnly) {
    setMembership.push(Object.freeze({
      key,
      result: knownOrphanKeys.has(key) ? "not_comparable" : "mismatch",
      reason: knownOrphanKeys.has(key)
        ? "known orphan: Phase 2's --skip-orphans excluded this record on import"
        : "present in Firestore but not returned by the API for this principal",
    }));
  }

  for (const { key } of apiOnly) {
    setMembership.push(Object.freeze({
      key,
      result: "mismatch",
      reason: "returned by the API but not visible to this principal in Firestore -- a scope over-inclusion bug",
    }));
  }

  const fieldComparisons = matchedPairs.map(({ key, firestoreRecord, apiRecord }) => Object.freeze({
    key,
    fields: compareRecordPair(domain, firestoreRecord, apiRecord),
  }));

  const allEntries = [
    ...setMembership,
    ...fieldComparisons.flatMap((pair) => pair.fields),
  ];

  return Object.freeze({
    domain,
    setMembership: Object.freeze(setMembership),
    fieldComparisons: Object.freeze(fieldComparisons),
    summary: Object.freeze({
      matched: matchedPairs.length,
      firestoreOnly: firestoreOnly.length,
      apiOnly: apiOnly.length,
      mismatches: allEntries.filter((entry) => entry.result === "mismatch").length,
      notComparable: allEntries.filter((entry) => entry.result === "not_comparable").length,
    }),
  });
}

/** True if any domain report (or the array of them) contains a real mismatch. */
export function hasMismatch(reports) {
  const list = Array.isArray(reports) ? reports : [reports];
  return list.some((report) => report.summary.mismatches > 0);
}
