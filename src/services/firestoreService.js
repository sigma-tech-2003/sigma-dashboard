import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase/firebaseConfig";

const MAX_FIREBASE_UID_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const SOURCE_DESCRIPTOR = Symbol("firestore-source-descriptor");
const INTERNAL_QUERY_DESCRIPTORS = new WeakSet();
const MULTI_CONSTRAINT_RULES = new Map([
  ["empId", new Set(["in"])],
  ["status", new Set(["=="])],
  ["assignedEmployeeIds", new Set(["array-contains"])],
]);
const MAX_IN_QUERY_VALUES = 30;

const hasInvalidUidCharacters = (uid) => [...uid].some((character) => {
  const codePoint = character.codePointAt(0);
  return /\s/u.test(character) || codePoint < 32 || codePoint === 127;
});

export class EmployeeUidDataIntegrityError extends Error {
  constructor() {
    super("Multiple employee records are linked to the same authentication account.");
    this.name = "EmployeeUidDataIntegrityError";
    this.code = "duplicate-employee-uid";
  }
}

export class EmployeeEmailDataIntegrityError extends Error {
  constructor() {
    super("Multiple employee records are linked to the same email address.");
    this.name = "EmployeeEmailDataIntegrityError";
    this.code = "duplicate-employee-email";
  }
}

export class FirestoreSubscriptionError extends Error {
  constructor() {
    super("The requested data could not be loaded.");
    this.name = "FirestoreSubscriptionError";
    this.code = "firestore-subscription-failed";
  }
}

const normalizeSafeSegment = (value, label) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || !SAFE_SEGMENT_PATTERN.test(normalized)) {
    throw new TypeError(`A valid ${label} is required.`);
  }
  return normalized;
};

const normalizeDocumentId = (value) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.includes("/") || normalized !== value.trim()) {
    throw new TypeError("A valid Firestore document ID is required.");
  }
  return normalized;
};

export const createCollectionSource = ({ orderByField = null } = {}) =>
  Object.freeze({
    [SOURCE_DESCRIPTOR]: true,
    type: "collection",
    orderByField: orderByField
      ? normalizeSafeSegment(orderByField, "order field")
      : null,
  });

export const createWhereSource = (field, value, { orderByField = null } = {}) => {
  if (typeof value !== "string") {
    throw new TypeError("A normalized string query value is required.");
  }

  return Object.freeze({
    [SOURCE_DESCRIPTOR]: true,
    type: "where",
    field: normalizeSafeSegment(field, "query field"),
    operator: "==",
    value,
    orderByField: orderByField
      ? normalizeSafeSegment(orderByField, "order field")
      : null,
  });
};

export const createDocumentSource = (documentId) =>
  Object.freeze({
    [SOURCE_DESCRIPTOR]: true,
    type: "document",
    documentId: normalizeDocumentId(documentId),
  });

const cloneConstraintValue = (operator, value) => {
  if (operator === "in") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new TypeError("An in-query requires at least one value.");
    }
    if (value.length > MAX_IN_QUERY_VALUES) {
      throw new TypeError("An in-query cannot contain more than 30 values.");
    }
    const clonedValues = value.map((item) => {
      if (
        (typeof item !== "string" || !item.trim() || item !== item.trim())
        && (!Number.isSafeInteger(item) || item < 0)
      ) {
        throw new TypeError("Query values must be non-empty strings or safe integers.");
      }
      return item;
    });
    return Object.freeze(clonedValues);
  }

  if (operator === "array-contains") {
    if (
      (typeof value !== "string" || !value.trim() || value !== value.trim())
      && (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new TypeError(
        "An array-contains query requires one non-empty string or safe integer.",
      );
    }
    return value;
  }

  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new TypeError("An equality query requires a non-empty string value.");
  }
  return value;
};

