/**
 * Phase 3 parity harness: for one real employee, compares what Firestore's current data
 * says they should see against what the Postgres-backed API actually returns them, across
 * all seven read domains. See docs/migration-plan.md Phase 3 and src/services/
 * parityService.js's module docstring for the comparison rules this reports against.
 *
 * Read-only on both sides. Firestore is only ever `.get()` (see scripts/export-firestore.js,
 * which makes the same guarantee). Postgres is only ever queried with SELECT, and the app is
 * started in-process purely to serve the seven GET endpoints under test -- nothing here ever
 * writes a row.
 *
 * Ground truth for "what should be visible" is computed independently of the API under test:
 * it re-derives visibility from Firestore's own current raw fields (department names,
 * teamLeadId, assignedEmployeeIds, empId) via services/firestoreImportService.js's own
 * planImport(), the same resolution logic that populated Postgres in the first place. That
 * makes this a genuine cross-check of "does the live API reproduce what a correct import of
 * Firestore's CURRENT data would justify" -- not a self-consistency check of Postgres against
 * itself. A record that fails the importer's own validation (and so was never a candidate for
 * import) is correctly never "expected" either.
 *
 * Correlation across the two id spaces, per docs/migration-plan.md Phase 2:
 *   - employees   by email (case-insensitive)
 *   - departments by name (case-insensitive)
 *   - projects, kpis, leaves: via the firestore_import_refs bookkeeping table (migration 004).
 *     Leaves has no natural key of its own -- see firestoreImportRepository.js's insertLeave,
 *     "leaves have no natural key; once imported, never re-written" -- so it also goes
 *     through firestore_import_refs, not a natural key, despite having row-shaped data.
 *   - attendance, payroll: by (employee, work_date) / (employee, period_year, period_month),
 *     bridging the employee id space via the same email correlation built for the employees
 *     domain (an attendance/payroll record's owner is only resolvable to a Postgres id if
 *     that owner was itself found visible-and-matched in the employees domain -- if not, the
 *     record correctly reports as unresolved rather than guessed).
 *
 * "If the harness cannot tell two shapes apart, say so rather than reporting a false match":
 * every field comparison enforces that already (parityService.js); this file's own
 * additional promise is that no report ever contains a raw salary, phone number, or name --
 * see printDomainReport below. Firestore/Postgres document and row ids are printed freely;
 * they are opaque identifiers, not personal data.
 *
 * Exits non-zero if any domain reports a mismatch.
 *
 * ---------------------------------------------------------------------------------------
 * Usage (ADC login and --confirm-database as for scripts/export-firestore.js and db:rollback):
 *
 *   node scripts/parity-harness.js --project=<firebase-project-id> \
 *     --principal=<employee-email> --confirm-database=sigma_hrm_scratch
 *
 * Run it once per role you want to verify, pointing --principal at a real employee of that
 * role. Do not revoke the ADC session between runs -- see the credentials note already given
 * for this harness; only revoke once Phase 3 verification is fully done.
 * ---------------------------------------------------------------------------------------
 */

import { createServer } from "node:http";
import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createApp } from "../src/app.js";
import { getAuthConfig } from "../src/config/env.js";
import { closePool, getPool } from "../src/db/pool.js";
import { COLLECTIONS, planImport } from "../src/services/firestoreImportService.js";
import { compareDomain, getDomainFieldMap, hasMismatch } from "../src/services/parityService.js";
import { createTokenService } from "../src/services/tokenService.js";
import { COMPANY_WIDE_ROLES, DEPARTMENT_SCOPED_ROLES, TEAM_SCOPED_ROLES } from "../src/utils/roles.js";

const BOOKKEEPING_COLLECTIONS = Object.freeze(["projects", "kpis", "leaves"]);

function parseArgs(argv) {
  const flags = {};
  for (const argument of argv) {
    if (argument.startsWith("--project=")) flags.project = argument.slice("--project=".length);
    else if (argument.startsWith("--principal=")) flags.principal = argument.slice("--principal=".length);
    else if (argument.startsWith("--confirm-database=")) flags.confirmDatabase = argument.slice("--confirm-database=".length);
  }
  return flags;
}

async function fetchCollection(firestore, collectionName) {
  const snapshot = await firestore.collection(collectionName).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
}

/** Index of {id, data} entries by id, for pulling the raw record once a plan row's sourceId matches. */
function indexById(documents) {
  return new Map(documents.map((document) => [document.id, document.data]));
}

