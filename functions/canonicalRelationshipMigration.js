/* global module */
"use strict";

const COLLECTIONS = Object.freeze([
  "employees",
  "departments",
  "projects",
  "kpis",
  "leaves",
  "attendance",
  "payroll",
  "leaveBalances",
  "authLinks",
]);
const SAFE_REFERENCE_COLLECTIONS = new Set([
  "departments",
  "projects",
  "kpis",
  "leaves",
  "attendance",
  "payroll",
]);
const MAX_FIRESTORE_WRITES = 500;
const DEFAULT_WRITE_LIMIT = 450;
const PLAN_REGISTRY = new WeakSet();
const ISO_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

class CanonicalRelationshipMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanonicalRelationshipMigrationError";
    this.code = code;
  }
}

function migrationError(code, message) {
  return new CanonicalRelationshipMigrationError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
}

function valuesEqual(left, right) {
  if (Object.is(left, right)) return true;
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
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => valuesEqual(item, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) =>
        key === rightKeys[index] && valuesEqual(left[key], right[key]));
  }
  return false;
}

function normalizeDocumentId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (
    !id
    || id !== value
    || id.length > 1500
    || id.includes("/")
    || id === "."
    || id === ".."
    || [...id].some((character) => character.codePointAt(0) < 32)
  ) {
    return null;
  }
  return id;
}

function normalizeRelationshipValue(value) {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized || !normalizeDocumentId(normalized)) return null;
    return normalized;
  }
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function isEmptyRelationship(value) {
  return value === undefined || value === null || value === "";
}

function validTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value);
}

function createStats() {
  return Object.fromEntries(COLLECTIONS.map((collection) => [collection, {
    scanned: 0,
    changes: 0,
    writes: 0,
    noOps: 0,
    conflicts: 0,
  }]));
}

function addConflict(state, category, collection, documentId = null, field = null) {
  state.conflicts.push(Object.freeze({ category, collection, documentId, field }));
  if (state.stats[collection]) state.stats[collection].conflicts += 1;
}

function normalizedDocuments(dataset, collection, state) {
  const source = dataset?.[collection];
  if (!Array.isArray(source)) {
    addConflict(state, "invalid-collection-input", collection);
    return [];
  }
  state.stats[collection].scanned = source.length;
  const seen = new Set();
  const documents = [];
  source.forEach((document) => {
    const id = normalizeDocumentId(document?.id);
    if (!id || !isPlainObject(document?.data)) {
      addConflict(state, "malformed-document", collection);
      return;
    }
    if (seen.has(id)) {
      addConflict(state, "duplicate-document", collection, id);
      return;
    }
    seen.add(id);
    documents.push({
      id,
      data: document.data,
      version: document.version ?? null,
    });
  });
  return documents.sort((left, right) => left.id.localeCompare(right.id));
}

function createLookup(documents, collection, target, state) {
  const aliases = new Map();
  const canonicalIds = new Set(documents.map((document) => document.id));
  const register = (aliasValue, canonicalId, field, required) => {
    if (isEmptyRelationship(aliasValue) && !required) return;
    const alias = normalizeRelationshipValue(aliasValue);
    if (!alias) {
      addConflict(state, `malformed-${target}-alias`, collection, canonicalId, field);
      return;
    }
    if (!aliases.has(alias)) aliases.set(alias, new Set());
    aliases.get(alias).add(canonicalId);
  };
  documents.forEach((document) => {
    register(document.id, document.id, "_documentId", true);
    if (Object.prototype.hasOwnProperty.call(document.data, "id")) {
      register(document.data.id, document.id, "id", false);
    }
  });
  for (const [alias, targets] of aliases) {
    if (targets.size > 1) {
      addConflict(state, `ambiguous-${target}-alias`, collection, alias, "id");
    }
  }
  return { aliases, canonicalIds };
}

function resolveReference(lookup, value) {
  const alias = normalizeRelationshipValue(value);
  if (!alias) return { status: "malformed" };
  const targets = lookup.aliases.get(alias);
  if (!targets || targets.size === 0) return { status: "missing" };
  if (targets.size !== 1) return { status: "ambiguous" };
  return { status: "resolved", id: [...targets][0] };
}

function relationshipConflictCategory(status, target) {
  if (status === "malformed") return `malformed-${target}-reference`;
  if (status === "ambiguous") return `ambiguous-${target}-reference`;
  return `missing-${target}-reference`;
}

