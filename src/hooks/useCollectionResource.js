import { useCallback, useState } from "react";
import { createDocument, deleteDocument, updateDocument } from "../services/firestoreService";
import { useAuthenticatedCollection } from "./useAuthenticatedCollection";

export function useCollectionResource(collectionName, options) {
  const collection = useAuthenticatedCollection(collectionName, options);
  const [mutationError, setMutationError] = useState(null);
  const [pendingCount, setPendingCount] = useState(0);

  const runMutation = useCallback(async (operation, optimisticUpdate) => {
    setMutationError(null);
    setPendingCount((count) => count + 1);

    let rollback;
    if (optimisticUpdate) {
      rollback = optimisticUpdate(collection.applyOptimisticUpdate);
    }

    try {
      return await operation();
    } catch (error) {
      rollback?.();
      setMutationError(error);
      throw error;
    } finally {
      setPendingCount((count) => count - 1);
    }
  }, [collection.applyOptimisticUpdate]);

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
    mutationError,
    isMutating: pendingCount > 0,
  };
}
