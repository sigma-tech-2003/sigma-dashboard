import { useCallback, useEffect, useMemo, useState } from "react";
import { observeAuthState } from "../services/authService";
import { subscribeToCollection } from "../services/firestoreService";

const collectionCache = new Map();

const normalizeOptions = (options) =>
  typeof options === "string" ? { orderByField: options } : options || {};

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

export function useAuthenticatedCollection(collectionName, options) {
  const normalizedOptions = normalizeOptions(options);
  const {
    filter,
    orderByField,
    page,
    pageSize,
    select,
    sort,
  } = normalizedOptions;
  const cachedData = collectionCache.get(collectionName);
  const [rawData, setRawData] = useState(cachedData || []);
  const [loading, setLoading] = useState(!cachedData);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let unsubscribeCollection = null;

    const unsubscribeAuth = observeAuthState((firebaseUser) => {
      if (unsubscribeCollection) {
        unsubscribeCollection();
        unsubscribeCollection = null;
      }

      if (!firebaseUser) {
        collectionCache.delete(collectionName);
        setRawData([]);
        setError(null);
        setLoading(false);
        return;
      }

      const cachedCollection = collectionCache.get(collectionName);
      if (cachedCollection) {
        setRawData(cachedCollection);
        setLoading(false);
      } else {
        setLoading(true);
      }
      setError(null);

      unsubscribeCollection = subscribeToCollection(collectionName, {
        orderByField,
        onData: (collectionData) => {
          collectionCache.set(collectionName, collectionData);
          setRawData(collectionData);
          setError(null);
          setLoading(false);
        },
        onError: (listenerError) => {
          setError(listenerError);
          setLoading(false);
        },
      });
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeCollection) unsubscribeCollection();
    };
  }, [collectionName, orderByField, refreshKey]);

  const processed = useMemo(
    () => processCollectionData(rawData, { filter, page, pageSize, select, sort }),
    [
      filter,
      page,
      pageSize,
      rawData,
      select,
      sort,
    ],
  );

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const applyOptimisticUpdate = useCallback((updater) => {
    setRawData((currentData) => {
      const nextData = updater(currentData);
      collectionCache.set(collectionName, nextData);
      return nextData;
    });
  }, [collectionName]);

  return {
    ...processed,
    rawData,
    loading,
    error,
    isCached: collectionCache.has(collectionName),
    refresh,
    applyOptimisticUpdate,
  };
}
