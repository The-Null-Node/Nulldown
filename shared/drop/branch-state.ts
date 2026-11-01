import { z } from "zod";
import type { DropBranchRecord, DropSnapshotRecord } from "./branch";
import type { DropDiffEvent, DropDiffEventAcknowledgement } from "./diff";
import { DropDiffAppendEnvelopeSchema } from "./codecs/diff-v1";
import { DropDiffOperation } from "./diff-operation";
import { hashNulldownSourceContent } from "./resolved/hash";
import type { NulldownSourceHash } from "./resolved/types";
import { serializeCanonicalJson } from "./types";
import { MAX_BRANCH_ID_LENGTH } from "./branch-identity";

const token = z
  .string()
  .min(1)
  .max(120)
  .refine((s) => s.trim() === s);
const integer = z.number().int().nonnegative();
const hash = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);
const targetSchema = z
  .object({
    rootDropId: token,
    branchId: z
      .string()
      .min(1)
      .max(MAX_BRANCH_ID_LENGTH)
      .refine((s) => s.trim() === s),
  })
  .strict();
const placementSchema = z
  .object({
    routingVersion: integer.min(1),
    generation: integer,
  })
  .strict();
const versionSchema = z
  .object({
    snapshotId: integer,
    eventSeq: z.number().int().min(-1),
    sourceContentHash: hash,
  })
  .strict();

/** Exact branch identity; authorization is established outside this storage boundary. */
export interface BranchStateTarget {
  rootDropId: string;
  branchId: string;
}

/** Fenced placement identity. Backends reject unknown versions and stale generations, even on retries. */
export interface BranchStatePlacement {
  routingVersion: number;
  generation: number;
}

/** Exact materialized version. Hashes use the existing source-content hash domain. */
export interface BranchStateVersion {
  snapshotId: number;
  eventSeq: number;
  sourceContentHash: NulldownSourceHash;
}

/** RPC-safe head query; never resolves or creates a branch. */
export interface BranchHeadQuery {
  target: BranchStateTarget;
  placement: BranchStatePlacement;
}

/** Exact immutable snapshot query; no current-head or cross-authority fallback is permitted. */
export interface BranchContentQuery extends BranchHeadQuery {
  version: BranchStateVersion;
}

/** Inclusive, ascending, contiguous event range within an exact snapshot; at most 200 events. */
export interface BranchEventRangeQuery extends BranchContentQuery {
  startSeq: number;
  endSeq: number;
}

/** One atomic event append. Existing HTTP batches retain their legacy contract in this slice. */
export interface BranchAppendRecord extends BranchHeadQuery {
  expected: BranchStateVersion;
  event: DropDiffEvent;
  payloadHash: NulldownSourceHash;
}

/** Persisted, immutable acknowledgement. Replays return this exact record, not the latest head. */
export interface BranchCommitReceipt extends BranchHeadQuery {
  eventId: string;
  payloadHash: NulldownSourceHash;
  /** Assigned event sequence; absent on legacy single-event receipts, where version.eventSeq is identical. */
  eventSeq?: number;
  version: BranchStateVersion;
}

/** One authorized public envelope, captured before async work; predecessors remain optional event metadata. */
export interface BranchBatchAppendRecord extends BranchHeadQuery {
  events: DropDiffEvent[];
}

/** Data-only result for one atomic envelope; duplicate receipts retain their original snapshot identities. */
export interface BranchBatchAppendResult {
  branch: DropBranchRecord;
  snapshot: DropSnapshotRecord | null;
  content: string;
  acceptedEvents: DropDiffEvent[];
  deduplicatedCount: number;
  totalStored: number;
  acknowledgements: DropDiffEventAcknowledgement[];
}

/** One durable batch intent, sufficient to load its exact snapshot and accepted events for future delivery. */
export interface BranchBatchCommitOutboxRecord extends BranchContentQuery {
  id: string;
  kind: "branch.batch-commit.v1";
  parentSnapshotId: number;
  eventIds: string[];
  receipts: BranchCommitReceipt[];
  deduplicated: number;
  totalStored: number;
}

/** Per-call replay disposition is deliberately outside the immutable receipt. */
export interface BranchAppendOutcome {
  status: "accepted" | "duplicate";
  receipt: BranchCommitReceipt;
}

/** Exact durable head; branch head fields must agree with version. */
export interface BranchStateHead extends BranchHeadQuery {
  branch: DropBranchRecord;
  version: BranchStateVersion;
}

/** Content plus verified identity; empty content is a valid result. */
export interface BranchStateContent extends BranchContentQuery {
  content: string;
}