export const createInternalQuerySource = (constraints) => {
  if (!Array.isArray(constraints) || constraints.length === 0) {
    throw new TypeError("At least one internal query constraint is required.");
  }

  let inConstraintCount = 0;
  const usedFields = new Set();
  const clonedConstraints = constraints.map((constraint) => {
    if (
      !constraint
      || typeof constraint !== "object"
      || Array.isArray(constraint)
      || Object.keys(constraint).some(
        (key) => !["field", "operator", "value"].includes(key),
      )
    ) {
      throw new TypeError("An invalid internal query constraint was supplied.");
    }

    const { field, operator } = constraint;
    const allowedOperators = MULTI_CONSTRAINT_RULES.get(field);
    if (!allowedOperators) {
      throw new TypeError("The query field is not supported.");
    }
    if (!allowedOperators.has(operator)) {
      throw new TypeError("The query operator is not supported.");
    }
    if (usedFields.has(field)) {
      throw new TypeError("A query field cannot be constrained more than once.");
    }
    usedFields.add(field);
    if (operator === "in") {
      inConstraintCount += 1;
      if (inConstraintCount > 1) {
        throw new TypeError("Only one in-query constraint is supported.");
      }
    }
    if (operator === "array-contains" && constraints.length !== 1) {
      throw new TypeError("An array-contains query must be a single constraint.");
    }

    return Object.freeze({
      field,
      operator,
      value: cloneConstraintValue(operator, constraint.value),
    });
  }).sort((left, right) =>
    `${left.field}:${left.operator}`.localeCompare(`${right.field}:${right.operator}`));

  const descriptor = {
    [SOURCE_DESCRIPTOR]: true,
    type: "query",
    constraints: Object.freeze(clonedConstraints),
  };
  INTERNAL_QUERY_DESCRIPTORS.add(descriptor);
  return Object.freeze(descriptor);
};

const isSourceDescriptor = (descriptor) =>
  descriptor?.[SOURCE_DESCRIPTOR] === true
  && ["collection", "where", "query", "document"].includes(descriptor.type)
  && (descriptor.type !== "query" || INTERNAL_QUERY_DESCRIPTORS.has(descriptor));

export function serializeCollectionSources(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.some((source) => !isSourceDescriptor(source))) {
    return null;
  }

  return JSON.stringify(descriptors.map((source) => {
    if (source.type === "document") {
      return { type: source.type, documentId: source.documentId };
    }
    if (source.type === "where") {
      return {
        type: source.type,
        field: source.field,
        operator: source.operator,
        value: source.value,
        orderByField: source.orderByField,
      };
    }
    if (source.type === "query") {
      return {
        type: source.type,
        constraints: source.constraints.map((constraint) => ({
          field: constraint.field,
          operator: constraint.operator,
          value: Array.isArray(constraint.value)
            ? [...constraint.value]
            : constraint.value,
        })),
      };
    }
    return { type: source.type, orderByField: source.orderByField };
  }));
}

const normalizeEmployeeEmail = (email) => {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

  if (
    !normalizedEmail ||
    normalizedEmail.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(normalizedEmail)
  ) {
    throw new TypeError("A valid employee email is required.");
  }

  return normalizedEmail;
};

const normalizeEmployeeUid = (uid) => {
  const normalizedUid = typeof uid === "string" ? uid.trim() : "";

  if (
    !normalizedUid ||
    normalizedUid.length > MAX_FIREBASE_UID_LENGTH ||
    hasInvalidUidCharacters(normalizedUid)
  ) {
    throw new TypeError("A valid employee UID is required.");
  }

  return normalizedUid;
};

const toDocumentData = (snapshot) =>
  snapshot.docs.map((document) => ({ ...document.data(), _docId: document.id }));

const getCollectionReference = (collectionName) => collection(db, collectionName);

const safeCollectionName = (collectionName) =>
  normalizeSafeSegment(collectionName, "collection name");

const sourceReference = (collectionName, source) => {
  if (source.type === "document") {
    return doc(db, collectionName, source.documentId);
  }

  const reference = getCollectionReference(collectionName);
  const constraints = [];
  if (source.type === "where") {
    constraints.push(where(source.field, source.operator, source.value));
  }
  if (source.type === "query") {
    source.constraints.forEach((constraint) => {
      constraints.push(where(
        constraint.field,
        constraint.operator,
        constraint.value,
      ));
    });
  }
  if (source.orderByField) constraints.push(orderBy(source.orderByField));
  return constraints.length ? query(reference, ...constraints) : reference;
};

