import { readFile } from "node:fs/promises";
import { closePool, getPool } from "../src/db/pool.js";
import { planImport } from "../src/services/firestoreImportService.js";
import { createFirestoreImportRepository } from "../src/repositories/firestoreImportRepository.js";

/**
 * Dry-run by default, exactly like db:rollback and functions/canonicalRelationshipMigration.js.
 *
 *   node scripts/import-firestore.js --input=export.json
 *   node scripts/import-firestore.js --input=export.json --apply --confirm-database=sigma_hrm_scratch
 *
 * See docs/migration-plan.md Phase 2 for what this does and why, and the module docstring
 * on services/firestoreImportService.js for the exact input shape.
 *
 * --skip-orphans downgrades missing-employee-reference (a kpi/leave/attendance/payroll
 * record whose empId points at an employee no longer in Firestore) from a blocking
 * conflict to a reported skip. Off by default -- omitting the flag leaves that category
 * blocking, exactly as before. It has no effect on any other conflict category:
 * missing-department-reference, the authLinks bijection checks, and
 * department-manager-wrong-department all still block regardless of this flag.
 *
 *   node scripts/import-firestore.js --input=export.json --skip-orphans
 */

function parseArgs(argv) {
  const flags = { apply: false, skipOrphans: false };
  for (const argument of argv) {
    if (argument === "--apply") flags.apply = true;
    else if (argument === "--skip-orphans") flags.skipOrphans = true;
    else if (argument.startsWith("--input=")) flags.input = argument.slice("--input=".length);
    else if (argument.startsWith("--confirm-database=")) flags.confirmDatabase = argument.slice("--confirm-database=".length);
    else if (argument.startsWith("--company-name=")) flags.companyName = argument.slice("--company-name=".length);
    else if (argument.startsWith("--company-code=")) flags.companyCode = argument.slice("--company-code=".length);
  }
  return flags;
}

function printSummary(plan) {
  console.info(`Documents scanned: ${plan.totals.documents}`);
  console.info(`Rows to write: companies ${plan.steps.companies.length}, departments ${plan.steps.departments.length}, `
    + `users ${plan.steps.users.length}, employees ${plan.steps.employees.length}, `
    + `projects ${plan.steps.projects.length}, project_assignments ${plan.steps.projectAssignments.length}, `
    + `kpis ${plan.steps.kpis.length}, leaves ${plan.steps.leaves.length}, `
    + `attendance ${plan.steps.attendance.length}, payroll ${plan.steps.payroll.length}`);

  if (plan.totals.leaveDecisionsWithoutApprover > 0) {
    console.info(
      `${plan.totals.leaveDecisionsWithoutApprover} decided leave(s) have no recorded approver `
      + "(Firestore never tracked one) and will import with decision_recorded = false.",
    );
  }

  if (plan.skippedOrphans.length > 0) {
    console.info(`\n${plan.skippedOrphans.length} orphaned record(s) skipped (--skip-orphans): `
      + "empId points at an employee no longer in Firestore.");

    const byCollection = new Map();
    const byEmpId = new Map();
    for (const orphan of plan.skippedOrphans) {
      byCollection.set(orphan.collection, (byCollection.get(orphan.collection) ?? 0) + 1);
      const empIdKey = String(orphan.empId);
      byEmpId.set(empIdKey, (byEmpId.get(empIdKey) ?? 0) + 1);
    }

    console.info(`  by collection: ${[...byCollection].map(([collection, count]) => `${collection}=${count}`).join(", ")}`);
    console.info(`  by missing empId (${byEmpId.size} distinct): `
      + `${[...byEmpId].map(([empId, count]) => `${empId}=${count}`).join(", ")}`);
  }

  if (plan.advisories.length > 0) {
    console.info(`\n${plan.advisories.length} advisory(ies) -- reported, do not block --apply:`);
    for (const advisory of plan.advisories) {
      console.info(`  [${advisory.category}] ${advisory.collection}/${advisory.documentId}: ${JSON.stringify(advisory.detail)}`);
    }
  }

  if (plan.conflicts.length > 0) {
    console.info(`\n${plan.conflicts.length} conflict(s) -- MUST be resolved before --apply:`);
    const byCategory = new Map();
    for (const conflict of plan.conflicts) {
      if (!byCategory.has(conflict.category)) byCategory.set(conflict.category, []);
      byCategory.get(conflict.category).push(conflict);
    }
    for (const [category, conflicts] of byCategory) {
      console.info(`  ${category}: ${conflicts.length}`);
      for (const conflict of conflicts.slice(0, 10)) {
        console.info(`    ${conflict.collection}/${conflict.documentId ?? "?"}${conflict.field ? ` (${conflict.field})` : ""}`);
      }
    }
    if (byCategory.has("missing-employee-reference")) {
      console.info(
        `  (${byCategory.get("missing-employee-reference").length} of these are missing-employee-reference -- `
        + "re-run with --skip-orphans to skip them instead of blocking.)",
      );
    }
  } else {
    console.info("\nNo conflicts.");
  }
}

const flags = parseArgs(process.argv.slice(2));

if (!flags.input) {
  console.error("Usage: node scripts/import-firestore.js --input=<path> [--apply --confirm-database=<name>] [--skip-orphans] [--company-name=] [--company-code=]");
  process.exitCode = 1;
} else if (process.env.NODE_ENV === "production" && flags.apply) {
  console.error("Refusing to apply with NODE_ENV=production.");
  process.exitCode = 1;
} else {
  const raw = await readFile(flags.input, "utf8");
  const dataset = JSON.parse(raw);
  const plan = planImport(dataset, {
    companyName: flags.companyName,
    companyCode: flags.companyCode,
    skipOrphans: flags.skipOrphans,
  });

  printSummary(plan);

  if (!flags.apply) {
    console.info("\nDry run only. Pass --apply --confirm-database=<name> to write.");
  } else if (plan.conflicts.length > 0) {
    console.error(`\nRefusing to apply: ${plan.conflicts.length} unresolved conflict(s).`);
    process.exitCode = 1;
  } else {
    const pool = getPool();
    try {
      const { rows: [{ current_database: currentDatabase }] } = await pool.query("SELECT current_database()");
      if (!flags.confirmDatabase) {
        console.error(`Refusing to apply: pass --confirm-database=${currentDatabase} to confirm the target.`);
        process.exitCode = 1;
      } else if (flags.confirmDatabase !== currentDatabase) {
        console.error(`Refusing to apply: connected to "${currentDatabase}" but "${flags.confirmDatabase}" was confirmed.`);
        process.exitCode = 1;
      } else {
        const repository = createFirestoreImportRepository(pool);
        await repository.apply(plan);
        console.info(`\nApplied to "${currentDatabase}".`);
      }
    } finally {
      await closePool();
    }
  }
}