function migrateScalar({
  document,
  field,
  lookup,
  target,
  required,
  collection,
  state,
  changes,
}) {
  const hasField = Object.prototype.hasOwnProperty.call(document.data, field);
  const value = document.data[field];
  if ((!hasField || isEmptyRelationship(value)) && !required) return true;
  if (!hasField || isEmptyRelationship(value)) {
    addConflict(state, `missing-${target}-reference`, collection, document.id, field);
    return false;
  }
  const result = resolveReference(lookup, value);
  if (result.status !== "resolved") {
    addConflict(
      state,
      relationshipConflictCategory(result.status, target),
      collection,
      document.id,
      field,
    );
    return false;
  }
  if (!Object.is(value, result.id)) changes[field] = result.id;
  return true;
}

function migrateArray({ document, field, lookup, target, collection, state, changes }) {
  const values = document.data[field];
  if (!Array.isArray(values) || values.length === 0) {
    addConflict(state, "malformed-assignment-array", collection, document.id, field);
    return false;
  }
  const normalized = [];
  const seen = new Set();
  let valid = true;
  values.forEach((value) => {
    const result = resolveReference(lookup, value);
    if (result.status !== "resolved") {
      addConflict(
        state,
        relationshipConflictCategory(result.status, target),
        collection,
        document.id,
        field,
      );
      valid = false;
      return;
    }
    if (!seen.has(result.id)) {
      seen.add(result.id);
      normalized.push(result.id);
    }
  });
  if (!valid) return false;
  if (!valuesEqual(values, normalized)) changes[field] = normalized;
  return true;
}

function addUpdateAction(state, document, collection, changes) {
  if (document.version === null) {
    addConflict(state, "missing-write-precondition", collection, document.id);
    return;
  }
  state.actions.push(Object.freeze({
    kind: "update",
    collection,
    id: document.id,
    changes: Object.freeze(cloneValue(changes)),
    expectedVersion: document.version,
    writeCount: 1,
  }));
  state.stats[collection].changes += 1;
  state.stats[collection].writes += 1;
}

function migrateDocumentCollection(documents, collection, migrate, state) {
  documents.forEach((document) => {
    const conflictCount = state.conflicts.length;
    const changes = {};
    migrate(document, changes);
    if (state.conflicts.length !== conflictCount) return;
    if (Object.keys(changes).length === 0) {
      state.stats[collection].noOps += 1;
      return;
    }
    addUpdateAction(state, document, collection, changes);
  });
}

function planLeaveBalanceRelocations(documents, employeeLookup, state) {
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  documents.forEach((document) => {
    const result = resolveReference(employeeLookup, document.id);
    if (result.status !== "resolved") {
      addConflict(
        state,
        relationshipConflictCategory(result.status, "employee"),
        "leaveBalances",
        document.id,
        "_documentId",
      );
      return;
    }
    if (result.id === document.id) {
      state.stats.leaveBalances.noOps += 1;
      return;
    }
    if (document.version === null) {
      addConflict(state, "missing-write-precondition", "leaveBalances", document.id);
      return;
    }
    const destination = documentsById.get(result.id);
    if (destination && !valuesEqual(destination.data, document.data)) {
      addConflict(
        state,
        "leave-balance-destination-conflict",
        "leaveBalances",
        document.id,
        "_documentId",
      );
      return;
    }
    if (destination && destination.version === null) {
      addConflict(state, "missing-write-precondition", "leaveBalances", result.id);
      return;
    }
    const mode = destination ? "cleanup-source" : "move";
    const writeCount = destination ? 1 : 2;
    state.actions.push(Object.freeze({
      kind: "relocate",
      collection: "leaveBalances",
      sourceId: document.id,
      destinationId: result.id,
      data: cloneValue(document.data),
      sourceVersion: document.version,
      destinationVersion: destination?.version ?? null,
      mode,
      writeCount,
    }));
    state.stats.leaveBalances.changes += 1;
    state.stats.leaveBalances.writes += writeCount;
  });
}

function validateAuthLinks(authLinks, employees, employeeLookup, state) {
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
  const linksByUid = new Map();
  const employeeTargets = new Map();
  authLinks.forEach((link) => {
    const conflictCount = state.conflicts.length;
    const keys = Object.keys(link.data).sort();
    const exactShape = valuesEqual(keys, ["createdAt", "employeeId", "updatedAt"]);
    const relationship = resolveReference(employeeLookup, link.data.employeeId);
    if (!exactShape || !validTimestamp(link.data.createdAt) || !validTimestamp(link.data.updatedAt)) {
      addConflict(state, "malformed-auth-link", "authLinks");
    } else if (relationship.status !== "resolved") {
      addConflict(state, "invalid-auth-link-employee", "authLinks");
    } else if (link.data.employeeId !== relationship.id) {
      addConflict(state, "noncanonical-auth-link", "authLinks");
    } else {
      const employee = employeesById.get(relationship.id);
      if (!employeeTargets.has(relationship.id)) employeeTargets.set(relationship.id, []);
      employeeTargets.get(relationship.id).push(link.id);
      if (employeeTargets.get(relationship.id).length > 1) {
        addConflict(state, "duplicate-auth-link-target", "authLinks");
      }
      if (!employee || employee.data.uid !== link.id) {
        addConflict(state, "auth-link-uid-conflict", "authLinks");
      } else {
        linksByUid.set(link.id, relationship.id);
      }
    }
    if (state.conflicts.length === conflictCount) state.stats.authLinks.noOps += 1;
  });
  employees.forEach((employee) => {
    if (employee.data.uid === undefined || employee.data.uid === null || employee.data.uid === "") return;
    const uid = normalizeRelationshipValue(employee.data.uid);
    if (!uid || linksByUid.get(uid) !== employee.id) {
      addConflict(state, "missing-or-conflicting-auth-link", "employees", employee.id, "uid");
    }
  });
}

