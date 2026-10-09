import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pollingHub } from "../services/polling.js";

// A list the signed-in user may read, kept fresh by POLLING (D3) where Firestore's onSnapshot used to push.
//
//   options.subscription = { queryScope, fetch }   `fetch()` resolves the whole list, page-shaped
//
// One shared hub drives every collection (services/polling.js): one timer, paused while the tab is hidden, backing
// off on errors. Only the FIRST load sets `loading`, so a background poll can never blank the page (App.jsx shows
// its loading screen whenever any collection is loading). A failed poll sets `error` and keeps the data on screen.

const collectionCache = new Map();
const EMPTY_COLLECTION_DATA = Object.freeze([]);

const processCollectionData = (data, { filter, sort, page, pageSize, select }) => {
  let processedData = filter ? data.filter(filter) : data;

  if (sort) {
    processedData = [...processedData].sort(sort);
  }

  const total = processedData.length;
  const pagination = pageSize
    ? {
        page: page || 1,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }
    : null;

  if (pagination) {
    const start = (pagination.page - 1) * pagination.pageSize;
    processedData = processedData.slice(start, start + pagination.pageSize);
  }

  return {
    data: select ? processedData.map(select) : processedData,
    pagination,
    total,
  };
};

const normalizedIdentityPart = (value) =>
  typeof value === "string" ? value.trim() : "";

export function getCollectionCacheIdentity({
  collectionName,
  enabled,
  principal,
  queryScope,
}) {
  const employee = principal?.employee;
  const employeeId = normalizedIdentityPart(employee?.id);
  const role = normalizedIdentityPart(employee?.role);
  const department = normalizedIdentityPart(employee?.dept);
  const scope = normalizedIdentityPart(queryScope);

  if (
    enabled !== true
    || principal?.linkage !== "uid"
    || !employeeId
    || !role
    || typeof employee?.dept !== "string"
    || !scope
    || !normalizedIdentityPart(collectionName)
  ) {
    return null;
  }

  return JSON.stringify({ collectionName, employeeId, role, department, queryScope: scope });
}

const emptyState = () => ({
  cacheIdentity: null,
  rawData: [],
  loading: false,
  error: null,
});

export function useAuthenticatedCollection(collectionName, options = {}) {
  const {
    enabled = false,
    principal = null,
    subscription = {},
    filter,
    page,
    pageSize,
    select,
    sort,
  } = options;
  const { queryScope, fetch } = subscription;
  const hasFetch = typeof fetch === "function";
  const employeeId = principal?.employee?.id;
  const employeeRole = principal?.employee?.role;
  const employeeDepartment = principal?.employee?.dept;
  const linkage = principal?.linkage;
  const cacheIdentity = useMemo(() => getCollectionCacheIdentity({
    collectionName,
    enabled: enabled && hasFetch,
    principal: {
      linkage,
      employee: {
        id: employeeId,
        role: employeeRole,
        dept: employeeDepartment,
      },
    },
    queryScope,
  }), [
    collectionName,
    employeeDepartment,
    employeeId,
    employeeRole,
    enabled,
    hasFetch,
    linkage,
    queryScope,
  ]);
  const canSubscribe = Boolean(cacheIdentity);
  const [collectionState, setCollectionState] = useState(() => {
    if (!cacheIdentity) return emptyState();
    const cachedData = collectionCache.get(cacheIdentity);
    return {
      cacheIdentity,
      rawData: cachedData || [],
      loading: !cachedData,
      error: null,
    };
  });

  // The latest fetch function, read at poll time so a new function identity never re-registers the poll.
  const fetchRef = useRef(fetch);
  const registrationRef = useRef(null);
  useEffect(() => {
    fetchRef.current = fetch;
  });

  useEffect(() => {
    if (!canSubscribe) return undefined;

    const registration = pollingHub.register({
      fetch: () => fetchRef.current(),
      onData: (collectionData) => {
        collectionCache.set(cacheIdentity, collectionData);
        setCollectionState({
          cacheIdentity,
          rawData: collectionData,
          loading: false,
          error: null,
        });
      },
      onError: (pollError) => {
        setCollectionState((currentState) => ({
          cacheIdentity,
          rawData: currentState.cacheIdentity === cacheIdentity
            ? currentState.rawData
            : [],
          loading: false,
          error: pollError,
        }));
      },
    });
    registrationRef.current = registration;

    return () => {
      registration.stop();
      registrationRef.current = null;
      collectionCache.delete(cacheIdentity);
    };
  }, [cacheIdentity, canSubscribe]);

  const stateMatchesPrincipal = canSubscribe
    && collectionState.cacheIdentity === cacheIdentity;
  const cachedData = canSubscribe ? collectionCache.get(cacheIdentity) : null;
  const rawData = stateMatchesPrincipal
    ? collectionState.rawData
    : (cachedData || EMPTY_COLLECTION_DATA);
  const loading = canSubscribe
    ? (stateMatchesPrincipal ? collectionState.loading : !cachedData)
    : false;
  const error = stateMatchesPrincipal ? collectionState.error : null;
  const processed = useMemo(
    () => processCollectionData(rawData, { filter, page, pageSize, select, sort }),
    [filter, page, pageSize, rawData, select, sort],
  );

  // Poll now, e.g. straight after a mutation, instead of waiting out the interval.
  const refresh = useCallback(
    () => registrationRef.current?.pollNow() ?? Promise.resolve(),
    [],
  );
  const applyOptimisticUpdate = useCallback((updater) => {
    if (!canSubscribe) return;

    setCollectionState((currentState) => {
      if (currentState.cacheIdentity !== cacheIdentity) return currentState;
      const nextData = updater(currentState.rawData);
      collectionCache.set(cacheIdentity, nextData);
      return { ...currentState, rawData: nextData };
    });
  }, [cacheIdentity, canSubscribe]);

  return {
    ...processed,
    rawData,
    loading,
    error,
    isCached: canSubscribe && collectionCache.has(cacheIdentity),
    refresh,
    applyOptimisticUpdate,
    cacheIdentity,
    enabled: canSubscribe,
  };
}