/**
 * Shared shape for every domain's correlation: entries already known to be Firestore-visible
 * to this principal, each carrying the join key to look up its Postgres counterpart (or null
 * if it cannot be resolved at all, which is itself reported as firestoreOnly).
 */
function diffCorrelation(expectedEntries, apiByMatchKey) {
  const matchedPairs = [];
  const firestoreOnly = [];
  const consumedMatchKeys = new Set();
  for (const entry of expectedEntries) {
    const apiRecord = entry.matchKey != null ? apiByMatchKey.get(entry.matchKey) : undefined;
    if (apiRecord) {
      matchedPairs.push({ key: entry.reportKey, firestoreRecord: entry.firestoreRecord, apiRecord });
      consumedMatchKeys.add(entry.matchKey);
    } else {
      firestoreOnly.push({ key: entry.reportKey });
    }
  }
  return { matchedPairs, firestoreOnly, consumedMatchKeys };
}

function apiOnlyEntries(apiRows, apiMatchKeyOf, consumedMatchKeys) {
  return apiRows
    .filter((row) => {
      const key = apiMatchKeyOf(row);
      return key == null || !consumedMatchKeys.has(key);
    })
    .map((row) => ({ key: row.id }));
}

function notComparableLabel({ firestoreField, apiField }) {
  return firestoreField && apiField ? `${firestoreField}/${apiField}` : (firestoreField ?? apiField);
}

/**
 * Never prints a comparable value for a field parityService marks sensitive -- that guarantee
 * is enforced at the source (compareRecordPair omits firestoreValue/apiValue entirely for
 * those fields), so this only has to avoid inventing its own extra print path around it.
 */
function printDomainReport(report) {
  const { domain, setMembership, fieldComparisons, summary } = report;
  console.info(`\n=== ${domain} ===`);
  console.info(`  matched=${summary.matched} firestoreOnly=${summary.firestoreOnly} apiOnly=${summary.apiOnly} mismatches=${summary.mismatches} notComparable=${summary.notComparable}`);

  const { notComparable } = getDomainFieldMap(domain);
  if (notComparable.length > 0) {
    console.info(`  not compared by design: ${notComparable.map(notComparableLabel).join(", ")}`);
  }

  for (const entry of setMembership) {
    const tag = entry.result === "mismatch" ? "MISMATCH" : "expected";
    console.info(`  [${tag}] record ${entry.key}: ${entry.reason}`);
  }

  const fieldMismatches = fieldComparisons.flatMap((pair) =>
    pair.fields
      .filter((field) => field.result === "mismatch")
      .map((field) => ({ key: pair.key, ...field })));

  for (const mismatch of fieldMismatches) {
    const values = "firestoreValue" in mismatch
      ? ` firestore=${JSON.stringify(mismatch.firestoreValue)} api=${JSON.stringify(mismatch.apiValue)}`
      : "";
    console.info(`  [MISMATCH] record ${mismatch.key} field ${mismatch.field}${values}`);
  }

  if (summary.matched > 0 && fieldMismatches.length === 0) {
    console.info(`  all ${summary.matched} matched record(s) agree on every comparable field.`);
  }
}