function actionKey(action) {
  return action.kind === "update"
    ? `${action.collection}/${action.id}/update`
    : `${action.collection}/${action.sourceId}/relocate/${action.destinationId}`;
}

function planCanonicalRelationships(dataset) {
  const state = { actions: [], conflicts: [], stats: createStats() };
  const documents = Object.fromEntries(
    COLLECTIONS.map((collection) => [
      collection,
      normalizedDocuments(dataset, collection, state),
    ]),
  );
  const employeeLookup = createLookup(documents.employees, "employees", "employee", state);
  const projectLookup = createLookup(documents.projects, "projects", "project", state);

  migrateDocumentCollection(documents.employees, "employees", (document, changes) => {
    migrateScalar({
      document,
      field: "teamLeadId",
      lookup: employeeLookup,
      target: "employee",
      required: false,
      collection: "employees",
      state,
      changes,
    });
  }, state);

  migrateDocumentCollection(documents.departments, "departments", (document, changes) => {
    migrateScalar({
      document,
      field: "managerId",
      lookup: employeeLookup,
      target: "employee",
      required: false,
      collection: "departments",
      state,
      changes,
    });
  }, state);

  migrateDocumentCollection(documents.projects, "projects", (document, changes) => {
    migrateScalar({
      document,
      field: "teamLeadId",
      lookup: employeeLookup,
      target: "employee",
      required: false,
      collection: "projects",
      state,
      changes,
    });
    migrateArray({
      document,
      field: "assignedEmployeeIds",
      lookup: employeeLookup,
      target: "employee",
      collection: "projects",
      state,
      changes,
    });
  }, state);

  migrateDocumentCollection(documents.kpis, "kpis", (document, changes) => {
    migrateScalar({
      document,
      field: "empId",
      lookup: employeeLookup,
      target: "employee",
      required: true,
      collection: "kpis",
      state,
      changes,
    });
    migrateScalar({
      document,
      field: "projectId",
      lookup: projectLookup,
      target: "project",
      required: false,
      collection: "kpis",
      state,
      changes,
    });
    migrateScalar({
      document,
      field: "ratedBy",
      lookup: employeeLookup,
      target: "employee",
      required: false,
      collection: "kpis",
      state,
      changes,
    });
  }, state);

  for (const collection of ["leaves", "attendance", "payroll"]) {
    migrateDocumentCollection(documents[collection], collection, (document, changes) => {
      migrateScalar({
        document,
        field: "empId",
        lookup: employeeLookup,
        target: "employee",
        required: true,
        collection,
        state,
        changes,
      });
    }, state);
  }

  planLeaveBalanceRelocations(documents.leaveBalances, employeeLookup, state);
  validateAuthLinks(documents.authLinks, documents.employees, employeeLookup, state);

  state.actions.sort((left, right) => actionKey(left).localeCompare(actionKey(right)));
  state.conflicts.sort((left, right) =>
    `${left.category}:${left.collection}:${left.documentId || ""}:${left.field || ""}`
      .localeCompare(`${right.category}:${right.collection}:${right.documentId || ""}:${right.field || ""}`));
  const plan = Object.freeze({
    actions: Object.freeze([...state.actions]),
    conflicts: Object.freeze([...state.conflicts]),
    stats: Object.freeze(Object.fromEntries(
      Object.entries(state.stats).map(([collection, stats]) => [collection, Object.freeze({ ...stats })]),
    )),
  });
  PLAN_REGISTRY.add(plan);
  return plan;
}

function safeDocumentReference(conflict) {
  if (!SAFE_REFERENCE_COLLECTIONS.has(conflict.collection)) return null;
  const id = normalizeDocumentId(conflict.documentId);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return `${conflict.collection}/${id}`;
}