const sourceDocumentData = (snapshot, source) => {
  if (source.type !== "document") return toDocumentData(snapshot);
  if (!snapshot.exists()) return [];
  return [{ ...snapshot.data(), _docId: snapshot.id }];
};

export function mergeCollectionSourceResults(sourceResults) {
  const documentsById = new Map();

  sourceResults.forEach((documents) => {
    if (!Array.isArray(documents)) return;
    documents.forEach((document) => {
      if (typeof document?._docId === "string" && document._docId) {
        documentsById.set(document._docId, document);
      }
    });
  });

  return [...documentsById.values()];
}

export function createMultiSourceListener({
  sourceCount,
  subscribeSource,
  onData,
  onError,
}) {
  if (!Number.isInteger(sourceCount) || sourceCount < 1 || typeof subscribeSource !== "function") {
    throw new TypeError("A valid internal Firestore source configuration is required.");
  }

  let active = true;
  const sourceResults = Array.from({ length: sourceCount });
  const initializedSources = new Set();
  const unsubscribeSources = [];
  const cleanup = () => {
    active = false;
    unsubscribeSources.splice(0).forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch {
        // Listener cleanup must continue for every remaining source.
      }
    });
  };
  const fail = () => {
    if (!active) return;
    cleanup();
    onError?.(new FirestoreSubscriptionError());
  };

  try {
    for (let index = 0; index < sourceCount; index += 1) {
      const unsubscribe = subscribeSource(index, {
        onData: (documents) => {
          if (!active) return;
          sourceResults[index] = documents;
          initializedSources.add(index);
          if (initializedSources.size === sourceCount) {
            onData(mergeCollectionSourceResults(sourceResults));
          }
        },
        onError: fail,
      });
      unsubscribeSources.push(unsubscribe);
    }
  } catch {
    cleanup();
    throw new FirestoreSubscriptionError();
  }

  return cleanup;
}

export function subscribeToCollectionSources(
  collectionName,
  descriptors,
  { onData, onError },
) {
  const safeName = safeCollectionName(collectionName);
  if (
    !Array.isArray(descriptors)
    || descriptors.length === 0
    || descriptors.some((source) => !isSourceDescriptor(source))
  ) {
    throw new TypeError("At least one internal Firestore source is required.");
  }

  return createMultiSourceListener({
    sourceCount: descriptors.length,
    subscribeSource: (index, callbacks) => {
      const source = descriptors[index];
      return onSnapshot(
        sourceReference(safeName, source),
        (snapshot) => callbacks.onData(sourceDocumentData(snapshot, source)),
        callbacks.onError,
      );
    },
    onData,
    onError,
  });
}

export function subscribeToCollection(
  collectionName,
  { onData, onError, orderByField = null },
) {
  return subscribeToCollectionSources(
    collectionName,
    [createCollectionSource({ orderByField })],
    { onData, onError },
  );
}

export const createDocument = (collectionName, id, data) =>
  setDoc(doc(db, collectionName, String(id)), data);

export const updateDocument = (collectionName, id, updates) =>
  updateDoc(doc(db, collectionName, String(id)), updates);

export const deleteDocument = (collectionName, id) =>
  deleteDoc(doc(db, collectionName, String(id)));

export async function hasDocuments(collectionName) {
  const snapshot = await getDocs(getCollectionReference(collectionName));
  return !snapshot.empty;
}

export async function findEmployeeByEmail(email) {
  const normalizedEmail = normalizeEmployeeEmail(email);
  const employeeQuery = query(
    getCollectionReference("employees"),
    where("email", "==", normalizedEmail),
    limit(2),
  );
  const snapshot = await getDocs(employeeQuery);

  if (snapshot.empty) return null;
  if (snapshot.docs.length > 1) throw new EmployeeEmailDataIntegrityError();
  return snapshot.docs[0].data();
}

export async function findEmployeeByUid(uid) {
  const normalizedUid = normalizeEmployeeUid(uid);
  const employeeQuery = query(
    getCollectionReference("employees"),
    where("uid", "==", normalizedUid),
    limit(2),
  );
  const snapshot = await getDocs(employeeQuery);

  if (snapshot.empty) return null;
  if (snapshot.docs.length > 1) throw new EmployeeUidDataIntegrityError();
  return snapshot.docs[0].data();
}