async function main(flags) {
  const pool = getPool();
  const { rows: [{ current_database: currentDatabase }] } = await pool.query("SELECT current_database()");
  if (!flags.confirmDatabase) {
    throw new Error(`Refusing to run: pass --confirm-database=${currentDatabase} to confirm the target.`);
  }
  if (flags.confirmDatabase !== currentDatabase) {
    throw new Error(`Refusing to run: connected to "${currentDatabase}" but "${flags.confirmDatabase}" was confirmed.`);
  }

  const principalEmail = flags.principal.trim().toLowerCase();
  const { rows: [postgresUser] } = await pool.query(
    "SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL",
    [principalEmail],
  );
  if (!postgresUser) {
    throw new Error(`No active Postgres user found for principal "${flags.principal}".`);
  }

  console.info(`Project:  ${flags.project}`);
  console.info(`Database: ${currentDatabase}`);
  console.info("Reading Firestore (read-only)...");

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: flags.project });
  }
  const firestore = getFirestore();

  const firestoreDataset = {};
  for (const collectionName of COLLECTIONS.filter((name) => name !== "authLinks")) {
    firestoreDataset[collectionName] = await fetchCollection(firestore, collectionName);
  }

  const rawById = Object.fromEntries(
    Object.entries(firestoreDataset).map(([collectionName, documents]) => [collectionName, indexById(documents)]),
  );

  console.info("Planning import against current Firestore data (dry run -- no writes)...");
  // skipOrphans: true so a missing-employee-reference is classified, not left blocking --
  // this harness never applies the plan, it only reads plan.steps and plan.skippedOrphans.
  const plan = planImport(firestoreDataset, { skipOrphans: true });

  const emailByUserKey = new Map(plan.steps.users.map((user) => [user.key, user.fields.email]));
  const principalPlanEmployee = plan.steps.employees.find(
    (employee) => (emailByUserKey.get(employee.refs.userKey) ?? "").toLowerCase() === principalEmail,
  );
  if (!principalPlanEmployee) {
    const rawPrincipalDoc = firestoreDataset.employees.find(
      (document) => (document.data.email ?? "").trim().toLowerCase() === principalEmail,
    );
    if (!rawPrincipalDoc) {
      throw new Error(`No Firestore employee document found with email "${flags.principal}".`);
    }
    const conflictCategories = plan.conflicts
      .filter((conflict) => conflict.documentId === rawPrincipalDoc.id)
      .map((conflict) => conflict.category);
    throw new Error(
      `The Firestore employee document for "${flags.principal}" did not pass import validation `
      + `(categories: ${conflictCategories.join(", ") || "unknown"}) -- it would never have reached Postgres.`,
    );
  }
  const principalUserPlanRow = plan.steps.users.find((user) => user.key === principalPlanEmployee.refs.userKey);
  const firestorePrincipal = {
    role: principalUserPlanRow.fields.role,
    employeeKey: principalPlanEmployee.key,
    departmentSourceId: principalPlanEmployee.refs.departmentId,
  };
  console.info(`Principal: ${flags.principal} (Firestore role: ${firestorePrincipal.role})`);

  const employeeByKey = new Map(plan.steps.employees.map((row) => [row.key, row]));

  function employeeVisible(row) {
    if (COMPANY_WIDE_ROLES.has(firestorePrincipal.role)) return true;
    if (DEPARTMENT_SCOPED_ROLES.has(firestorePrincipal.role)) {
      return row.refs.departmentId === firestorePrincipal.departmentSourceId;
    }
    if (TEAM_SCOPED_ROLES.has(firestorePrincipal.role)) {
      return row.key === firestorePrincipal.employeeKey || row.refs.teamLeadKey === firestorePrincipal.employeeKey;
    }
    if (firestorePrincipal.role === "employee") return row.key === firestorePrincipal.employeeKey;
    return false;
  }

  function projectVisible(row) {
    if (COMPANY_WIDE_ROLES.has(firestorePrincipal.role)) return true;
    if (DEPARTMENT_SCOPED_ROLES.has(firestorePrincipal.role)) {
      return row.refs.departmentId === firestorePrincipal.departmentSourceId;
    }
    if (TEAM_SCOPED_ROLES.has(firestorePrincipal.role)) {
      if (row.refs.teamLeadKey === firestorePrincipal.employeeKey) return true;
      return row.refs.assignedEmployeeKeys.some(
        (employeeKey) => employeeByKey.get(employeeKey)?.refs.teamLeadKey === firestorePrincipal.employeeKey,
      );
    }
    if (firestorePrincipal.role === "employee") {
      return row.refs.assignedEmployeeKeys.includes(firestorePrincipal.employeeKey);
    }
    return false;
  }

  function joinedVisible(row) {
    const owner = employeeByKey.get(row.refs.employeeKey);
    return owner ? employeeVisible(owner) : false;
  }

  function payrollVisible(row) {
    if (COMPANY_WIDE_ROLES.has(firestorePrincipal.role)) return true;
    if (firestorePrincipal.role === "employee") {
      return row.refs.employeeKey === firestorePrincipal.employeeKey && row.fields.status === "processed";
    }
    return false; // manager, tl: denied -- see buildPayrollScopeFilter
  }

  const departmentsVisible = COMPANY_WIDE_ROLES.has(firestorePrincipal.role);

  const { rows: bookkeepingRows } = await pool.query(
    "SELECT source_collection, source_id, target_id FROM firestore_import_refs WHERE source_collection = ANY($1)",
    [BOOKKEEPING_COLLECTIONS],
  );
  const bookkeepingMap = new Map(
    bookkeepingRows.map((row) => [`${row.source_collection}:${row.source_id}`, row.target_id]),
  );

  console.info("Starting the app in-process and minting a scoped access token...");
  const app = createApp();
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const accessToken = createTokenService(getAuthConfig()).issueAccessToken(postgresUser.id);

  async function fetchDomain(pathname) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`${pathname} responded ${response.status} -- expected 200 for this principal.`);
    }
    const body = await response.json();
    return body.data;
  }

  console.info("Querying the seven API domains...\n");
  const [apiEmployees, apiDepartments, apiProjects, apiKpis, apiLeaves, apiAttendance, apiPayroll] = await Promise.all([
    fetchDomain("/api/v1/employees"),
    fetchDomain("/api/v1/departments"),
    fetchDomain("/api/v1/projects"),
    fetchDomain("/api/v1/kpis"),
    fetchDomain("/api/v1/leaves"),
    fetchDomain("/api/v1/attendance"),
    fetchDomain("/api/v1/payroll"),
  ]);

  await new Promise((resolve) => server.close(resolve));

  const orphanKeysFor = (collection) => new Set(
    plan.skippedOrphans.filter((orphan) => orphan.collection === collection).map((orphan) => orphan.documentId),
  );

  // --- employees ---------------------------------------------------------
  const apiEmployeesByEmail = new Map(apiEmployees.map((row) => [String(row.email ?? "").toLowerCase(), row]));
  const expectedEmployeeEntries = plan.steps.employees
    .filter(employeeVisible)
    .map((row) => ({
      reportKey: row.sourceId,
      matchKey: (emailByUserKey.get(row.refs.userKey) ?? "").toLowerCase() || null,
      firestoreRecord: rawById.employees.get(row.sourceId),
      planRow: row,
    }));
  const employeeDiff = diffCorrelation(expectedEmployeeEntries, apiEmployeesByEmail);
  const employeesReport = compareDomain("employees", {
    matchedPairs: employeeDiff.matchedPairs,
    firestoreOnly: employeeDiff.firestoreOnly,
    apiOnly: apiOnlyEntries(apiEmployees, (row) => String(row.email ?? "").toLowerCase(), employeeDiff.consumedMatchKeys),
  });

  // Bridge for attendance/payroll: only employees this principal can see AND that were
  // actually found in the API are usable to resolve another record's owner to a Postgres id.
  const employeeKeyToPostgresId = new Map();
  for (const entry of expectedEmployeeEntries) {
    if (entry.matchKey && apiEmployeesByEmail.has(entry.matchKey)) {
      employeeKeyToPostgresId.set(entry.planRow.key, apiEmployeesByEmail.get(entry.matchKey).id);
    }
  }

  // --- departments ---------------------------------------------------------
  const apiDepartmentsByName = new Map(apiDepartments.map((row) => [String(row.name ?? "").trim().toLowerCase(), row]));
  const expectedDepartmentEntries = (departmentsVisible ? plan.steps.departments : []).map((row) => ({
    reportKey: row.sourceId,
    matchKey: row.fields.name.trim().toLowerCase(),
    firestoreRecord: rawById.departments.get(row.sourceId),
  }));
  const departmentDiff = diffCorrelation(expectedDepartmentEntries, apiDepartmentsByName);
  const departmentsReport = compareDomain("departments", {
    matchedPairs: departmentDiff.matchedPairs,
    firestoreOnly: departmentDiff.firestoreOnly,
    apiOnly: apiOnlyEntries(apiDepartments, (row) => String(row.name ?? "").trim().toLowerCase(), departmentDiff.consumedMatchKeys),
  });

  // --- projects / kpis / leaves (bookkeeping-correlated) ---------------------------------
  function bookkeepingEntries(collection, planRows, visible) {
    return planRows.filter(visible).map((row) => ({
      reportKey: row.sourceId,
      matchKey: bookkeepingMap.get(`${collection}:${row.sourceId}`) ?? null,
      firestoreRecord: rawById[collection].get(row.sourceId),
    }));
  }

  const apiProjectsById = new Map(apiProjects.map((row) => [row.id, row]));
  const projectDiff = diffCorrelation(bookkeepingEntries("projects", plan.steps.projects, projectVisible), apiProjectsById);
  const projectsReport = compareDomain("projects", {
    matchedPairs: projectDiff.matchedPairs,
    firestoreOnly: projectDiff.firestoreOnly,
    apiOnly: apiOnlyEntries(apiProjects, (row) => row.id, projectDiff.consumedMatchKeys),
  });

  const apiKpisById = new Map(apiKpis.map((row) => [row.id, row]));
  const kpiDiff = diffCorrelation(bookkeepingEntries("kpis", plan.steps.kpis, joinedVisible), apiKpisById);
  const kpisReport = compareDomain("kpis", {
    matchedPairs: kpiDiff.matchedPairs,
    firestoreOnly: kpiDiff.firestoreOnly,
    apiOnly: apiOnlyEntries(apiKpis, (row) => row.id, kpiDiff.consumedMatchKeys),
    knownOrphanKeys: orphanKeysFor("kpis"),
  });

  const apiLeavesById = new Map(apiLeaves.map((row) => [row.id, row]));
  const leaveDiff = diffCorrelation(bookkeepingEntries("leaves", plan.steps.leaves, joinedVisible), apiLeavesById);
  const leavesReport = compareDomain("leaves", {
    matchedPairs: leaveDiff.matchedPairs,
    firestoreOnly: leaveDiff.firestoreOnly,
    apiOnly: apiOnlyEntries(apiLeaves, (row) => row.id, leaveDiff.consumedMatchKeys),
    knownOrphanKeys: orphanKeysFor("leaves"),
  });

  // --- attendance / payroll (natural key, bridged through the employee correlation) -------
  const apiAttendanceByKey = new Map(
    apiAttendance.map((row) => [`${row.employee_id}|${String(row.work_date).slice(0, 10)}`, row]),
  );
  const expectedAttendanceEntries = plan.steps.attendance.filter(joinedVisible).map((row) => {
    const postgresEmployeeId = employeeKeyToPostgresId.get(row.refs.employeeKey);
    return {
      reportKey: row.sourceId,
      matchKey: postgresEmployeeId ? `${postgresEmployeeId}|${String(row.fields.work_date).slice(0, 10)}` : null,
      firestoreRecord: rawById.attendance.get(row.sourceId),
    };
  });
  const attendanceDiff = diffCorrelation(expectedAttendanceEntries, apiAttendanceByKey);
  const attendanceReport = compareDomain("attendance", {
    matchedPairs: attendanceDiff.matchedPairs,
    firestoreOnly: attendanceDiff.firestoreOnly,
    apiOnly: apiOnlyEntries(
      apiAttendance,
      (row) => `${row.employee_id}|${String(row.work_date).slice(0, 10)}`,
      attendanceDiff.consumedMatchKeys,
    ),
    knownOrphanKeys: orphanKeysFor("attendance"),
  });

  const apiPayrollByKey = new Map(
    apiPayroll.map((row) => [`${row.employee_id}|${row.period_year}|${row.period_month}`, row]),
  );
  const expectedPayrollEntries = plan.steps.payroll.filter(payrollVisible).map((row) => {
    const postgresEmployeeId = employeeKeyToPostgresId.get(row.refs.employeeKey);
    return {
      reportKey: row.sourceId,
      matchKey: postgresEmployeeId ? `${postgresEmployeeId}|${row.fields.period_year}|${row.fields.period_month}` : null,
      firestoreRecord: rawById.payroll.get(row.sourceId),
    };
  });
  const payrollDiff = diffCorrelation(expectedPayrollEntries, apiPayrollByKey);
  const payrollReport = compareDomain("payroll", {
    matchedPairs: payrollDiff.matchedPairs,
    firestoreOnly: payrollDiff.firestoreOnly,
    apiOnly: apiOnlyEntries(
      apiPayroll,
      (row) => `${row.employee_id}|${row.period_year}|${row.period_month}`,
      payrollDiff.consumedMatchKeys,
    ),
    knownOrphanKeys: orphanKeysFor("payroll"),
  });

  const allReports = [employeesReport, departmentsReport, projectsReport, kpisReport, leavesReport, attendanceReport, payrollReport];
  for (const report of allReports) printDomainReport(report);

  const mismatched = hasMismatch(allReports);
  console.info(`\n${mismatched ? "MISMATCHES FOUND -- see above." : "All domains match for this principal."}`);
  process.exitCode = mismatched ? 1 : 0;
}

const flags = parseArgs(process.argv.slice(2));

if (!flags.project || !flags.principal) {
  console.error("Usage: node scripts/parity-harness.js --project=<firebase-project-id> --principal=<employee-email> --confirm-database=<name>");
  process.exitCode = 1;
} else {
  try {
    await main(flags);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
