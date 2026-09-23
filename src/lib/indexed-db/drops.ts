import type { encodeDropEnvelope } from "../../../shared/drop/codecs/envelope-v1";
import { NULDOWN_DROPS_STORE, openNulldownDatabase } from "./database";
import { requestToPromise, waitForTransaction } from "./transaction";

/** Persisted browser record for one local drop. */
export interface IndexedDbDropRecord {
  id: string;
  content?: string;
  metadata?: Record<string, unknown>;
  storageFormat?: "legacy" | "sealed_v1";
  sealedEnvelope?: ReturnType<typeof encodeDropEnvelope>;
  createdAt: number;
  updatedAt: number;
}

/** Stores one local drop record. */
export const putOfflineDrop = async (
  record: IndexedDbDropRecord,
): Promise<void> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULDOWN_DROPS_STORE, "readwrite");
  transaction.objectStore(NULDOWN_DROPS_STORE).put(record);
  await waitForTransaction(transaction);
};

/** Reads one local drop record. */
export const getOfflineDrop = async (
  id: string,
): Promise<IndexedDbDropRecord | null> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULDOWN_DROPS_STORE, "readonly");
  const result = await requestToPromise<IndexedDbDropRecord | undefined>(
    transaction.objectStore(NULDOWN_DROPS_STORE).get(id),
    `Failed to read offline drop "${id}"`,
  );
  await waitForTransaction(transaction);
  return result ?? null;
};

/** Lists every local drop record. */
export const listOfflineDrops = async (): Promise<IndexedDbDropRecord[]> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULDOWN_DROPS_STORE, "readonly");
  const result = await requestToPromise<IndexedDbDropRecord[]>(
    transaction.objectStore(NULDOWN_DROPS_STORE).getAll(),
    "Failed to list offline drops",
  );
  await waitForTransaction(transaction);
  return result ?? [];
};

/** Removes one local drop record. */
export const removeOfflineDrop = async (id: string): Promise<void> => {
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULDOWN_DROPS_STORE, "readwrite");
  transaction.objectStore(NULDOWN_DROPS_STORE).delete(id);
  await waitForTransaction(transaction);
};
