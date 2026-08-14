import type { DropDiffEvent } from "../../../shared/drop/diff";
import { DropDiffEventSchema } from "../../../shared/drop/diffSchemas";
import { serializeCanonicalJson } from "../../../shared/drop/types";
import {
  NULLDOWN_DIFF_OUTBOX_BRANCH_QUEUE_INDEX,
  NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE,
  NULLDOWN_DIFF_OUTBOX_EVENTS_STORE,
  openNulldownDatabase,
} from "../indexedDb";

export type DiffOutboxEventStatus = "queued" | "retry" | "blocked";

export interface DiffOutboxEventRecord {
  rootId: string;
  branchId: string;
  eventId: string;
  queueOrder: number;
  event: DropDiffEvent;
  status: DiffOutboxEventStatus;
  retryCount: number;
  enqueuedAt: number;
  updatedAt: number;
}

export interface DiffOutboxWriterLease {
  rootId: string;
  branchId: string;
  ownerId: string;
  expiresAt: number;
}

export interface DiffOutboxBranchDraft {
  version: 1;
  content: string;
  updatedAt: number;
}

interface DiffOutboxBranchState {
  rootId: string;
  branchId: string;
  nextQueueOrder: number;
  lease?: DiffOutboxWriterLease;
  draft?: DiffOutboxBranchDraft;
}

export interface DiffOutboxScope {
  rootId: string;
  branchId: string;
}

export interface EnqueueDiffOutboxEventInput extends DiffOutboxScope {
  event: DropDiffEvent;
  draft?: DiffOutboxBranchDraftInput;
  ownerId?: string;
  now?: number;
}

export interface DiffOutboxBranchDraftInput {
  content: string;
  updatedAt?: number;
}

export interface PersistDiffOutboxBranchDraftInput
  extends DiffOutboxScope,
    DiffOutboxBranchDraftInput {
  now?: number;
}

export interface DiffOutboxEventIdentity extends DiffOutboxScope {
  eventId: string;
}

export interface DiffOutboxWriterEventIdentity extends DiffOutboxEventIdentity {
  ownerId: string;
  now?: number;
}

export interface UpdateDiffOutboxEventStatusInput
  extends DiffOutboxEventIdentity {
  status: DiffOutboxEventStatus;
  now?: number;
}

export interface BlockDiffOutboxEventForWriterInput extends DiffOutboxEventIdentity {
  ownerId: string;
  now?: number;
}

export interface DiffOutboxLeaseInput extends DiffOutboxScope {
  ownerId: string;
  leaseDurationMs: number;
  /** Explicitly replaces another browser tab's lease. */
  force?: boolean;
  now?: number;
}

export interface ReleaseDiffOutboxLeaseInput extends DiffOutboxScope {
  ownerId: string;
}

export interface ClearDiffOutboxBranchDraftIfEmptyInput
  extends ReleaseDiffOutboxLeaseInput {
  now?: number;
}

export interface DiscardDiffOutboxScopeInput extends ReleaseDiffOutboxLeaseInput {
  now?: number;
}

const requestToPromise = <T>(request: IDBRequest<T>, message: string) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error
          ? new Error(`${message}: ${request.error.message}`)
          : new Error(message),
      );
  });

const waitForTransaction = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error
          ? new Error(`IndexedDB transaction failed: ${transaction.error.message}`)
          : new Error("IndexedDB transaction failed"),
      );
    transaction.onabort = () =>
      reject(
        transaction.error
          ? new Error(`IndexedDB transaction aborted: ${transaction.error.message}`)
          : new Error("IndexedDB transaction aborted"),
      );
  });

const abortTransaction = (transaction: IDBTransaction): void => {
  try {
    transaction.abort();
  } catch {
    // The request failure may already have aborted the transaction.
  }
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value > 0;

const isEventStatus = (value: unknown): value is DiffOutboxEventStatus =>
  value === "queued" || value === "retry" || value === "blocked";

const parseBranchDraft = (value: unknown): DiffOutboxBranchDraft => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid diff outbox branch draft.");
  }

  const draft = value as Record<string, unknown>;
  if (
    draft.version !== 1 ||
    typeof draft.content !== "string" ||
    !isNonNegativeInteger(draft.updatedAt)
  ) {
    throw new Error("Invalid diff outbox branch draft.");
  }

  return {
    version: 1,
    content: draft.content,
    updatedAt: draft.updatedAt,
  };
};

const assertScope = (scope: DiffOutboxScope): void => {
  if (!isNonEmptyString(scope.rootId) || !isNonEmptyString(scope.branchId)) {
    throw new Error("Diff outbox rootId and branchId must be non-empty strings.");
  }
};

