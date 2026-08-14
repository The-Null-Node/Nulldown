import type {
  DropDiffAppendResponse,
  DropDiffEvent,
  DropDiffEventMetadata,
  DropDiffOp,
} from "../../../shared/drop/diff";
import { isDropDiffAppendResponse } from "../../../shared/drop/diff";
import { DropDiffEventSchema } from "../../../shared/drop/diffSchemas";
import {
  acknowledgeDiffOutboxEvent,
  clearDiffOutboxBranchDraft,
  clearDiffOutboxBranchDraftIfEmptyForWriter,
  enqueueDiffOutboxEvent,
  listDiffOutboxEvents,
  updateDiffOutboxEventStatus,
  type DiffOutboxEventRecord,
  type DiffOutboxBranchDraftInput,
  type DiffOutboxScope,
} from "./diffOutboxStore";

/** Retry categories retained by the outbox for a later ordered replay. */
export const DIFF_OUTBOX_RETRY_ERROR_CLASSIFICATIONS = [
  "transport",
  "unknown",
  "transient",
] as const;

/** The reason an event remains queued for a later retry. */
export type DiffOutboxRetryErrorClassification =
  (typeof DIFF_OUTBOX_RETRY_ERROR_CLASSIFICATIONS)[number];

/** The durable outbox disposition for a failed publish attempt. */
export type DiffOutboxErrorClassification =
  | DiffOutboxRetryErrorClassification
  | "blocked";

/** Input used to prepare one immutable event before it enters a branch outbox. */
export interface PrepareDiffOutboxEventInput {
  rootId: string;
  clientId: string;
  ops: DropDiffOp[];
  metadata?: DropDiffEventMetadata;
  branchHeadSeq: number;
  eventId?: string;
  createdAt?: number;
}

/** Input used to persist and optionally send one prepared branch event. */
export interface SubmitDiffOutboxEventInput
  extends PrepareDiffOutboxEventInput,
    DiffOutboxScope {
  /** Current optimistic branch text retained only while this event is unresolved. */
  draft?: DiffOutboxBranchDraftInput;
  /** Active browser writer lease required for remote branch queue writes. */
  ownerId?: string;
}

/** The data provided to an outbox transport for one ordered event. */
export interface DiffOutboxTransportInput extends DiffOutboxScope {
  event: DropDiffEvent;
}

/** Injectable transport boundary for sending one persisted event. */
export type DiffOutboxTransport = (
  input: DiffOutboxTransportInput,
) => Promise<unknown>;

/** Optional deterministic dependencies for the browser outbox. */
export interface CreateDiffOutboxOptions {
  transport: DiffOutboxTransport;
  /** Confirms the caller still owns the branch writer lease before each send. */
  canDrain?: (scope: DiffOutboxScope) => Promise<boolean>;
  /** Active browser writer used to fence post-send durable mutations. */
  writerId?: string;
  createEventId?: (input: PrepareDiffOutboxEventInput) => string;
  now?: () => number;
}

/** Result of draining one branch scope until it is empty or cannot advance. */
export interface DiffOutboxDrainResult {
  status: "empty" | "drained" | "retry" | "blocked";
  sentCount: number;
  record?: DiffOutboxEventRecord;
  retryClassification?: DiffOutboxRetryErrorClassification;
}

/** Non-React browser service for durable, ordered diff publication. */
export interface DiffOutbox {
  prepare: (input: PrepareDiffOutboxEventInput) => DropDiffEvent;
  enqueue: (input: SubmitDiffOutboxEventInput) => Promise<DiffOutboxEventRecord>;
  submit: (input: SubmitDiffOutboxEventInput) => Promise<DiffOutboxDrainResult>;
  drain: (scope: DiffOutboxScope) => Promise<DiffOutboxDrainResult>;
}

const TERMINAL_ERROR_CODES = new Set([
  "diff_predecessor_mismatch",
  "diff_event_id_reused",
  "diff_event_identity_invalid",
]);

const TRANSIENT_ERROR_CODES = new Set([
  "branch_lock_timeout",
  "branch_lock_lost_before_commit",
  "timeout",
  "timed_out",
  "rate_limited",
  "temporarily_unavailable",
  "service_unavailable",
]);

const UNKNOWN_ACKNOWLEDGEMENT_CODE = "diff_outbox_acknowledgement_unknown";

let generatedEventCounter = 0;

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const isBranchHeadSeq = (value: unknown): value is number =>
  isInteger(value) && value >= -1;

const defaultCreateEventId = (input: PrepareDiffOutboxEventInput): string => {
  generatedEventCounter += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `outbox-${crypto.randomUUID()}`;
  }
  return `outbox-${input.clientId}-${Date.now()}-${generatedEventCounter}`;
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const freezeJson = (value: unknown): void => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  Object.values(value).forEach(freezeJson);
};

const scopeKey = (scope: DiffOutboxScope): string =>
  JSON.stringify([scope.rootId, scope.branchId]);

const hasMatchingAcknowledgement = (
  response: unknown,
  scope: DiffOutboxScope,
  eventId: string,
): response is DropDiffAppendResponse =>
  isDropDiffAppendResponse(response) &&
  response.branchId === scope.branchId &&
  response.acknowledgements.filter((acknowledgement) => acknowledgement.eventId === eventId)
    .length === 1;

/**
 * Classifies unknown error values by their structural `status` and `code` fields.
 * It deliberately does not depend on a transport-specific error class.
 */
