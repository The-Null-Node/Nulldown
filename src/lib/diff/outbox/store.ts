import { openNulldownDatabase } from "../../indexed-db/database";
import {
  abortTransaction,
  requestToPromise,
  waitForTransaction,
} from "../../indexed-db/transaction";
import {
  DIFF_OUTBOX_BRANCH_QUEUE_INDEX,
  DIFF_OUTBOX_BRANCH_STATE_STORE,
  DIFF_OUTBOX_EVENTS_STORE,
} from "./schema";
import {
  assertLeaseInput,
  assertScope,
  createBranchDraft,
  eventIdentityPayload,
  hasActiveWriterLease,
  isEventStatus,
  isNonEmptyString,
  leaseExpiresAt,
  nowFor,
  parseBranchState,
  parseEvent,
  parseEventRecord,
  type BlockDiffOutboxEventForWriterInput,
  type ClearDiffOutboxBranchDraftIfEmptyInput,
  type DiffOutboxBranchDraft,
  type DiffOutboxEventIdentity,
  type DiffOutboxEventRecord,
  type DiffOutboxLeaseInput,
  type DiffOutboxScope,
  type DiffOutboxWriterLease,
  type DiscardDiffOutboxScopeInput,
  type EnqueueDiffOutboxEventInput,
  type PersistDiffOutboxBranchDraftInput,
  type ReleaseDiffOutboxLeaseInput,
  type UpdateDiffOutboxEventStatusInput,
} from "./records";

const eventKey = (identity: DiffOutboxEventIdentity): IDBValidKey[] => [
  identity.rootId,
  identity.branchId,
  identity.eventId,
];

const branchKey = (scope: DiffOutboxScope): IDBValidKey[] => [
  scope.rootId,
  scope.branchId,
];