const parseEvent = (value: unknown): DropDiffEvent => {
  const parsed = DropDiffEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid diff outbox event envelope.");
  }
  return parsed.data;
};

const parseEventRecord = (value: unknown): DiffOutboxEventRecord => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid diff outbox event record.");
  }

  const record = value as Record<string, unknown>;
  const event = parseEvent(record.event);
  if (
    !isNonEmptyString(record.rootId) ||
    !isNonEmptyString(record.branchId) ||
    !isNonEmptyString(record.eventId) ||
    !isNonNegativeInteger(record.queueOrder) ||
    !isEventStatus(record.status) ||
    !isNonNegativeInteger(record.retryCount) ||
    !isNonNegativeInteger(record.enqueuedAt) ||
    !isNonNegativeInteger(record.updatedAt) ||
    event.dropId !== record.rootId ||
    event.eventId !== record.eventId
  ) {
    throw new Error("Invalid diff outbox event record.");
  }

  return {
    rootId: record.rootId,
    branchId: record.branchId,
    eventId: record.eventId,
    queueOrder: record.queueOrder,
    event,
    status: record.status,
    retryCount: record.retryCount,
    enqueuedAt: record.enqueuedAt,
    updatedAt: record.updatedAt,
  };
};

const parseBranchState = (
  value: unknown,
  scope: DiffOutboxScope,
): DiffOutboxBranchState => {
  if (value === undefined) {
    return { ...scope, nextQueueOrder: 0 };
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid diff outbox branch state.");
  }

  const state = value as Record<string, unknown>;
  if (
    state.rootId !== scope.rootId ||
    state.branchId !== scope.branchId ||
    !isNonNegativeInteger(state.nextQueueOrder)
  ) {
    throw new Error("Invalid diff outbox branch state.");
  }

  const normalized: DiffOutboxBranchState = {
    rootId: scope.rootId,
    branchId: scope.branchId,
    nextQueueOrder: state.nextQueueOrder,
  };
  if (state.lease !== undefined) {
    if (typeof state.lease !== "object" || state.lease === null) {
      throw new Error("Invalid diff outbox writer lease.");
    }

    const lease = state.lease as Record<string, unknown>;
    if (
      lease.rootId !== scope.rootId ||
      lease.branchId !== scope.branchId ||
      !isNonEmptyString(lease.ownerId) ||
      !isNonNegativeInteger(lease.expiresAt)
    ) {
      throw new Error("Invalid diff outbox writer lease.");
    }
    normalized.lease = {
      rootId: scope.rootId,
      branchId: scope.branchId,
      ownerId: lease.ownerId,
      expiresAt: lease.expiresAt,
    };
  }
  if (state.draft !== undefined) {
    normalized.draft = parseBranchDraft(state.draft);
  }

  return normalized;
};

const eventKey = (identity: DiffOutboxEventIdentity): IDBValidKey[] => [
  identity.rootId,
  identity.branchId,
  identity.eventId,
];

const branchKey = (scope: DiffOutboxScope): IDBValidKey[] => [
  scope.rootId,
  scope.branchId,
];

const eventIdentityPayload = (event: DropDiffEvent): string =>
  serializeCanonicalJson(event);

const nowFor = (now: number | undefined): number => {
  const value = now ?? Date.now();
  if (!isNonNegativeInteger(value)) {
    throw new Error("Diff outbox time must be a non-negative integer.");
  }
  return value;
};

const createBranchDraft = (
  input: DiffOutboxBranchDraftInput,
  defaultUpdatedAt: number,
): DiffOutboxBranchDraft => {
  if (typeof input.content !== "string") {
    throw new Error("Diff outbox branch draft content must be a string.");
  }

  return {
    version: 1,
    content: input.content,
    updatedAt: nowFor(input.updatedAt ?? defaultUpdatedAt),
  };
};

const assertLeaseInput = (input: DiffOutboxLeaseInput): void => {
  assertScope(input);
  if (!isNonEmptyString(input.ownerId) || !isPositiveInteger(input.leaseDurationMs)) {
    throw new Error("Diff outbox lease ownerId and leaseDurationMs are invalid.");
  }
};

const leaseExpiresAt = (now: number, leaseDurationMs: number): number => {
  const expiresAt = now + leaseDurationMs;
  if (!isNonNegativeInteger(expiresAt)) {
    throw new Error("Diff outbox lease expiration is invalid.");
  }
  return expiresAt;
};

