import { DropDiffEventSchema } from "../../../../shared/drop/codecs/diff-v1";
import type { DropDiffEvent } from "../../../../shared/drop/diff";
import { serializeCanonicalJson } from "../../../../shared/drop/types";

export type DiffOutboxEventStatus = "queued" | "retry" | "blocked";

/** Persisted queue record for one immutable diff event. */
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

/** Persisted ownership lease for one browser branch writer. */
export interface DiffOutboxWriterLease {
  rootId: string;
  branchId: string;
  ownerId: string;
  expiresAt: number;
}

/** Persisted unsynchronized editor content for one branch. */
export interface DiffOutboxBranchDraft {
  version: 1;
  content: string;
  updatedAt: number;
}

/** Persisted queue cursor and browser-writer state for one branch. */
export interface DiffOutboxBranchState {
  rootId: string;
  branchId: string;
  nextQueueOrder: number;
  lease?: DiffOutboxWriterLease;
  draft?: DiffOutboxBranchDraft;
}

/** Stable root and branch identity for outbox operations. */
export interface DiffOutboxScope {
  rootId: string;
  branchId: string;
}

/** Input for atomically enqueueing an event and optional branch draft. */
export interface EnqueueDiffOutboxEventInput extends DiffOutboxScope {
  event: DropDiffEvent;
  draft?: DiffOutboxBranchDraftInput;
  ownerId?: string;
  now?: number;
}

/** Unversioned draft input normalized before persistence. */
export interface DiffOutboxBranchDraftInput {
  content: string;
  updatedAt?: number;
}

/** Input for replacing the persisted draft of one branch. */
export interface PersistDiffOutboxBranchDraftInput
  extends DiffOutboxScope, DiffOutboxBranchDraftInput {
  now?: number;
}

/** Stable persisted identity of one queued event. */
export interface DiffOutboxEventIdentity extends DiffOutboxScope {
  eventId: string;
}

/** Input for changing one queued event's durable disposition. */
export interface UpdateDiffOutboxEventStatusInput extends DiffOutboxEventIdentity {
  status: DiffOutboxEventStatus;
  now?: number;
}

/** Writer-fenced input for blocking one queued event. */
export interface BlockDiffOutboxEventForWriterInput extends DiffOutboxEventIdentity {
  ownerId: string;
  now?: number;
}

/** Input for acquiring or renewing a browser writer lease. */
export interface DiffOutboxLeaseInput extends DiffOutboxScope {
  ownerId: string;
  leaseDurationMs: number;
  /** Explicitly replaces another browser tab's lease. */
  force?: boolean;
  now?: number;
}

/** Identity required to release a browser writer lease. */
export interface ReleaseDiffOutboxLeaseInput extends DiffOutboxScope {
  ownerId: string;
}

/** Writer-fenced input for removing an empty branch's draft. */
export interface ClearDiffOutboxBranchDraftIfEmptyInput extends ReleaseDiffOutboxLeaseInput {
  now?: number;
}

/** Writer-fenced input for discarding queued events and draft state. */
export interface DiscardDiffOutboxScopeInput extends ReleaseDiffOutboxLeaseInput {
  now?: number;
}

/** Returns whether a decoded identifier is a canonical non-empty string. */
export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0;

/** Returns whether a decoded value is a non-negative safe integer. */
export const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Returns whether a decoded value is a positive safe integer. */
export const isPositiveInteger = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value > 0;

/** Returns whether a decoded value is a supported durable event status. */
export const isEventStatus = (value: unknown): value is DiffOutboxEventStatus =>
  value === "queued" || value === "retry" || value === "blocked";

/** Validates and decodes one persisted branch draft. */
export const parseBranchDraft = (value: unknown): DiffOutboxBranchDraft => {
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
  return { version: 1, content: draft.content, updatedAt: draft.updatedAt };
};

/** Rejects malformed root and branch identities at the persistence boundary. */
export const assertScope = (scope: DiffOutboxScope): void => {
  if (!isNonEmptyString(scope.rootId) || !isNonEmptyString(scope.branchId)) {
    throw new Error(
      "Diff outbox rootId and branchId must be non-empty strings.",
    );
  }
};

/** Validates and decodes one immutable diff event. */
export const parseEvent = (value: unknown): DropDiffEvent => {
  const parsed = DropDiffEventSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid diff outbox event envelope.");
  return parsed.data;
};

/** Validates and decodes one persisted outbox event record. */
export const parseEventRecord = (value: unknown): DiffOutboxEventRecord => {
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

/** Validates and decodes one branch state, or creates its empty initial state. */
export const parseBranchState = (
  value: unknown,
  scope: DiffOutboxScope,
): DiffOutboxBranchState => {
  if (value === undefined) return { ...scope, nextQueueOrder: 0 };
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
  if (state.draft !== undefined)
    normalized.draft = parseBranchDraft(state.draft);
  return normalized;
};

/** Serializes an event for immutable duplicate-identity comparison. */
export const eventIdentityPayload = (event: DropDiffEvent): string =>
  serializeCanonicalJson(event);

/** Resolves and validates the timestamp used by one persistence operation. */
export const nowFor = (now: number | undefined): number => {
  const value = now ?? Date.now();
  if (!isNonNegativeInteger(value)) {
    throw new Error("Diff outbox time must be a non-negative integer.");
  }
  return value;
};

/** Normalizes an unversioned draft into its persisted version-one record. */
export const createBranchDraft = (
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

/** Rejects malformed writer lease acquisition and renewal input. */
export const assertLeaseInput = (input: DiffOutboxLeaseInput): void => {
  assertScope(input);
  if (
    !isNonEmptyString(input.ownerId) ||
    !isPositiveInteger(input.leaseDurationMs)
  ) {
    throw new Error(
      "Diff outbox lease ownerId and leaseDurationMs are invalid.",
    );
  }
};

/** Computes a validated writer lease expiration timestamp. */
export const leaseExpiresAt = (
  now: number,
  leaseDurationMs: number,
): number => {
  const expiresAt = now + leaseDurationMs;
  if (!isNonNegativeInteger(expiresAt)) {
    throw new Error("Diff outbox lease expiration is invalid.");
  }
  return expiresAt;
};

/** Returns whether branch state contains the caller's unexpired writer lease. */
export const hasActiveWriterLease = (
  state: DiffOutboxBranchState,
  ownerId: string,
  now: number,
): boolean =>
  Boolean(
    state.lease &&
    state.lease.ownerId === ownerId &&
    state.lease.expiresAt > now,
  );