/** Atomically appends an immutable event and optional current branch draft. */
export const enqueueDiffOutboxEvent = async (
  input: EnqueueDiffOutboxEventInput,
): Promise<DiffOutboxEventRecord> => {
  assertScope(input);
  const event = parseEvent(input.event);
  if (event.dropId !== input.rootId) {
    throw new Error("Diff outbox event dropId must match its rootId.");
  }

  const now = nowFor(input.now);
  const draft = input.draft ? createBranchDraft(input.draft, now) : undefined;
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    [DIFF_OUTBOX_EVENTS_STORE, DIFF_OUTBOX_BRANCH_STATE_STORE],
    "readwrite",
  );
  const events = transaction.objectStore(DIFF_OUTBOX_EVENTS_STORE);
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);

  try {
    const state = parseBranchState(
      await requestToPromise<unknown>(
        states.get(branchKey(input)),
        "Failed to read diff outbox branch state",
      ),
      input,
    );
    if (input.ownerId && !hasActiveWriterLease(state, input.ownerId, now)) {
      throw new Error("Diff outbox writer lease is no longer active.");
    }
    const identity = { ...input, eventId: event.eventId };
    const existingValue = await requestToPromise<unknown>(
      events.get(eventKey(identity)),
      "Failed to read diff outbox event",
    );
    if (existingValue !== undefined) {
      const existing = parseEventRecord(existingValue);
      if (
        eventIdentityPayload(existing.event) !== eventIdentityPayload(event)
      ) {
        transaction.abort();
        throw new Error(
          `Diff outbox event ${event.eventId} already exists with different data.`,
        );
      }
      if (draft) {
        states.put({ ...state, draft });
      }
      await waitForTransaction(transaction);
      return existing;
    }

    const record: DiffOutboxEventRecord = {
      rootId: input.rootId,
      branchId: input.branchId,
      eventId: event.eventId,
      queueOrder: state.nextQueueOrder,
      event,
      status: "queued",
      retryCount: 0,
      enqueuedAt: now,
      updatedAt: now,
    };
    events.add(record);
    states.put({
      ...state,
      nextQueueOrder: state.nextQueueOrder + 1,
      ...(draft ? { draft } : {}),
    });
    await waitForTransaction(transaction);
    return record;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Returns whether an unexpired writer lease still belongs to the given browser tab. */
export const hasDiffOutboxWriterLease = async (
  input: ReleaseDiffOutboxLeaseInput & { now?: number },
): Promise<boolean> => {
  assertScope(input);
  if (!isNonEmptyString(input.ownerId)) {
    throw new Error("Diff outbox lease ownerId must be a non-empty string.");
  }
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readonly",
  );
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);
  try {
    const state = parseBranchState(
      await requestToPromise<unknown>(
        states.get(branchKey(input)),
        "Failed to read diff outbox branch state",
      ),
      input,
    );
    await waitForTransaction(transaction);
    return hasActiveWriterLease(state, input.ownerId, nowFor(input.now));
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Reads the durable unsynchronized draft for one branch. */
export const readDiffOutboxBranchDraft = async (
  scope: DiffOutboxScope,
): Promise<DiffOutboxBranchDraft | null> => {
  assertScope(scope);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readonly",
  );
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);
  try {
    const state = parseBranchState(
      await requestToPromise<unknown>(
        states.get(branchKey(scope)),
        "Failed to read diff outbox branch state",
      ),
      scope,
    );
    await waitForTransaction(transaction);
    return state.draft ?? null;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Persists the latest unsynchronized draft for one branch. */
export const persistDiffOutboxBranchDraft = async (
  input: PersistDiffOutboxBranchDraftInput,
): Promise<DiffOutboxBranchDraft> => {
  assertScope(input);
  const now = nowFor(input.now);
  const draft = createBranchDraft(input, now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readwrite",
  );
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);
  try {
    const state = parseBranchState(
      await requestToPromise<unknown>(
        states.get(branchKey(input)),
        "Failed to read diff outbox branch state",
      ),
      input,
    );
    states.put({ ...state, draft });
    await waitForTransaction(transaction);
    return draft;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Removes one branch draft without changing queued events. */
export const clearDiffOutboxBranchDraft = async (
  scope: DiffOutboxScope,
): Promise<boolean> => {
  assertScope(scope);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readwrite",
  );
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);
  try {
    const state = parseBranchState(
      await requestToPromise<unknown>(
        states.get(branchKey(scope)),
        "Failed to read diff outbox branch state",
      ),
      scope,
    );
    if (!state.draft) {
      await waitForTransaction(transaction);
      return false;
    }
    states.put({
      rootId: state.rootId,
      branchId: state.branchId,
      nextQueueOrder: state.nextQueueOrder,
      ...(state.lease ? { lease: state.lease } : {}),
    });
    await waitForTransaction(transaction);
    return true;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Clears a branch draft only when the scoped outbox remains empty under the active writer lease. */
export const clearDiffOutboxBranchDraftIfEmptyForWriter = async (
  input: ClearDiffOutboxBranchDraftIfEmptyInput,
): Promise<boolean> => {
  assertScope(input);
  if (!isNonEmptyString(input.ownerId)) {
    throw new Error("Diff outbox draft cleanup input is invalid.");
  }
  const now = nowFor(input.now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    [DIFF_OUTBOX_EVENTS_STORE, DIFF_OUTBOX_BRANCH_STATE_STORE],
    "readwrite",
  );
  const events = transaction.objectStore(DIFF_OUTBOX_EVENTS_STORE);
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);
  try {
    const state = parseBranchState(
      await requestToPromise<unknown>(
        states.get(branchKey(input)),
        "Failed to read diff outbox branch state",
      ),
      input,
    );
    if (!hasActiveWriterLease(state, input.ownerId, now)) {
      await waitForTransaction(transaction);
      return false;
    }
    const queue = events.index(DIFF_OUTBOX_BRANCH_QUEUE_INDEX);
    const range = IDBKeyRange.bound(
      [input.rootId, input.branchId, 0],
      [input.rootId, input.branchId, Number.MAX_SAFE_INTEGER],
    );
    const records = await requestToPromise<unknown[]>(
      queue.getAll(range),
      "Failed to list diff outbox events",
    );
    if (records.length > 0) {
      await waitForTransaction(transaction);
      return false;
    }
    if (!state.draft) {
      await waitForTransaction(transaction);
      return true;
    }
    states.put({
      rootId: state.rootId,
      branchId: state.branchId,
      nextQueueOrder: state.nextQueueOrder,
      lease: state.lease,
    });
    await waitForTransaction(transaction);
    return true;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Clears a conflicted branch outbox only while the caller still holds its writer lease. */
export const discardDiffOutboxScopeForWriter = async (
  input: DiscardDiffOutboxScopeInput,
): Promise<boolean> => {
  assertScope(input);
  if (!isNonEmptyString(input.ownerId)) {
    throw new Error("Diff outbox lease ownerId must be a non-empty string.");
  }

  const now = nowFor(input.now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    [DIFF_OUTBOX_EVENTS_STORE, DIFF_OUTBOX_BRANCH_STATE_STORE],
    "readwrite",
  );
  const events = transaction.objectStore(DIFF_OUTBOX_EVENTS_STORE);
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);
  try {
    const state = parseBranchState(
      await requestToPromise<unknown>(
        states.get(branchKey(input)),
        "Failed to read diff outbox branch state",
      ),
      input,
    );
    if (
      !state.lease ||
      state.lease.ownerId !== input.ownerId ||
      state.lease.expiresAt <= now
    ) {
      await waitForTransaction(transaction);
      return false;
    }

    const queue = events.index(DIFF_OUTBOX_BRANCH_QUEUE_INDEX);
    const range = IDBKeyRange.bound(
      [input.rootId, input.branchId, 0],
      [input.rootId, input.branchId, Number.MAX_SAFE_INTEGER],
    );
    const records = await requestToPromise<unknown[]>(
      queue.getAll(range),
      "Failed to list diff outbox events",
    );
    records.map(parseEventRecord).forEach((record) => {
      events.delete(eventKey(record));
    });
    states.put({
      rootId: state.rootId,
      branchId: state.branchId,
      nextQueueOrder: state.nextQueueOrder,
      lease: state.lease,
    });
    await waitForTransaction(transaction);
    return true;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Lists one branch queue in durable FIFO order. */
export const listDiffOutboxEvents = async (
  scope: DiffOutboxScope,
): Promise<DiffOutboxEventRecord[]> => {
  assertScope(scope);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(DIFF_OUTBOX_EVENTS_STORE, "readonly");
  const index = transaction
    .objectStore(DIFF_OUTBOX_EVENTS_STORE)
    .index(DIFF_OUTBOX_BRANCH_QUEUE_INDEX);
  const range = IDBKeyRange.bound(
    [scope.rootId, scope.branchId, 0],
    [scope.rootId, scope.branchId, Number.MAX_SAFE_INTEGER],
  );
  const values = await requestToPromise<unknown[]>(
    index.getAll(range),
    "Failed to list diff outbox events",
  );
  await waitForTransaction(transaction);
  return values.map(parseEventRecord);
};

/** Removes one confirmed event, optionally fenced by the active writer lease. */
export const acknowledgeDiffOutboxEvent = async (
  identity: DiffOutboxEventIdentity,
  writer?: ReleaseDiffOutboxLeaseInput & { now?: number },
): Promise<boolean> => {
  assertScope(identity);
  if (!isNonEmptyString(identity.eventId)) {
    throw new Error("Diff outbox eventId must be a non-empty string.");
  }
  if (writer) {
    assertScope(writer);
    if (
      writer.rootId !== identity.rootId ||
      writer.branchId !== identity.branchId ||
      !isNonEmptyString(writer.ownerId)
    ) {
      throw new Error("Diff outbox writer identity is invalid.");
    }
  }

  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    writer
      ? [DIFF_OUTBOX_EVENTS_STORE, DIFF_OUTBOX_BRANCH_STATE_STORE]
      : DIFF_OUTBOX_EVENTS_STORE,
    "readwrite",
  );
  const events = transaction.objectStore(DIFF_OUTBOX_EVENTS_STORE);
  try {
    if (writer) {
      const state = parseBranchState(
        await requestToPromise<unknown>(
          transaction
            .objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE)
            .get(branchKey(writer)),
          "Failed to read diff outbox branch state",
        ),
        writer,
      );
      if (!hasActiveWriterLease(state, writer.ownerId, nowFor(writer.now))) {
        await waitForTransaction(transaction);
        return false;
      }
    }
    const value = await requestToPromise<unknown>(
      events.get(eventKey(identity)),
      "Failed to read diff outbox event",
    );
    if (value === undefined) {
      await waitForTransaction(transaction);
      return false;
    }
    parseEventRecord(value);
    events.delete(eventKey(identity));
    await waitForTransaction(transaction);
    return true;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Changes one event's retry disposition without mutating its envelope. */
export const updateDiffOutboxEventStatus = async (
  input: UpdateDiffOutboxEventStatusInput,
  writer?: ReleaseDiffOutboxLeaseInput & { now?: number },
): Promise<DiffOutboxEventRecord | null> => {
  assertScope(input);
  if (!isNonEmptyString(input.eventId) || !isEventStatus(input.status)) {
    throw new Error("Diff outbox event status update is invalid.");
  }
  if (writer) {
    assertScope(writer);
    if (
      writer.rootId !== input.rootId ||
      writer.branchId !== input.branchId ||
      !isNonEmptyString(writer.ownerId)
    ) {
      throw new Error("Diff outbox writer identity is invalid.");
    }
  }

  const now = nowFor(input.now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    writer
      ? [DIFF_OUTBOX_EVENTS_STORE, DIFF_OUTBOX_BRANCH_STATE_STORE]
      : DIFF_OUTBOX_EVENTS_STORE,
    "readwrite",
  );
  const events = transaction.objectStore(DIFF_OUTBOX_EVENTS_STORE);
  try {
    if (writer) {
      const state = parseBranchState(
        await requestToPromise<unknown>(
          transaction
            .objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE)
            .get(branchKey(writer)),
          "Failed to read diff outbox branch state",
        ),
        writer,
      );
      if (!hasActiveWriterLease(state, writer.ownerId, nowFor(writer.now))) {
        await waitForTransaction(transaction);
        return null;
      }
    }
    const value = await requestToPromise<unknown>(
      events.get(eventKey(input)),
      "Failed to read diff outbox event",
    );
    if (value === undefined) {
      await waitForTransaction(transaction);
      return null;
    }

    const existing = parseEventRecord(value);
    const updated: DiffOutboxEventRecord = {
      ...existing,
      status: input.status,
      retryCount:
        input.status === "retry"
          ? existing.retryCount + 1
          : existing.retryCount,
      updatedAt: now,
    };
    events.put(updated);
    await waitForTransaction(transaction);
    return updated;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Blocks a local event only while the caller still holds the active writer lease. */
export const blockDiffOutboxEventForWriter = async (
  input: BlockDiffOutboxEventForWriterInput,
): Promise<DiffOutboxEventRecord | null> => {
  assertScope(input);
  if (!isNonEmptyString(input.eventId) || !isNonEmptyString(input.ownerId)) {
    throw new Error(
      "Diff outbox eventId and lease ownerId must be non-empty strings.",
    );
  }

  const now = nowFor(input.now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    [DIFF_OUTBOX_EVENTS_STORE, DIFF_OUTBOX_BRANCH_STATE_STORE],
    "readwrite",
  );
  const events = transaction.objectStore(DIFF_OUTBOX_EVENTS_STORE);
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);
  try {
    const state = parseBranchState(
      await requestToPromise<unknown>(
        states.get(branchKey(input)),
        "Failed to read diff outbox branch state",
      ),
      input,
    );
    if (
      !state.lease ||
      state.lease.ownerId !== input.ownerId ||
      state.lease.expiresAt <= now
    ) {
      await waitForTransaction(transaction);
      return null;
    }
    const value = await requestToPromise<unknown>(
      events.get(eventKey(input)),
      "Failed to read diff outbox event",
    );
    if (value === undefined) {
      await waitForTransaction(transaction);
      return null;
    }
    const existing = parseEventRecord(value);
    const updated: DiffOutboxEventRecord = {
      ...existing,
      status: "blocked",
      updatedAt: now,
    };
    events.put(updated);
    await waitForTransaction(transaction);
    return updated;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Acquires or explicitly takes over the browser writer lease for one branch. */
export const acquireDiffOutboxWriterLease = async (
  input: DiffOutboxLeaseInput,
): Promise<DiffOutboxWriterLease | null> => {
  assertLeaseInput(input);
  const now = nowFor(input.now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readwrite",
  );
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);
  try {
    const state = parseBranchState(
      await requestToPromise<unknown>(
        states.get(branchKey(input)),
        "Failed to read diff outbox branch state",
      ),
      input,
    );
    if (
      state.lease &&
      state.lease.ownerId !== input.ownerId &&
      state.lease.expiresAt > now &&
      !input.force
    ) {
      await waitForTransaction(transaction);
      return null;
    }

    const lease: DiffOutboxWriterLease = {
      rootId: input.rootId,
      branchId: input.branchId,
      ownerId: input.ownerId,
      expiresAt: leaseExpiresAt(now, input.leaseDurationMs),
    };
    states.put({ ...state, lease });
    await waitForTransaction(transaction);
    return lease;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Renews the caller's active browser writer lease. */
export const renewDiffOutboxWriterLease = async (
  input: DiffOutboxLeaseInput,
): Promise<DiffOutboxWriterLease | null> => {
  assertLeaseInput(input);
  const now = nowFor(input.now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readwrite",
  );
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);
  try {
    const state = parseBranchState(
      await requestToPromise<unknown>(
        states.get(branchKey(input)),
        "Failed to read diff outbox branch state",
      ),
      input,
    );
    if (
      !state.lease ||
      state.lease.ownerId !== input.ownerId ||
      state.lease.expiresAt <= now
    ) {
      await waitForTransaction(transaction);
      return null;
    }

    const lease: DiffOutboxWriterLease = {
      rootId: input.rootId,
      branchId: input.branchId,
      ownerId: input.ownerId,
      expiresAt: leaseExpiresAt(now, input.leaseDurationMs),
    };
    states.put({ ...state, lease });
    await waitForTransaction(transaction);
    return lease;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Releases the caller's browser writer lease without dropping durable edits. */
export const releaseDiffOutboxWriterLease = async (
  input: ReleaseDiffOutboxLeaseInput,
): Promise<boolean> => {
  assertScope(input);
  if (!isNonEmptyString(input.ownerId)) {
    throw new Error("Diff outbox lease ownerId must be a non-empty string.");
  }

  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readwrite",
  );
  const states = transaction.objectStore(DIFF_OUTBOX_BRANCH_STATE_STORE);
  try {
    const value = await requestToPromise<unknown>(
      states.get(branchKey(input)),
      "Failed to read diff outbox branch state",
    );
    if (value === undefined) {
      await waitForTransaction(transaction);
      return false;
    }

    const state = parseBranchState(value, input);
    if (!state.lease || state.lease.ownerId !== input.ownerId) {
      await waitForTransaction(transaction);
      return false;
    }

    states.put({
      rootId: state.rootId,
      branchId: state.branchId,
      nextQueueOrder: state.nextQueueOrder,
      ...(state.draft ? { draft: state.draft } : {}),
    });
    await waitForTransaction(transaction);
    return true;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
};

/** Browser persistence operations available to diff-sync orchestration. */
export interface DiffOutboxStore {
  enqueue: typeof enqueueDiffOutboxEvent;
  hasWriterLease: typeof hasDiffOutboxWriterLease;
  readDraft: typeof readDiffOutboxBranchDraft;
  persistDraft: typeof persistDiffOutboxBranchDraft;
  clearDraft: typeof clearDiffOutboxBranchDraft;
  clearDraftIfEmptyForWriter: typeof clearDiffOutboxBranchDraftIfEmptyForWriter;
  discardForWriter: typeof discardDiffOutboxScopeForWriter;
  listEvents: typeof listDiffOutboxEvents;
  acknowledgeEvent: typeof acknowledgeDiffOutboxEvent;
  updateEventStatus: typeof updateDiffOutboxEventStatus;
  blockEventForWriter: typeof blockDiffOutboxEventForWriter;
  acquireWriterLease: typeof acquireDiffOutboxWriterLease;
  renewWriterLease: typeof renewDiffOutboxWriterLease;
  releaseWriterLease: typeof releaseDiffOutboxWriterLease;
}

/** Process-independent IndexedDB adapter for durable diff outbox operations. */
export const indexedDbDiffOutboxStore: DiffOutboxStore = {
  enqueue: enqueueDiffOutboxEvent,
  hasWriterLease: hasDiffOutboxWriterLease,
  readDraft: readDiffOutboxBranchDraft,
  persistDraft: persistDiffOutboxBranchDraft,
  clearDraft: clearDiffOutboxBranchDraft,
  clearDraftIfEmptyForWriter: clearDiffOutboxBranchDraftIfEmptyForWriter,
  discardForWriter: discardDiffOutboxScopeForWriter,
  listEvents: listDiffOutboxEvents,
  acknowledgeEvent: acknowledgeDiffOutboxEvent,
  updateEventStatus: updateDiffOutboxEventStatus,
  blockEventForWriter: blockDiffOutboxEventForWriter,
  acquireWriterLease: acquireDiffOutboxWriterLease,
  renewWriterLease: renewDiffOutboxWriterLease,
  releaseWriterLease: releaseDiffOutboxWriterLease,
};