const hasActiveWriterLease = (
  state: DiffOutboxBranchState,
  ownerId: string,
  now: number,
): boolean =>
  Boolean(
    state.lease &&
      state.lease.ownerId === ownerId &&
      state.lease.expiresAt > now,
  );

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
    [NULLDOWN_DIFF_OUTBOX_EVENTS_STORE, NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE],
    "readwrite",
  );
  const events = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_EVENTS_STORE);
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);

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
      if (eventIdentityPayload(existing.event) !== eventIdentityPayload(event)) {
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
  const transaction = db.transaction(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE, "readonly");
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);
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

export const readDiffOutboxBranchDraft = async (
  scope: DiffOutboxScope,
): Promise<DiffOutboxBranchDraft | null> => {
  assertScope(scope);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE, "readonly");
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);
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

export const persistDiffOutboxBranchDraft = async (
  input: PersistDiffOutboxBranchDraftInput,
): Promise<DiffOutboxBranchDraft> => {
  assertScope(input);
  const now = nowFor(input.now);
  const draft = createBranchDraft(input, now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readwrite",
  );
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);
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

export const clearDiffOutboxBranchDraft = async (
  scope: DiffOutboxScope,
): Promise<boolean> => {
  assertScope(scope);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readwrite",
  );
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);
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
    [NULLDOWN_DIFF_OUTBOX_EVENTS_STORE, NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE],
    "readwrite",
  );
  const events = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_EVENTS_STORE);
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);
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
    const queue = events.index(NULLDOWN_DIFF_OUTBOX_BRANCH_QUEUE_INDEX);
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
    [NULLDOWN_DIFF_OUTBOX_EVENTS_STORE, NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE],
    "readwrite",
  );
  const events = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_EVENTS_STORE);
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);
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

    const queue = events.index(NULLDOWN_DIFF_OUTBOX_BRANCH_QUEUE_INDEX);
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

export const listDiffOutboxEvents = async (
  scope: DiffOutboxScope,
): Promise<DiffOutboxEventRecord[]> => {
  assertScope(scope);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(NULLDOWN_DIFF_OUTBOX_EVENTS_STORE, "readonly");
  const index = transaction
    .objectStore(NULLDOWN_DIFF_OUTBOX_EVENTS_STORE)
    .index(NULLDOWN_DIFF_OUTBOX_BRANCH_QUEUE_INDEX);
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
      ? [NULLDOWN_DIFF_OUTBOX_EVENTS_STORE, NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE]
      : NULLDOWN_DIFF_OUTBOX_EVENTS_STORE,
    "readwrite",
  );
  const events = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_EVENTS_STORE);
  try {
    if (writer) {
      const state = parseBranchState(
        await requestToPromise<unknown>(
          transaction
            .objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE)
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
      ? [NULLDOWN_DIFF_OUTBOX_EVENTS_STORE, NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE]
      : NULLDOWN_DIFF_OUTBOX_EVENTS_STORE,
    "readwrite",
  );
  const events = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_EVENTS_STORE);
  try {
    if (writer) {
      const state = parseBranchState(
        await requestToPromise<unknown>(
          transaction
            .objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE)
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
        input.status === "retry" ? existing.retryCount + 1 : existing.retryCount,
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
    throw new Error("Diff outbox eventId and lease ownerId must be non-empty strings.");
  }

  const now = nowFor(input.now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    [NULLDOWN_DIFF_OUTBOX_EVENTS_STORE, NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE],
    "readwrite",
  );
  const events = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_EVENTS_STORE);
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);
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

export const acquireDiffOutboxWriterLease = async (
  input: DiffOutboxLeaseInput,
): Promise<DiffOutboxWriterLease | null> => {
  assertLeaseInput(input);
  const now = nowFor(input.now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readwrite",
  );
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);
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

export const renewDiffOutboxWriterLease = async (
  input: DiffOutboxLeaseInput,
): Promise<DiffOutboxWriterLease | null> => {
  assertLeaseInput(input);
  const now = nowFor(input.now);
  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readwrite",
  );
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);
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

export const releaseDiffOutboxWriterLease = async (
  input: ReleaseDiffOutboxLeaseInput,
): Promise<boolean> => {
  assertScope(input);
  if (!isNonEmptyString(input.ownerId)) {
    throw new Error("Diff outbox lease ownerId must be a non-empty string.");
  }

  const db = await openNulldownDatabase();
  const transaction = db.transaction(
    NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE,
    "readwrite",
  );
  const states = transaction.objectStore(NULLDOWN_DIFF_OUTBOX_BRANCH_STATE_STORE);
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
