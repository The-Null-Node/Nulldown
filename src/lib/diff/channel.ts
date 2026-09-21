import type {
  DropBranchRuntimeFact,
  DropDiffAppendResponse,
  DropDiffEvent,
  DropDiffEventMetadata,
  DropDiffOp,
} from "../../../shared/drop/diff";
import { serializeCanonicalJson } from "../../../shared/drop/types";

/** One received branch transport batch. */
export interface DiffChannelBatch {
  events: DropDiffEvent[];
  facts: DropBranchRuntimeFact[];
}

export type DiffChannelListener = (batch: DiffChannelBatch) => void;

/** Runtime transport contract for one actively edited drop. */
export interface DiffChannel {
  readonly dropId: string;
  readonly clientId: string;
  publish: (
    ops: DropDiffOp[],
    options?: DiffChannelPublishOptions,
  ) => Promise<DiffChannelPublishAck[]>;
  publishEvent: (event: DropDiffEvent) => Promise<DropDiffAppendResponse>;
  poll: () => Promise<DiffChannelBatch>;
  subscribe: (listener: DiffChannelListener) => () => void;
  start: () => void;
  stop: () => void;
  readonly cursor: string | null;
  readonly factCursor: string | null;
}

/** Optional stable identity supplied when publishing or retrying an event. */
export interface DiffChannelPublishOptions {
  metadata?: DropDiffEventMetadata;
  eventId?: string;
  createdAt?: number;
}

export type DiffChannelPublishAck =
  DropDiffAppendResponse["acknowledgements"][number];

/** Structured transport failure consumed by durable retry policy. */
export class DiffChannelError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(input: {
    message: string;
    status?: number | null;
    code?: string | null;
  }) {
    super(input.message);
    this.name = "DiffChannelError";
    this.status = input.status ?? null;
    this.code = input.code ?? null;
  }
}

let globalEventCounter = 0;

/** Creates a browser client identity when one is not supplied by composition. */
export const createDiffChannelClientId = (): string => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

/** Creates the next process-local event identity for a channel client. */
export const createDiffChannelEventId = (clientId: string): string => {
  globalEventCounter += 1;
  return `${clientId}:${Date.now()}:${globalEventCounter}`;
};

/** Serializes the immutable portion of an event for retry-identity checks. */
export const serializeDiffChannelEventIdentity = (
  event: DropDiffEvent,
): string =>
  serializeCanonicalJson({
    eventId: event.eventId,
    dropId: event.dropId,
    sourceClientId: event.sourceClientId,
    createdAt: event.createdAt,
    ops: event.ops,
    metadata: event.metadata,
  });
