/*
IndexedDB is the durable browser storage layer for encrypted drops and structured app
state. `kv` stores generic settings and caches, while `drops` stores offline envelopes
that must remain readable across page reloads and browser restarts.
*/

import type { DropEnvelopeV1 } from "../../shared/drop/types";

const DB_NAME = "nulldown";
const DB_VERSION = 2;
const KV_STORE = "kv";
const DROPS_STORE = "drops";
export const NULLDOWN_DIFF_OUTBOX_EVENTS_STORE = "diffOutboxEvents";
export const NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE = "diffOutboxBranchState";
export const NULLDOWN_DIFF_OUTBOX_BRANCH_QUEUE_INDEX = "byBranchQueueOrder";

export interface IndexedDbDropRecord {
  id: string;
  content?: string;
  metadata?: Record<string, unknown>;
  storageFormat?: "legacy" | "sealed_v1";
  sealedEnvelope?: DropEnvelopeV1;
  createdAt: number;
  updatedAt: number;
}

let databasePromise: Promise<IDBDatabase> | null = null;

const getRequestError = (message: string, error: DOMException | null) =>
  error ? new Error(`${message}: ${error.message}`) : new Error(message);

const requestToPromise = <T>(
  request: IDBRequest<T>,
  message: string,
): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(getRequestError(message, request.error));
  });

const waitForTransaction = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        getRequestError("IndexedDB transaction failed", transaction.error),
      );
    transaction.onabort = () =>
      reject(
        getRequestError("IndexedDB transaction aborted", transaction.error),
      );
  });

export const isIndexedDbSupported = () =>
  typeof window !== "undefined" && typeof window.indexedDB !== "undefined";

export const openNulldownDatabase = async (): Promise<IDBDatabase> => {
  if (!isIndexedDbSupported()) {
    throw new Error("IndexedDB is unavailable in this environment.");
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(KV_STORE)) {
          db.createObjectStore(KV_STORE);
        }
        if (!db.objectStoreNames.contains(DROPS_STORE)) {
          // Offline drops are keyed by canonical id because short ids are only aliases.
          const dropsStore = db.createObjectStore(DROPS_STORE, {
            keyPath: "id",
          });
          dropsStore.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(NULLDOWN_DIFF_OUTBOX_EVENTS_STORE)) {
          const eventsStore = db.createObjectStore(
            NULLDOWN_DIFF_OUTBOX_EVENTS_STORE,
            { keyPath: ["rootId", "branchId", "eventId"] },
          );
          eventsStore.createIndex(
            NULLDOWN_DIFF_OUTBOX_BRANCH_QUEUE_INDEX,
            ["rootId", "branchId", "queueOrder"],
            { unique: true },
          );
        }
        if (!db.objectStoreNames.contains(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE)) {
          db.createObjectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE, {
            keyPath: ["rootId", "branchId"],
          });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        const openingPromise = databasePromise;
        db.onversionchange = () => {
          db.close();
          if (databasePromise === openingPromise) {
            databasePromise = null;
          }
        };
        resolve(db);
      };

      request.onerror = () => {
        databasePromise = null;
        reject(getRequestError("Failed to open IndexedDB", request.error));
      };

      request.onblocked = () => {
        console.warn(
          "IndexedDB open request is blocked by another open connection.",
        );
      };
    });
  }

  return databasePromise;
};

export const getKvItem = async (key: string): Promise<string | null> => {
  const result = await getKvValue<unknown>(key);

  if (result === undefined || result === null) {
    return null;
  }

  return String(result);
};

export const getKvValue = async <T>(key: string): Promise<T | null> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(KV_STORE, "readonly");
  const store = transaction.objectStore(KV_STORE);
  const result = await requestToPromise<unknown>(
    store.get(key),
    `Failed to read key "${key}"`,
  );
  await waitForTransaction(transaction);

  if (result === undefined || result === null) {
    return null;
  }

  return result as T;
};