/** Minimal deterministic outbox intent committed with event, snapshot, head and receipt. */
export interface BranchCommitOutboxRecord {
  id: string;
  kind: "branch.commit.v1";
  receipt: BranchCommitReceipt;
}

/** Prepared branch-local transaction data; persistence implementations own atomic commit and fencing. */
export interface BranchPreparedCommit {
  branch: DropBranchRecord;
  snapshot: DropSnapshotRecord;
  event: DropDiffEvent;
  content: string;
  receipt: BranchCommitReceipt;
  outbox: BranchCommitOutboxRecord;
}

/** The only local transactional capabilities selected for this slice. No lifecycle, memory or projection fallback. */
export interface BranchCommitStatePlane {
  /** Generation fence precedes dedupe; matching identity precedes predecessor checks. All rows commit atomically. */
  append(command: BranchAppendRecord): Promise<BranchAppendOutcome>;
  /** Missing branches reject with branch_not_found; they are never initialized implicitly. */
  readHead(query: BranchHeadQuery): Promise<BranchStateHead>;
  /** Missing snapshots reject with snapshot_not_found; inconsistent hash/sequence rejects with snapshot_version_mismatch. */
  readContent(query: BranchContentQuery): Promise<BranchStateContent>;
  /** Missing events within a valid range are state_corrupt, never a silently partial range. */
  readEvents(query: BranchEventRangeQuery): Promise<DropDiffEvent[]>;
}

/** Branch authority with atomic public-envelope publication in addition to the original four capabilities. */
export interface BranchBatchStatePlane extends BranchCommitStatePlane {
  /** Deduplicates before checking optional predecessors; publishes one snapshot and no partial prefix. */
  appendBatch(
    command: BranchBatchAppendRecord,
  ): Promise<BranchBatchAppendResult>;
}

/** Local capability allowlist; every other capability fails explicitly instead of using legacy authority. */
export const requireBranchCommitCapability = (capability: string): void => {
  if (!["append", "head", "content", "event-range"].includes(capability)) {
    throw new BranchStateError("capability_unsupported");
  }
};

/** Content-free failure semantics for local/RPC callers; existing HTTP error translation remains unchanged. */
export const BRANCH_STATE_ERRORS = {
  forbidden: { status: 403, outcome: "not_committed", retry: "never" },
  branch_not_active: { status: 409, outcome: "not_committed", retry: "never" },
  source_hash_required: {
    status: 400,
    outcome: "not_committed",
    retry: "never",
  },
  stale_source: { status: 409, outcome: "not_committed", retry: "refresh" },
  idempotency_key_reused: {
    status: 409,
    outcome: "not_committed",
    retry: "never",
  },
  runtime_fact_sequence_exhausted: {
    status: 409,
    outcome: "not_committed",
    retry: "never",
  },
  invalid_command: { status: 400, outcome: "not_committed", retry: "never" },
  branch_not_found: { status: 404, outcome: "not_committed", retry: "never" },
  snapshot_not_found: { status: 404, outcome: "not_committed", retry: "never" },
  branch_initialization_pending: {
    status: 409,
    outcome: "not_committed",
    retry: "refresh",
  },
  branch_initialization_conflict: {
    status: 409,
    outcome: "not_committed",
    retry: "never",
  },
  routing_placement_mismatch: {
    status: 409,
    outcome: "not_committed",
    retry: "refresh",
  },
  routing_generation_mismatch: {
    status: 409,
    outcome: "not_committed",
    retry: "refresh",
  },
  routing_version_unsupported: {
    status: 409,
    outcome: "not_committed",
    retry: "never",
  },
  diff_predecessor_mismatch: {
    status: 409,
    outcome: "not_committed",
    retry: "refresh",
  },
  diff_event_id_reused: {
    status: 409,
    outcome: "not_committed",
    retry: "never",
  },
  snapshot_version_mismatch: {
    status: 409,
    outcome: "not_committed",
    retry: "refresh",
  },
  diff_sequence_exhausted: {
    status: 409,
    outcome: "not_committed",
    retry: "never",
  },
  state_corrupt: { status: 500, outcome: "unknown", retry: "never" },
  capability_unsupported: {
    status: 501,
    outcome: "not_committed",
    retry: "never",
  },
  state_unavailable: { status: 503, outcome: "unknown", retry: "same-command" },
} as const;

/** Portable failure with stable reason, outcome and retry advice; never includes document data. */
export class BranchStateError extends Error {
  constructor(readonly code: keyof typeof BRANCH_STATE_ERRORS) {
    super(code);
    this.name = "BranchStateError";
  }

