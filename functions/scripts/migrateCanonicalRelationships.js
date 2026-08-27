#!/usr/bin/env node
/* global module, require, process */
"use strict";

const {
  CanonicalRelationshipMigrationError,
  createCanonicalRelationshipMigration,
  valuesEqual,
} = require("../canonicalRelationshipMigration");

function cliError(code, message) {
  return new CanonicalRelationshipMigrationError(code, message);
}

function parseCliArguments(argv) {
  const result = { apply: false, confirmProjectId: null, target: null };
  const seen = new Set();
  for (const argument of argv) {
    if (argument === "--apply") {
      if (seen.has("apply")) throw cliError("invalid-arguments", "Duplicate migration flags are not allowed.");
      seen.add("apply");
      result.apply = true;
      continue;
    }
    if (argument.startsWith("--confirm-project=")) {
      if (seen.has("confirm")) throw cliError("invalid-arguments", "Duplicate migration flags are not allowed.");
      seen.add("confirm");
      result.confirmProjectId = argument.slice("--confirm-project=".length).trim();
      if (!result.confirmProjectId) throw cliError("invalid-arguments", "Project confirmation is required.");
      continue;
    }
    if (argument.startsWith("--target=")) {
      if (seen.has("target")) throw cliError("invalid-arguments", "Duplicate migration flags are not allowed.");
      seen.add("target");
      result.target = argument.slice("--target=".length).trim();
      if (!["production", "emulator"].includes(result.target)) {
        throw cliError("ambiguous-target", "Specify exactly one valid migration target.");
      }
      continue;
    }
    throw cliError("invalid-arguments", "An unsupported migration argument was supplied.");
  }
  if (!result.target) throw cliError("ambiguous-target", "Specify the migration target explicitly.");
  if (result.apply && !result.confirmProjectId) {
    throw cliError("confirmation-required", "Exact project confirmation is required before applying.");
  }
  if (!result.apply && result.confirmProjectId) {
    throw cliError("invalid-arguments", "Project confirmation is accepted only with --apply.");
  }
  return Object.freeze(result);
}

function versionsEqual(left, right) {
  if (left === right) return true;
  if (left && typeof left.isEqual === "function") {
    try {
      return left.isEqual(right);
    } catch {
      return false;
    }
  }
  if (right && typeof right.isEqual === "function") {
    try {
      return right.isEqual(left);
    } catch {
      return false;
    }
  }
  return false;
}

function preconditionFailure() {
  const error = new Error("Migration precondition failed.");
  error.code = "precondition-failed";
  return error;
}

function snapshotData(snapshot) {
  return snapshot && snapshot.exists ? snapshot.data() : null;
}

function updateAlreadyApplied(data, changes) {
  return data !== null
    && Object.entries(changes).every(([field, value]) => valuesEqual(data[field], value));
}

