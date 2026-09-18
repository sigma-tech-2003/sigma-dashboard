/**
 * Reads exactly the eight Firestore collections backend/src/services/firestoreImportService.js
 * expects and writes them to one JSON file in the importer's input contract: one array per
 * collection, each entry { id, data }. See that file's module docstring for the full shape.
 *
 * This script is read-only. It never writes, updates, or deletes anything in Firestore --
 * every call below is a `.get()`. leaveBalances is deliberately not read: the importer's
 * COLLECTIONS list (imported from firestoreImportService.js, not duplicated here) excludes
 * it, since that collection was dropped per decision.
 *
 * ---------------------------------------------------------------------------------------
 * Setup (once, in your own terminal -- this script must not be run by an AI assistant):
 *
 *   gcloud auth application-default login
 *
 * This opens a browser sign-in and stores short-lived Application Default Credentials
 * under your own Google identity. No key file is downloaded and nothing is written to this
 * repository. The signed-in account needs Firestore read access on the target project --
 * roles/datastore.viewer is sufficient; broader roles like Owner/Editor also work but are
 * more than this script needs.
 *
 * Run the export:
 *
 *   node scripts/export-firestore.js --project=<firebase-project-id>
 *   node scripts/export-firestore.js --project=<firebase-project-id> --output=exports/my-export.json
 *
 * If --output is omitted, the file is written to exports/firestore-export.json (relative to
 * backend/), which backend/.gitignore excludes by directory. A custom --output path is NOT
 * automatically safe -- this script warns if the resolved path is not git-ignored, but you
 * are responsible for never committing a path outside the default location.
 *
 * When you are done (revokes the ADC session; safe to run even if you plan to export again
 * later, since step 1 just creates a new session):
 *
 *   gcloud auth application-default revoke
 * ---------------------------------------------------------------------------------------
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../src/services/firestoreImportService.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultOutputPath = path.join(scriptDirectory, "..", "exports", "firestore-export.json");

function parseArgs(argv) {
  const flags = {};
  for (const argument of argv) {
    if (argument.startsWith("--project=")) flags.project = argument.slice("--project=".length);
    else if (argument.startsWith("--output=")) flags.output = argument.slice("--output=".length);
  }
  return flags;
}

/**
 * Firestore's Admin SDK returns native Timestamp/GeoPoint/DocumentReference instances for
 * those field types. Nothing in this codebase's Firestore writes ever produced one --
 * every createdAt/updatedAt is a plain ISO string written by application code (confirmed
 * by grepping functions/ for serverTimestamp/FieldValue/Timestamp: zero matches) -- but this
 * export runs once against real production data with no chance to fix a bad assumption
 * afterward, so unexpected values are converted defensively rather than trusted to
 * JSON.stringify correctly, and a warning names exactly where.
 */
function sanitizeValue(value, warnings, fieldPath) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item, index) => sanitizeValue(item, warnings, `${fieldPath}[${index}]`));

  if (typeof value === "object") {
    if (typeof value.toDate === "function") {
      warnings.add(`${fieldPath}: Firestore Timestamp converted to an ISO string`);
      return value.toDate().toISOString();
    }
    if (typeof value.latitude === "number" && typeof value.longitude === "number" && Object.keys(value).length <= 2) {
      warnings.add(`${fieldPath}: Firestore GeoPoint converted to a plain {latitude, longitude} object`);
      return { latitude: value.latitude, longitude: value.longitude };
    }
    if (typeof value.path === "string" && typeof value.id === "string" && typeof value.firestore === "object") {
      warnings.add(`${fieldPath}: Firestore DocumentReference converted to its path string`);
      return value.path;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const sanitized = {};
      for (const [key, item] of Object.entries(value)) {
        sanitized[key] = sanitizeValue(item, warnings, `${fieldPath}.${key}`);
      }
      return sanitized;
    }
  }

  return value;
}

async function exportCollection(firestore, collectionName, warnings) {
  const snapshot = await firestore.collection(collectionName).get();
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    data: sanitizeValue(doc.data(), warnings, `${collectionName}/${doc.id}`),
  }));
}

function checkGitIgnored(outputPath) {
  try {
    execFileSync("git", ["check-ignore", "-q", outputPath], { cwd: scriptDirectory, stdio: "ignore" });
    return true;
  } catch (error) {
    // Exit code 1 means "not ignored"; anything else (git missing, not a repo) is
    // inconclusive, not a confirmed problem, so it is reported separately below.
    return error.status === 1 ? false : null;
  }
}

const flags = parseArgs(process.argv.slice(2));

if (!flags.project) {
  console.error("Usage: node scripts/export-firestore.js --project=<firebase-project-id> [--output=<path>]");
  process.exitCode = 1;
} else {
  const outputPath = path.resolve(scriptDirectory, "..", flags.output ?? defaultOutputPath);

  const ignored = checkGitIgnored(outputPath);
  if (ignored === false) {
    console.error(`Refusing to export: "${outputPath}" is not covered by .gitignore. Choose a path under exports/, or add one.`);
    process.exit(1);
  }
  if (ignored === null) {
    console.warn(`Could not confirm "${outputPath}" is git-ignored (git unavailable or not a repository). Proceeding, but verify this yourself before doing anything else with the file.`);
  }

  console.info(`Project:     ${flags.project}`);
  console.info(`Output file: ${outputPath}`);
  console.info(`Collections: ${COLLECTIONS.join(", ")}`);
  console.info("Read-only. No Firestore document will be created, updated, or deleted.\n");

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: flags.project });
  }
  const firestore = getFirestore();

  const warnings = new Set();
  const dataset = {};
  const counts = {};

  for (const collectionName of COLLECTIONS) {
    dataset[collectionName] = await exportCollection(firestore, collectionName, warnings);
    counts[collectionName] = dataset[collectionName].length;
    console.info(`${collectionName.padEnd(12)} ${counts[collectionName]}`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(dataset, null, 2), "utf8");

  const totalDocuments = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.info(`\nWrote ${totalDocuments} documents across ${COLLECTIONS.length} collections to ${outputPath}`);

  if (warnings.size > 0) {
    console.info(`\n${warnings.size} field(s) needed conversion -- review before trusting the export:`);
    for (const warning of warnings) console.info(`  ${warning}`);
  }

  console.info("\nWhen you are done with this export, revoke the credentials used to produce it:");
  console.info("  gcloud auth application-default revoke");
}