  /** Returns a wire-safe failure record for an RPC boundary. */
  toRecord() {
    return { code: this.code, ...BRANCH_STATE_ERRORS[this.code] };
  }
}

const capture = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BranchStateError("invalid_command");
  return parsed.data;
};

const headQuerySchema = z
  .object({ target: targetSchema, placement: placementSchema })
  .strict();
const contentQuerySchema = headQuerySchema
  .extend({ version: versionSchema })
  .strict();
const rangeQuerySchema = contentQuerySchema
  .extend({ startSeq: integer, endSeq: integer })
  .strict()
  .refine(
    (q) =>
      q.endSeq >= q.startSeq &&
      q.endSeq - q.startSeq < 200 &&
      q.endSeq <= q.version.eventSeq,
  );

/** Captures query records and collision-free exact cache identities, including placement and all version fields. */
export class BranchStateQuery {
  /** Validates and defensively copies a head query. */
  static head(input: unknown): BranchHeadQuery {
    return capture(headQuerySchema, input);
  }
  /** Validates and defensively copies an exact content query. */
  static content(input: unknown): BranchContentQuery {
    return capture(contentQuerySchema, input) as BranchContentQuery;
  }
  /** Validates and defensively copies a bounded, nonempty range. */
  static range(input: unknown): BranchEventRangeQuery {
    return capture(rangeQuerySchema, input) as BranchEventRangeQuery;
  }
  /** Distinguishes branch IDs containing delimiters and snapshots sharing numeric IDs across branches. */
  static key(kind: "head" | "content" | "events", input: unknown): string {
    const query =
      kind === "head"
        ? this.head(input)
        : kind === "content"
          ? this.content(input)
          : this.range(input);
    return serializeCanonicalJson({ kind, query });
  }
}

/** Validated event command. Canonical identity excludes server-assigned seq/snapshotId, exactly as legacy dedupe. */
export class BranchAppendCommand {
  private constructor(private readonly record: BranchAppendRecord) {}

  /** Captures local intent and computes its canonical payload hash. expected and placement are fences, not event identity. */
  static async create(
    input: Omit<BranchAppendRecord, "payloadHash">,
  ): Promise<BranchAppendCommand> {
    if (!input || typeof input !== "object")
      throw new BranchStateError("invalid_command");
    const query = BranchStateQuery.head({
      target: input.target,
      placement: input.placement,
    });
    const expected = capture(
      versionSchema,
      input.expected,
    ) as BranchStateVersion;
    const parsed = capture(DropDiffAppendEnvelopeSchema, {
      version: 1,
      events: [input.event],
    }).events[0];
    if (
      parsed.dropId !== query.target.rootDropId ||
      parsed.metadata?.followsSeq !== expected.eventSeq
    ) {
      throw new BranchStateError("invalid_command");
    }
    // Reuse rich operation validation, preserving native operation precedence and legacy record fields.
    try {
      parsed.ops = parsed.ops.map((op) =>
        DropDiffOperation.fromRecord(op).toRecord(),
      );
    } catch {
      throw new BranchStateError("invalid_command");
    }
    const event: DropDiffEvent = { ...parsed, seq: -1 };
    delete event.snapshotId;
    const identity = {
      eventId: event.eventId,
      dropId: event.dropId,
      sourceClientId: event.sourceClientId,
      createdAt: event.createdAt,
      ops: event.ops,
      metadata: event.metadata,
    };
    const payloadHash = await hashNulldownSourceContent(
      `nulldown.branch-event.v1\n${serializeCanonicalJson(identity)}`,
    );
    return new BranchAppendCommand({ ...query, expected, event, payloadHash });
  }

  /** Revalidates an RPC record, including its supplied hash; callers cannot forge the dedupe identity. */
  static async fromRecord(
    input: BranchAppendRecord,
  ): Promise<BranchAppendCommand> {
    if (!input || typeof input !== "object")
      throw new BranchStateError("invalid_command");
    const suppliedHash = input.payloadHash;
    const command = await this.create(input);
    if (command.record.payloadHash !== suppliedHash)
      throw new BranchStateError("invalid_command");
    return command;
  }

  /** Returns an independent transport record, including copies of nested metadata and operations. */
  toRecord(): BranchAppendRecord {
    return structuredClone(this.record);
  }
}

/** Compares every predecessor identity field; snapshot number alone is never sufficient. */
export const sameBranchStateVersion = (
  a: BranchStateVersion,
  b: BranchStateVersion,
): boolean =>
  a.snapshotId === b.snapshotId &&
  a.eventSeq === b.eventSeq &&
  a.sourceContentHash === b.sourceContentHash;