function createAdminMigrationRepository(firestore) {
  if (
    !firestore
    || typeof firestore.collection !== "function"
    || typeof firestore.runTransaction !== "function"
  ) {
    throw cliError("invalid-dependency", "A valid Admin Firestore instance is required.");
  }

  return Object.freeze({
    async loadCollections(collectionNames) {
      const dataset = {};
      for (const collectionName of collectionNames) {
        const snapshot = await firestore.collection(collectionName).get();
        dataset[collectionName] = snapshot.docs.map((document) => ({
          id: document.id,
          data: document.data(),
          version: document.updateTime,
        }));
      }
      return dataset;
    },

    async applyChunk(actions) {
      return firestore.runTransaction(async (transaction) => {
        const prepared = [];
        for (const action of actions) {
          if (action.kind === "update") {
            const reference = firestore.collection(action.collection).doc(action.id);
            const snapshot = await transaction.get(reference);
            prepared.push({ action, reference, snapshot });
            continue;
          }
          if (action.kind === "relocate") {
            const collection = firestore.collection(action.collection);
            const sourceReference = collection.doc(action.sourceId);
            const destinationReference = collection.doc(action.destinationId);
            const sourceSnapshot = await transaction.get(sourceReference);
            const destinationSnapshot = await transaction.get(destinationReference);
            prepared.push({
              action,
              sourceReference,
              destinationReference,
              sourceSnapshot,
              destinationSnapshot,
            });
            continue;
          }
          throw preconditionFailure();
        }

        let writes = 0;
        for (const item of prepared) {
          const { action } = item;
          if (action.kind === "update") {
            const data = snapshotData(item.snapshot);
            if (updateAlreadyApplied(data, action.changes)) continue;
            if (
              data === null
              || !versionsEqual(item.snapshot.updateTime, action.expectedVersion)
            ) {
              throw preconditionFailure();
            }
            transaction.update(item.reference, action.changes);
            writes += 1;
            continue;
          }

          const sourceData = snapshotData(item.sourceSnapshot);
          const destinationData = snapshotData(item.destinationSnapshot);
          if (sourceData === null) {
            if (destinationData !== null && valuesEqual(destinationData, action.data)) continue;
            throw preconditionFailure();
          }
          if (
            !valuesEqual(sourceData, action.data)
            || !versionsEqual(item.sourceSnapshot.updateTime, action.sourceVersion)
          ) {
            throw preconditionFailure();
          }
          if (destinationData !== null && !valuesEqual(destinationData, action.data)) {
            throw preconditionFailure();
          }
          if (
            action.mode === "cleanup-source"
            && (
              destinationData === null
              || !versionsEqual(item.destinationSnapshot.updateTime, action.destinationVersion)
            )
          ) {
            throw preconditionFailure();
          }
          if (destinationData === null) {
            if (action.mode !== "move") throw preconditionFailure();
            transaction.create(item.destinationReference, action.data);
            writes += 1;
          }
          transaction.delete(item.sourceReference);
          writes += 1;
        }
        return { writes };
      });
    },
  });
}

function resolveProjectId(app, env) {
  const candidates = [
    app?.options?.projectId,
    env.GCLOUD_PROJECT,
    env.GOOGLE_CLOUD_PROJECT,
  ];
  const projectId = candidates.find((value) => typeof value === "string" && value.trim());
  if (!projectId) throw cliError("project-unavailable", "The Firebase project could not be identified safely.");
  return projectId.trim();
}

async function runCli(argv, dependencies = {}) {
  const options = parseCliArguments(argv);
  const env = dependencies.env || process.env;
  const emulator = typeof env.FIRESTORE_EMULATOR_HOST === "string"
    && env.FIRESTORE_EMULATOR_HOST.trim().length > 0;
  if (
    (options.target === "production" && emulator)
    || (options.target === "emulator" && !emulator)
  ) {
    throw cliError("ambiguous-target", "The configured Firestore target does not match --target.");
  }

  const admin = dependencies.admin || require("firebase-admin");
  const app = Array.isArray(admin.apps) && admin.apps.length > 0
    ? admin.app()
    : admin.initializeApp();
  const projectId = resolveProjectId(app, env);
  if (options.apply && options.confirmProjectId !== projectId) {
    throw cliError("confirmation-required", "Exact project confirmation is required before applying.");
  }
  const firestore = dependencies.firestore || admin.firestore();
  const repository = createAdminMigrationRepository(firestore);
  const migration = createCanonicalRelationshipMigration({
    repository,
    environment: { projectId, target: options.target, emulator },
  });
  const plan = await migration.planMigration();
  const result = await migration.executeMigration(plan, {
    apply: options.apply,
    confirmProjectId: options.confirmProjectId,
  });
  const output = dependencies.output || ((value) => process.stdout.write(`${value}\n`));
  output(JSON.stringify({
    mode: result.dryRun ? "dry-run" : "apply",
    applied: result.applied,
    ...(result.applied ? { chunks: result.chunks, writes: result.writes } : {}),
    summary: result.summary,
  }));
  return result;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof CanonicalRelationshipMigrationError
      ? error.code
      : "internal";
    const message = error instanceof CanonicalRelationshipMigrationError
      ? error.message
      : "Canonical relationship migration could not be completed safely.";
    process.stderr.write(`${JSON.stringify({ code, message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createAdminMigrationRepository,
  parseCliArguments,
  runCli,
};
