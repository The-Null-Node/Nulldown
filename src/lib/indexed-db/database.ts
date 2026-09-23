import { upgradeDiffOutboxSchema } from "../diff/outbox/schema";

const DB_NAME = "nulldown";
const DB_VERSION = 2;
export const NULDOWN_KEY_VALUE_STORE = "kv";
export const NULDOWN_DROPS_STORE = "drops";

let databasePromise: Promise<IDBDatabase> | null = null;

const getRequestError = (message: string, error: DOMException | null) =>
  error ? new Error(`${message}: ${error.message}`) : new Error(message);

/** Reports whether the current browser exposes IndexedDB. */
export const isIndexedDbSupported = () =>
  typeof window !== "undefined" && typeof window.indexedDB !== "undefined";

/** Opens the process-wide Nulldown browser database connection. */
export const openNulldownDatabase = async (): Promise<IDBDatabase> => {
  if (!isIndexedDbSupported()) {
    throw new Error("IndexedDB is unavailable in this environment.");
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(NULDOWN_KEY_VALUE_STORE)) {
          db.createObjectStore(NULDOWN_KEY_VALUE_STORE);
        }
        if (!db.objectStoreNames.contains(NULDOWN_DROPS_STORE)) {
          // Offline drops are keyed by canonical id because short ids are only aliases.
          const dropsStore = db.createObjectStore(NULDOWN_DROPS_STORE, {
            keyPath: "id",
          });
          dropsStore.createIndex("createdAt", "createdAt", { unique: false });
        }
        upgradeDiffOutboxSchema(db);
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
/** Closes and optionally deletes the shared browser database for isolated tests. */
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
      reject(
        getRequestError("Failed to delete IndexedDB database", request.error),
      );
    request.onblocked = () =>
      reject(
        new Error("IndexedDB deletion is blocked by another open connection."),
      );
  });
};
