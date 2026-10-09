import { useCallback, useState } from "react";
import { findRecordById } from "../services/legacyShape.js";
import { useAuthenticatedCollection } from "./useAuthenticatedCollection";

export function withCollectionSubscription(collectionAccess, readPlan) {
  return {
    ...collectionAccess,
    enabled: collectionAccess?.enabled === true && readPlan?.enabled === true,
    subscription: {
      ...collectionAccess?.subscription,
      queryScope: readPlan?.queryScope || "disabled",
      fetch: readPlan?.fetch,
    },
  };
}

/**
 * A polled list plus create / update / remove through a domain service (services/*Service.js).
 *
 *   - `create` never sends a client-generated id: the server makes it, and `create` resolves THAT id.
 *   - `update` hands the service the record the page last read (`original`), so only changed fields are sent.
 *   - After a successful write the list is polled straight away, so it reflects the write when the promise
 *     resolves rather than up to a poll interval later.
 *   - `run(operation)` is for writes that are not plain create/update/remove (a leave decision, a cancel).
 */
export function useCollectionResource(collectionName, options) {
  const { service, ...collectionOptions } = options;
  const collection = useAuthenticatedCollection(collectionName, collectionOptions);
  const [mutationFailure, setMutationFailure] = useState({
    cacheIdentity: null,
    error: null,
  });
  const [pendingCount, setPendingCount] = useState(0);
  const { applyOptimisticUpdate, cacheIdentity, rawData, refresh } = collection;

  const runMutation = useCallback(async (operation, optimisticUpdate) => {
    const mutationIdentity = cacheIdentity;
    setMutationFailure({ cacheIdentity: mutationIdentity, error: null });
    setPendingCount((count) => count + 1);

    let rollback;
    if (optimisticUpdate) {
      rollback = optimisticUpdate(applyOptimisticUpdate);
    }

    try {
      const result = await operation();
      // The write succeeded; failing to re-read the list must not turn it into a failed write.
      await refresh().catch(() => {});
      return result;
    } catch (error) {
      rollback?.();
      setMutationFailure({ cacheIdentity: mutationIdentity, error });
      throw error;
    } finally {
      setPendingCount((count) => count - 1);
    }
  }, [applyOptimisticUpdate, cacheIdentity, refresh]);

  const create = useCallback((data, optimisticUpdate) =>
    runMutation(() => service.create(data), optimisticUpdate).then((created) => created?.id),
  [runMutation, service]);

  const update = useCallback((id, updates, optimisticUpdate) =>
    runMutation(
      () => service.update(id, updates, { original: findRecordById(rawData, id) ?? undefined }),
      optimisticUpdate,
    ),
  [rawData, runMutation, service]);

  const remove = useCallback((id, optimisticUpdate) =>
    runMutation(() => service.remove(id), optimisticUpdate),
  [runMutation, service]);

  return {
    ...collection,
    create,
    update,
    remove,
    run: runMutation,
    mutationError: mutationFailure.cacheIdentity === collection.cacheIdentity
      ? mutationFailure.error
      : null,
    isMutating: pendingCount > 0,
  };
}
