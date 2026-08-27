import { useCallback, useState } from "react";
import { createDocument, deleteDocument, updateDocument } from "../services/firestoreService";
import { useAuthenticatedCollection } from "./useAuthenticatedCollection";

export function withCollectionSubscription(collectionAccess, readPlan) {
  return {
    ...collectionAccess,
    enabled: collectionAccess?.enabled === true && readPlan?.enabled === true,
    subscription: {
      ...collectionAccess?.subscription,
      queryScope: readPlan?.queryScope || "disabled",
      sources: Array.isArray(readPlan?.sources) ? readPlan.sources : [],
    },
  };
}

export function useCollectionResource(collectionName, options) {
  const collection = useAuthenticatedCollection(collectionName, options);
  const [mutationFailure, setMutationFailure] = useState({
    cacheIdentity: null,
    error: null,
  });
  const [pendingCount, setPendingCount] = useState(0);

  const runMutation = useCallback(async (operation, optimisticUpdate) => {
    const mutationIdentity = collection.cacheIdentity;
    setMutationFailure({ cacheIdentity: mutationIdentity, error: null });
    setPendingCount((count) => count + 1);

    let rollback;
    if (optimisticUpdate) {
      rollback = optimisticUpdate(collection.applyOptimisticUpdate);
    }

    try {
      return await operation();
    } catch (error) {
      rollback?.();
      setMutationFailure({ cacheIdentity: mutationIdentity, error });
      throw error;
    } finally {
      setPendingCount((count) => count - 1);
    }
  }, [collection.applyOptimisticUpdate, collection.cacheIdentity]);

  const create = useCallback((data, id = Date.now(), optimisticUpdate) =>
    runMutation(
      () => createDocument(collectionName, id, { ...data, id }),
      optimisticUpdate,
    ).then(() => id),
  [collectionName, runMutation]);

  const update = useCallback((id, updates, optimisticUpdate) =>
    runMutation(
      () => updateDocument(collectionName, id, updates),
      optimisticUpdate,
    ),
  [collectionName, runMutation]);

  const remove = useCallback((id, optimisticUpdate) =>
    runMutation(
      () => deleteDocument(collectionName, id),
      optimisticUpdate,
    ),
  [collectionName, runMutation]);

  return {
    ...collection,
    create,
    update,
    remove,
    mutationError: mutationFailure.cacheIdentity === collection.cacheIdentity
      ? mutationFailure.error
      : null,
    isMutating: pendingCount > 0,
  };
}
