import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase/firebaseConfig";

const toDocumentData = (snapshot) =>
  snapshot.docs.map((document) => ({ ...document.data(), _docId: document.id }));

const getCollectionReference = (collectionName) => collection(db, collectionName);

export function subscribeToCollection(
  collectionName,
  { onData, onError, orderByField = null },
) {
  const reference = getCollectionReference(collectionName);
  const collectionQuery = orderByField ? query(reference, orderBy(orderByField)) : reference;

  return onSnapshot(
    collectionQuery,
    (snapshot) => onData(toDocumentData(snapshot)),
    (error) => onError?.(error),
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
  const employeeQuery = query(
    getCollectionReference("employees"),
    where("email", "==", email),
  );
  const snapshot = await getDocs(employeeQuery);

  return snapshot.empty ? null : snapshot.docs[0].data();
}