function summarizePlan(plan) {
  if (!PLAN_REGISTRY.has(plan)) throw migrationError("invalid-plan", "A valid migration plan is required.");
  const conflictCategories = {};
  plan.conflicts.forEach((conflict) => {
    if (!conflictCategories[conflict.category]) {
      conflictCategories[conflict.category] = { count: 0, references: [] };
    }
    const entry = conflictCategories[conflict.category];
    entry.count += 1;
    const reference = safeDocumentReference(conflict);
    if (reference && entry.references.length < 10 && !entry.references.includes(reference)) {
      entry.references.push(reference);
    }
  });
  return {
    collections: Object.fromEntries(
      COLLECTIONS.map((collection) => [collection, { ...plan.stats[collection] }]),
    ),
    totals: {
      documents: COLLECTIONS.reduce((total, collection) => total + plan.stats[collection].scanned, 0),
      changes: plan.actions.length,
      writes: plan.actions.reduce((total, action) => total + action.writeCount, 0),
      noOps: COLLECTIONS.reduce((total, collection) => total + plan.stats[collection].noOps, 0),
      conflicts: plan.conflicts.length,
    },
    conflictCategories,
  };
}

function chunkActions(actions, writeLimit) {
  const chunks = [];
  let current = [];
  let writes = 0;
  actions.forEach((action) => {
    if (action.writeCount > writeLimit) {
      throw migrationError("invalid-plan", "A migration action exceeds the write limit.");
    }
    if (current.length > 0 && writes + action.writeCount > writeLimit) {
      chunks.push(current);
      current = [];
      writes = 0;
    }
    current.push(action);
    writes += action.writeCount;
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function safeLog(logger, event, details) {
  try {
    logger?.info?.(event, details);
  } catch {
    // Migration safety must not depend on logging.
  }
}

function createCanonicalRelationshipMigration({
  repository,
  logger = null,
  environment = {},
  writeLimit = DEFAULT_WRITE_LIMIT,
}) {
  if (
    !repository
    || typeof repository.loadCollections !== "function"
    || typeof repository.applyChunk !== "function"
  ) {
    throw migrationError("invalid-dependency", "A valid migration repository is required.");
  }
  if (!Number.isInteger(writeLimit) || writeLimit < 2 || writeLimit > MAX_FIRESTORE_WRITES) {
    throw migrationError("invalid-dependency", "A valid Firestore write limit is required.");
  }

  async function planMigration() {
    let dataset;
    try {
      dataset = await repository.loadCollections([...COLLECTIONS]);
    } catch {
      throw migrationError("read-failed", "Migration data could not be loaded safely.");
    }
    return planCanonicalRelationships(dataset);
  }

  async function executeMigration(plan, options = {}) {
    if (!PLAN_REGISTRY.has(plan)) throw migrationError("invalid-plan", "A valid migration plan is required.");
    const summary = summarizePlan(plan);
    if (options.apply !== true) {
      safeLog(logger, "canonical-relationship-migration-dry-run", summary.totals);
      return { dryRun: true, applied: false, summary };
    }
    const projectId = typeof environment.projectId === "string" ? environment.projectId.trim() : "";
    const confirmation = typeof options.confirmProjectId === "string"
      ? options.confirmProjectId.trim()
      : "";
    const target = environment.target;
    const emulator = environment.emulator === true;
    if (!projectId || !confirmation || confirmation !== projectId) {
      throw migrationError("confirmation-required", "Exact project confirmation is required before applying.");
    }
    if (
      !["production", "emulator"].includes(target)
      || (target === "production" && emulator)
      || (target === "emulator" && !emulator)
    ) {
      throw migrationError("ambiguous-target", "The migration target is ambiguous.");
    }
    if (plan.conflicts.length > 0) {
      throw migrationError("conflicts-present", "Resolve every migration conflict before applying.");
    }
    const chunks = chunkActions(plan.actions, writeLimit);
    let appliedWrites = 0;
    for (const chunk of chunks) {
      try {
        const result = await repository.applyChunk(chunk);
        appliedWrites += Number.isSafeInteger(result?.writes)
          ? result.writes
          : chunk.reduce((total, action) => total + action.writeCount, 0);
      } catch (error) {
        const code = error?.code === "precondition-failed"
          ? "precondition-failed"
          : "write-failed";
        throw migrationError(
          code,
          code === "precondition-failed"
            ? "Migration data changed after planning. Run a new dry-run."
            : "Migration writes could not be completed safely.",
        );
      }
    }
    safeLog(logger, "canonical-relationship-migration-applied", {
      chunks: chunks.length,
      writes: appliedWrites,
    });
    return {
      dryRun: false,
      applied: true,
      chunks: chunks.length,
      writes: appliedWrites,
      summary,
    };
  }

  return Object.freeze({ planMigration, executeMigration });
}

module.exports = {
  COLLECTIONS,
  CanonicalRelationshipMigrationError,
  createCanonicalRelationshipMigration,
  planCanonicalRelationships,
  summarizePlan,
  valuesEqual,
};