export const classifyDiffOutboxError = (
  error: unknown,
): DiffOutboxErrorClassification => {
  if (typeof error !== "object" || error === null) return "transport";

  const details = error as { status?: unknown; code?: unknown };
  const status = details.status;
  const code = details.code;

  if (typeof code === "string") {
    if (TERMINAL_ERROR_CODES.has(code)) return "blocked";
    if (code === UNKNOWN_ACKNOWLEDGEMENT_CODE) return "unknown";
    if (TRANSIENT_ERROR_CODES.has(code)) return "transient";
  }

  if (isInteger(status)) {
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return "blocked";
    }
    return "transient";
  }

  return code === undefined && status === undefined ? "transport" : "unknown";
};

/** Creates a durable, FIFO outbox scoped by root and branch. */
export const createDiffOutbox = (options: CreateDiffOutboxOptions): DiffOutbox => {
  const now = options.now ?? Date.now;
  const createEventId = options.createEventId ?? defaultCreateEventId;
  const drainingScopes = new Map<string, Promise<DiffOutboxDrainResult>>();

  const prepare = (input: PrepareDiffOutboxEventInput): DropDiffEvent => {
    if (!isBranchHeadSeq(input.branchHeadSeq)) {
      throw new Error("Diff outbox branchHeadSeq must be an integer greater than or equal to -1.");
    }
    if ((input.eventId === undefined) !== (input.createdAt === undefined)) {
      throw new Error("Diff outbox retries must provide eventId and createdAt together.");
    }

    const event = {
      eventId: input.eventId ?? createEventId(input),
      seq: -1,
      dropId: input.rootId,
      sourceClientId: input.clientId,
      createdAt: input.createdAt ?? now(),
      ops: cloneJson(input.ops),
      metadata: cloneJson({ ...input.metadata, followsSeq: input.branchHeadSeq }),
    };
    const parsed = DropDiffEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error("Invalid diff outbox event.");
    }

    freezeJson(parsed.data);
    return parsed.data;
  };

  const enqueue = async (
    input: SubmitDiffOutboxEventInput,
  ): Promise<DiffOutboxEventRecord> =>
    enqueueDiffOutboxEvent({
      rootId: input.rootId,
      branchId: input.branchId,
      event: prepare(input),
      draft: input.draft,
      ownerId: input.ownerId,
      now: now(),
    });

  const drainScope = async (
    scope: DiffOutboxScope,
  ): Promise<DiffOutboxDrainResult> => {
    let sentCount = 0;

    while (true) {
      const record = (await listDiffOutboxEvents(scope))[0];
      if (!record) {
        const cleared = options.writerId
          ? await clearDiffOutboxBranchDraftIfEmptyForWriter({
              ...scope,
              ownerId: options.writerId,
              now: now(),
            })
          : await clearDiffOutboxBranchDraft(scope);
        if (options.writerId && !cleared) {
          return {
            status: "retry",
            sentCount,
            retryClassification: "transport",
          };
        }
        return { status: sentCount === 0 ? "empty" : "drained", sentCount };
      }
      if (record.status === "blocked") {
        return { status: "blocked", sentCount, record };
      }
      if (options.canDrain && !(await options.canDrain(scope))) {
        return {
          status: "retry",
          sentCount,
          record,
          retryClassification: "transport",
        };
      }

      try {
        const response = await options.transport({ ...scope, event: record.event });
        if (!hasMatchingAcknowledgement(response, scope, record.eventId)) {
          const retryClassification = "unknown" as const;
          const updated = await updateDiffOutboxEventStatus({
            ...scope,
            eventId: record.eventId,
            status: "retry",
            now: now(),
          }, options.writerId ? { ...scope, ownerId: options.writerId, now: now() } : undefined);
          if (!updated && options.writerId) {
            return {
              status: "retry",
              sentCount,
              record,
              retryClassification: "transport",
            };
          }
          return {
            status: "retry",
            sentCount,
            record: updated ?? record,
            retryClassification,
          };
        }

        const acknowledged = await acknowledgeDiffOutboxEvent(
          { ...scope, eventId: record.eventId },
          options.writerId ? { ...scope, ownerId: options.writerId, now: now() } : undefined,
        );
        if (!acknowledged && options.writerId) {
          return {
            status: "retry",
            sentCount,
            record,
            retryClassification: "transport",
          };
        }
        sentCount += 1;
      } catch (error) {
        const classification = classifyDiffOutboxError(error);
        if (classification === "blocked") {
          const updated = await updateDiffOutboxEventStatus({
            ...scope,
            eventId: record.eventId,
            status: "blocked",
            now: now(),
          }, options.writerId ? { ...scope, ownerId: options.writerId, now: now() } : undefined);
          if (!updated && options.writerId) {
            return {
              status: "retry",
              sentCount,
              record,
              retryClassification: "transport",
            };
          }
          return { status: "blocked", sentCount, record: updated ?? record };
        }

        const updated = await updateDiffOutboxEventStatus({
          ...scope,
          eventId: record.eventId,
          status: "retry",
          now: now(),
        }, options.writerId ? { ...scope, ownerId: options.writerId, now: now() } : undefined);
        if (!updated && options.writerId) {
          return {
            status: "retry",
            sentCount,
            record,
            retryClassification: "transport",
          };
        }
        return {
          status: "retry",
          sentCount,
          record: updated ?? record,
          retryClassification: classification,
        };
      }
    }
  };

  const drain = (scope: DiffOutboxScope): Promise<DiffOutboxDrainResult> => {
    const key = scopeKey(scope);
    const activeDrain = drainingScopes.get(key);
    if (activeDrain) return activeDrain;

    const drainPromise = drainScope(scope).finally(() => {
      drainingScopes.delete(key);
    });
    drainingScopes.set(key, drainPromise);
    return drainPromise;
  };

  const submit = async (
    input: SubmitDiffOutboxEventInput,
  ): Promise<DiffOutboxDrainResult> => {
    await enqueue(input);
    return drain(input);
  };

  return { prepare, enqueue, submit, drain };
};
