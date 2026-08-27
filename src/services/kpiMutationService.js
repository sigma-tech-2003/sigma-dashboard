import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase/firebaseConfig";

const PROGRESS_UPDATE_FIELDS = new Set([
  "title",
  "target",
  "current",
  "weight",
  "period",
  "status",
]);
const REQUIRED_RESPONSE_FIELDS = new Set([
  "id",
  "empId",
  "title",
  "target",
  "current",
  "weight",
  "period",
  "status",
  "rating",
  "ratedBy",
  "ratedAt",
]);
const OPTIONAL_RESPONSE_FIELDS = new Set(["projectId", "createdAt", "updatedAt"]);
const ALLOWED_STATUSES = new Set(["active"]);

const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Your session has expired. Please sign in and try again.",
  "permission-denied": "You do not have permission to manage this KPI.",
  "invalid-argument": "Review the KPI details and try again.",
  "not-found": "This KPI or a related record could not be found.",
  "already-exists": "This KPI conflicts with an existing record.",
  "failed-precondition": "The KPI could not be verified in its current state.",
  aborted: "The KPI changed during this operation. Please try again.",
  unavailable: "KPI management is temporarily unavailable. Please try again.",
  "malformed-response": "The KPI response could not be verified.",
  internal: "KPI management could not be completed.",
});

const CALLABLE_CODE_MAP = Object.freeze({
  unauthenticated: "unauthenticated",
  "permission-denied": "permission-denied",
  "invalid-argument": "invalid-argument",
  "not-found": "not-found",
  "already-exists": "already-exists",
  "failed-precondition": "failed-precondition",
  aborted: "aborted",
  unavailable: "unavailable",
  "deadline-exceeded": "unavailable",
  "network-request-failed": "unavailable",
  cancelled: "unavailable",
  internal: "internal",
});

const callableManageKpi = httpsCallable(functions, "manageKpi");

export class KpiMutationError extends Error {
  constructor(code) {
    const safeCode = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? code
      : "internal";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "KpiMutationError";
    this.code = safeCode;
  }
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const invalidKpi = () => new KpiMutationError("invalid-argument");
const malformedResponse = () => new KpiMutationError("malformed-response");

const normalizedId = (value, errorFactory = invalidKpi) => {
  let id = "";
  if (typeof value === "string") id = value.trim();
  else if (Number.isSafeInteger(value) && value >= 0) id = String(value);
  if (!id || id.includes("/") || id === "." || id === "..") throw errorFactory();
  return id;
};

const normalizedText = (value, errorFactory = invalidKpi) => {
  if (typeof value !== "string") throw errorFactory();
  const text = value.trim();
  if (!text) throw errorFactory();
  return text;
};

const normalizedNumber = (value, predicate, errorFactory = invalidKpi) => {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(number) || !predicate(number)) throw errorFactory();
  return number;
};

const normalizedStatus = (value, errorFactory = invalidKpi) => {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ALLOWED_STATUSES.has(status)) throw errorFactory();
  return status;
};

const normalizedRating = (value, { nullable = false, errorFactory = invalidKpi } = {}) => {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const rating = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) throw errorFactory();
  return rating;
};

const normalizedTimestamp = (value, { nullable = false } = {}) => {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || value.trim() === "" || Number.isNaN(Date.parse(value))) {
    throw malformedResponse();
  }
  return value;
};

const normalizedNullableId = (value) => {
  if (value === null || value === undefined || value === "") return null;
  return normalizedId(value, malformedResponse);
};

const normalizedCoreFields = (value, errorFactory = invalidKpi) => ({
  title: normalizedText(value.title, errorFactory),
  target: normalizedNumber(value.target, (number) => number > 0, errorFactory),
  current: normalizedNumber(value.current, (number) => number >= 0, errorFactory),
  weight: normalizedNumber(
    value.weight,
    (number) => number >= 1 && number <= 100,
    errorFactory,
  ),
  period: normalizedText(value.period, errorFactory),
  status: normalizedStatus(value.status, errorFactory),
});

const createKpiPayload = (kpi) => {
  if (!isPlainObject(kpi)) throw invalidKpi();
  return {
    projectId: normalizedId(kpi.projectId),
    empId: normalizedId(kpi.empId),
    ...normalizedCoreFields(kpi),
  };
};