/** Atomically writes several KV values in one IndexedDB transaction. */
export const setKvValues = async (
  entries: readonly { key: string; value: unknown }[],
  canWrite: () => boolean = () => true,
  guard?: { key: string; expectedValue: unknown },
): Promise<void> => {
  const db = await openNulldownDatabase();
  if (!canWrite()) {
    throw new Error("IndexedDB write was cancelled.");
  }
  const transaction = db.transaction(KV_STORE, "readwrite");
  const completion = waitForTransaction(transaction);
  const store = transaction.objectStore(KV_STORE);
  if (guard) {
    const currentValue = await requestToPromise<unknown>(
      store.get(guard.key),
      `Failed to read write guard "${guard.key}"`,
    );
    if ((currentValue ?? null) !== (guard.expectedValue ?? null) || !canWrite()) {
      transaction.abort();
      await completion;
    }
  }
  for (const entry of entries) {
    store.put(entry.value, entry.key);
  }
  await completion;
};

export const setKvItem = async (key: string, value: string): Promise<void> => {
  await setKvValue(key, value);
};

export const setKvValue = async (
  key: string,
  value: unknown,
): Promise<void> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(KV_STORE, "readwrite");
  const store = transaction.objectStore(KV_STORE);
  store.put(value, key);
  await waitForTransaction(transaction);
};

export const removeKvItem = async (key: string): Promise<void> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(KV_STORE, "readwrite");
  const store = transaction.objectStore(KV_STORE);
  store.delete(key);
  await waitForTransaction(transaction);
};

export const clearKvStore = async (): Promise<void> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(KV_STORE, "readwrite");
  const store = transaction.objectStore(KV_STORE);
  store.clear();
  await waitForTransaction(transaction);
};

export const setKvItems = async (
  items: Record<string, string>,
): Promise<void> => {
  const entries = Object.entries(items);
  if (!entries.length) return;

  const db = await openNulldownDatabase();
  const transaction = db.transaction(KV_STORE, "readwrite");
  const store = transaction.objectStore(KV_STORE);

  entries.forEach(([key, value]) => {
    store.put(value, key);
  });

  await waitForTransaction(transaction);
};

export const removeKvItems = async (keys: string[]): Promise<void> => {
  if (!keys.length) return;

  const db = await openNulldownDatabase();
  const transaction = db.transaction(KV_STORE, "readwrite");
  const store = transaction.objectStore(KV_STORE);

  keys.forEach((key) => {
    store.delete(key);
  });

  await waitForTransaction(transaction);
};

export const putOfflineDrop = async (
  record: IndexedDbDropRecord,
): Promise<void> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(DROPS_STORE, "readwrite");
  const store = transaction.objectStore(DROPS_STORE);
  store.put(record);
  await waitForTransaction(transaction);
};

export const getOfflineDrop = async (
  id: string,
): Promise<IndexedDbDropRecord | null> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(DROPS_STORE, "readonly");
  const store = transaction.objectStore(DROPS_STORE);
  const result = await requestToPromise<IndexedDbDropRecord | undefined>(
    store.get(id),
    `Failed to read offline drop "${id}"`,
  );
  await waitForTransaction(transaction);
  return result ?? null;
};

export const listOfflineDrops = async (): Promise<IndexedDbDropRecord[]> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(DROPS_STORE, "readonly");
  const store = transaction.objectStore(DROPS_STORE);
  const result = await requestToPromise<IndexedDbDropRecord[]>(
    store.getAll(),
    "Failed to list offline drops",
  );
  await waitForTransaction(transaction);
  return result ?? [];
};

export const removeOfflineDrop = async (id: string): Promise<void> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(DROPS_STORE, "readwrite");
  const store = transaction.objectStore(DROPS_STORE);
  store.delete(id);
  await waitForTransaction(transaction);
};

export const resetNulldownDatabaseForTests = async (
  options: { deleteDatabase?: boolean } = {},
): Promise<void> => {
  const database = await databasePromise?.catch(() => null);
  databasePromise = null;
  database?.close();

  if (options.deleteDatabase === false || !isIndexedDbSupported()) return;

  const request = window.indexedDB.deleteDatabase(DB_NAME);
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(getRequestError("Failed to delete IndexedDB database", request.error));
    request.onblocked = () =>
      reject(new Error("IndexedDB deletion is blocked by another open connection."));
  });
};
