export const DIFF_OUTBOX_EVENTS_STORE = "diffOutboxEvents";
export const DIFF_OUTBOX_BRANCH_STATE_STORE = "diffOutboxBranchState";
export const DIFF_OUTBOX_BRANCH_QUEUE_INDEX = "byBranchQueueOrder";

/** Registers durable diff-outbox stores during a Nulldown database upgrade. */
export const upgradeDiffOutboxSchema = (database: IDBDatabase): void => {
  if (!database.objectStoreNames.contains(DIFF_OUTBOX_EVENTS_STORE)) {
    const events = database.createObjectStore(DIFF_OUTBOX_EVENTS_STORE, {
      keyPath: ["rootId", "branchId", "eventId"],
    });
    events.createIndex(
      DIFF_OUTBOX_BRANCH_QUEUE_INDEX,
      ["rootId", "branchId", "queueOrder"],
      { unique: true },
    );
  }
  if (!database.objectStoreNames.contains(DIFF_OUTBOX_BRANCH_STATE_STORE)) {
    database.createObjectStore(DIFF_OUTBOX_BRANCH_STATE_STORE, {
      keyPath: ["rootId", "branchId"],
    });
  }
};
