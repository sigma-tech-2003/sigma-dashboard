import { useCallback, useEffect, useMemo, useState } from "react";
import {
  serializeCollectionSources,
  subscribeToCollection,
  subscribeToCollectionSources,
} from "../services/firestoreService";

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
  orderByField,
  descriptorScope,
}) {
  const employee = principal?.employee;
  const employeeId = normalizedIdentityPart(employee?.id);
  const role = normalizedIdentityPart(employee?.role);
  const department = normalizedIdentityPart(employee?.dept);
  const scope = normalizedIdentityPart(queryScope);
  const sources = normalizedIdentityPart(descriptorScope);

  if (
    enabled !== true
    || principal?.linkage !== "uid"
    || !employeeId
    || !role
    || typeof employee?.dept !== "string"
    || !scope
    || !sources
    || !normalizedIdentityPart(collectionName)
  ) {
    return null;
  }

  return JSON.stringify({
    collectionName,
    employeeId,
    role,
    department,
    queryScope: scope,
    descriptorScope: sources,
    orderByField: normalizedIdentityPart(orderByField),
  });
}

export function createCollectionListener({
  enabled,
  cacheIdentity,
  subscribe,
  onData,
  onError,
}) {
  if (enabled !== true || !cacheIdentity) return () => {};

  let active = true;
  let unsubscribe = null;
  try {
    unsubscribe = subscribe({
      onData: (data) => {
        if (active) onData(data);
      },
      onError: (error) => {
        if (active) onError(error);
      },
    });
  } catch (error) {
    queueMicrotask(() => {
      if (active) onError(error);
    });
  }

  return () => {
    active = false;
    if (typeof unsubscribe === "function") unsubscribe();
  };
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
  const { orderByField, queryScope, sources } = subscription;
  const hasExplicitSources = Object.prototype.hasOwnProperty.call(subscription, "sources");
  const descriptorScope = useMemo(() => {
    if (hasExplicitSources) return serializeCollectionSources(sources);
    return JSON.stringify([{
      type: "collection",
      orderByField: normalizedIdentityPart(orderByField) || null,
    }]);
  }, [hasExplicitSources, orderByField, sources]);
  const hasUsableSources = !hasExplicitSources
    || (Array.isArray(sources) && sources.length > 0 && Boolean(descriptorScope));
  const employeeId = principal?.employee?.id;
  const employeeRole = principal?.employee?.role;
  const employeeDepartment = principal?.employee?.dept;
  const linkage = principal?.linkage;
  const cacheIdentity = useMemo(() => getCollectionCacheIdentity({
    collectionName,
    enabled: enabled && hasUsableSources,
    principal: {
      linkage,
      employee: {
        id: employeeId,
        role: employeeRole,
        dept: employeeDepartment,
      },
    },
    queryScope,
    orderByField,
    descriptorScope,
  }), [
    collectionName,
    employeeDepartment,
    employeeId,
    employeeRole,
    enabled,
    descriptorScope,
    hasUsableSources,
    linkage,
    orderByField,
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
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!canSubscribe) return undefined;

    const cleanupListener = createCollectionListener({
      enabled: canSubscribe,
      cacheIdentity,
      subscribe: ({ onData, onError }) => hasExplicitSources
        ? subscribeToCollectionSources(collectionName, sources, { onData, onError })
        : subscribeToCollection(collectionName, { orderByField, onData, onError }),
      onData: (collectionData) => {
        collectionCache.set(cacheIdentity, collectionData);
        setCollectionState({
          cacheIdentity,
          rawData: collectionData,
          loading: false,
          error: null,
        });
      },
      onError: (listenerError) => {
        setCollectionState((currentState) => ({
          cacheIdentity,
          rawData: currentState.cacheIdentity === cacheIdentity
            ? currentState.rawData
            : [],
          loading: false,
          error: listenerError,
        }));
      },
    });

    return () => {
      cleanupListener();
      collectionCache.delete(cacheIdentity);
    };
  }, [
    cacheIdentity,
    canSubscribe,
    collectionName,
    hasExplicitSources,
    orderByField,
    refreshKey,
    sources,
  ]);

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

  const refresh = useCallback(() => {
    if (canSubscribe) setRefreshKey((key) => key + 1);
  }, [canSubscribe]);
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
