import { NULDOWN_KEY_VALUE_STORE, openNulldownDatabase } from "./database";
import { requestToPromise, waitForTransaction } from "./transaction";

/** Reads a string-compatible value from the browser key-value store. */
export const getKvItem = async (key: string): Promise<string | null> => {
  const result = await getKvValue<unknown>(key);
  return result === undefined || result === null ? null : String(result);
};

/** Reads a typed value from the browser key-value store. */
export const getKvValue = async <T>(key: string): Promise<T | null> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULDOWN_KEY_VALUE_STORE, "readonly");
  const result = await requestToPromise<unknown>(
    transaction.objectStore(NULDOWN_KEY_VALUE_STORE).get(key),
    `Failed to read key "${key}"`,
  );
  await waitForTransaction(transaction);
  return result === undefined || result === null ? null : (result as T);
};

/** Atomically writes several values after optional cancellation and guard checks. */
export const setKvValues = async (
  entries: readonly { key: string; value: unknown }[],
  canWrite: () => boolean = () => true,
  guard?: { key: string; expectedValue: unknown },
): Promise<void> => {
  const db = await openNulldownDatabase();
  if (!canWrite()) throw new Error("IndexedDB write was cancelled.");

  const transaction = db.transaction(NULDOWN_KEY_VALUE_STORE, "readwrite");
  const completion = waitForTransaction(transaction);
  const store = transaction.objectStore(NULDOWN_KEY_VALUE_STORE);
  if (guard) {
    const currentValue = await requestToPromise<unknown>(
      store.get(guard.key),
      `Failed to read write guard "${guard.key}"`,
    );
    if (
      (currentValue ?? null) !== (guard.expectedValue ?? null) ||
      !canWrite()
    ) {
      transaction.abort();
      await completion;
    }
  }
  entries.forEach(({ key, value }) => store.put(value, key));
  await completion;
};

/** Writes one string value. */
export const setKvItem = async (key: string, value: string): Promise<void> => {
  await setKvValue(key, value);
};

/** Writes one value. */
export const setKvValue = async (
  key: string,
  value: unknown,
): Promise<void> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULDOWN_KEY_VALUE_STORE, "readwrite");
  transaction.objectStore(NULDOWN_KEY_VALUE_STORE).put(value, key);
  await waitForTransaction(transaction);
};

/** Removes one key-value entry. */
export const removeKvItem = async (key: string): Promise<void> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULDOWN_KEY_VALUE_STORE, "readwrite");
  transaction.objectStore(NULDOWN_KEY_VALUE_STORE).delete(key);
  await waitForTransaction(transaction);
};

/** Clears all key-value entries. */
export const clearKvStore = async (): Promise<void> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULDOWN_KEY_VALUE_STORE, "readwrite");
  transaction.objectStore(NULDOWN_KEY_VALUE_STORE).clear();
  await waitForTransaction(transaction);
};

/** Writes a string-keyed collection in one transaction. */
export const setKvItems = async (
  items: Record<string, string>,
): Promise<void> => {
  const entries = Object.entries(items);
  if (!entries.length) return;
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULDOWN_KEY_VALUE_STORE, "readwrite");
  const store = transaction.objectStore(NULDOWN_KEY_VALUE_STORE);
  entries.forEach(([key, value]) => store.put(value, key));
  await waitForTransaction(transaction);
};

/** Removes several key-value entries in one transaction. */
export const removeKvItems = async (keys: string[]): Promise<void> => {
  if (!keys.length) return;
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULDOWN_KEY_VALUE_STORE, "readwrite");
  const store = transaction.objectStore(NULDOWN_KEY_VALUE_STORE);
  keys.forEach((key) => store.delete(key));
  await waitForTransaction(transaction);
};