const updateKpiPayload = (updates) => {
  if (!isPlainObject(updates)) throw invalidKpi();
  if (Object.prototype.hasOwnProperty.call(updates, "rating")) {
    return { rating: normalizedRating(updates.rating) };
  }

  const payload = {};
  Object.keys(updates).forEach((field) => {
    if (!PROGRESS_UPDATE_FIELDS.has(field)) return;
    if (field === "title" || field === "period") {
      payload[field] = normalizedText(updates[field]);
    } else if (field === "target") {
      payload.target = normalizedNumber(updates.target, (number) => number > 0);
    } else if (field === "current") {
      payload.current = normalizedNumber(updates.current, (number) => number >= 0);
    } else if (field === "weight") {
      payload.weight = normalizedNumber(
        updates.weight,
        (number) => number >= 1 && number <= 100,
      );
    } else if (field === "status") payload.status = normalizedStatus(updates.status);
  });
  if (Object.keys(payload).length === 0) throw invalidKpi();
  return payload;
};

const sanitizedKpiResponse = (value) => {
  if (!isPlainObject(value)) throw malformedResponse();
  const keys = Object.keys(value);
  if (
    [...REQUIRED_RESPONSE_FIELDS].some((field) => !Object.prototype.hasOwnProperty.call(value, field))
    || keys.some((field) =>
      !REQUIRED_RESPONSE_FIELDS.has(field) && !OPTIONAL_RESPONSE_FIELDS.has(field))
  ) {
    throw malformedResponse();
  }

  let core;
  try {
    core = normalizedCoreFields(value, malformedResponse);
  } catch (error) {
    if (error instanceof KpiMutationError) throw error;
    throw malformedResponse();
  }
  const response = {
    id: normalizedId(value.id, malformedResponse),
    empId: normalizedId(value.empId, malformedResponse),
    ...core,
    rating: normalizedRating(value.rating, {
      nullable: true,
      errorFactory: malformedResponse,
    }),
    ratedBy: normalizedNullableId(value.ratedBy),
    ratedAt: normalizedTimestamp(value.ratedAt, { nullable: true }),
  };
  if (Object.prototype.hasOwnProperty.call(value, "projectId")) {
    response.projectId = normalizedId(value.projectId, malformedResponse);
  }
  if (Object.prototype.hasOwnProperty.call(value, "createdAt")) {
    response.createdAt = normalizedTimestamp(value.createdAt);
  }
  if (Object.prototype.hasOwnProperty.call(value, "updatedAt")) {
    response.updatedAt = normalizedTimestamp(value.updatedAt);
  }
  return response;
};

const sanitizedDeleteResponse = (value, kpiId) => {
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== 2
    || value.deleted !== true
    || normalizedId(value.id, malformedResponse) !== kpiId
  ) {
    throw malformedResponse();
  }
  return { id: kpiId, deleted: true };
};

const normalizedCallableCode = (error) => {
  const rawCode = (() => {
    try {
      return typeof error?.code === "string" ? error.code : "";
    } catch {
      return "";
    }
  })();
  const separatorIndex = rawCode.lastIndexOf("/");
  const code = separatorIndex >= 0 ? rawCode.slice(separatorIndex + 1) : rawCode;
  return CALLABLE_CODE_MAP[code] || "internal";
};

const invokeKpiMutation = async (payload, responseSanitizer) => {
  try {
    const result = await callableManageKpi(payload);
    return responseSanitizer(result?.data);
  } catch (error) {
    if (error instanceof KpiMutationError) throw error;
    throw new KpiMutationError(normalizedCallableCode(error));
  }
};

export function createKpi(kpi) {
  return invokeKpiMutation(
    { operation: "create", kpi: createKpiPayload(kpi) },
    (response) => {
      const createdKpi = sanitizedKpiResponse(response);
      if (!createdKpi.projectId || !createdKpi.createdAt || !createdKpi.updatedAt) {
        throw malformedResponse();
      }
      return createdKpi;
    },
  );
}

export function updateKpi(kpiId, updates) {
  const id = normalizedId(kpiId);
  return invokeKpiMutation(
    { operation: "update", kpiId: id, updates: updateKpiPayload(updates) },
    (response) => {
      const updatedKpi = sanitizedKpiResponse(response);
      if (updatedKpi.id !== id || !updatedKpi.updatedAt) throw malformedResponse();
      return updatedKpi;
    },
  );
}

export function deleteKpi(kpiId) {
  const id = normalizedId(kpiId);
  return invokeKpiMutation(
    { operation: "delete", kpiId: id },
    (response) => sanitizedDeleteResponse(response, id),
  );
}
