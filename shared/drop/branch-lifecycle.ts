import { z } from "zod";
import type { DropBranchRecord, DropSnapshotRecord } from "./branch";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchBatchStatePlane,
  type BranchContentQuery,
  type BranchHeadQuery,
  type BranchStateHead,
  type BranchStateTarget,
} from "./branch-state";
import { hashNulldownSourceContent } from "./resolved/hash";
import type { NulldownSourceHash } from "./resolved/types";
import { serializeCanonicalJson } from "./types";

/** Internal placement discovery for one exact target; never reserves or creates state. */
export interface BranchPlacementQuery {
  target: BranchStateTarget;
}

/** Authorized initial ownership, captured before root materialization. */
export interface BranchInitializationIdentity {
  baseDropId: string;
  mode: DropBranchRecord["mode"];
  ownerAccountId: string | null;
  writerAccountId: string | null;
  writerClientId: string | null;
}

/** Durable winning reservation; source revision, ownership and creation time never change. */
export interface BranchInitializationReservation {
  reservationId: string;
  identity: BranchInitializationIdentity;
  rootRevision: string;
  createdAt: number;
}

/** Shard-local ownership, durable before snapshot zero and atomically activated with it. */
export interface BranchAuthorityRecord extends BranchHeadQuery {
  backend: "state-plane";
  state: "pending" | "active";
  reservation: BranchInitializationReservation;
}

/** Upstream-authorized reservation, submitted after root HEAD and before decryption. */
export interface BranchReserveRecord extends BranchHeadQuery {
  reservationId: string;
  identity: BranchInitializationIdentity;
  rootRevision: string;
}

/** Per-call disposition; competing requests receive the original winning reservation. */
export interface BranchReserveOutcome {
  status: "reserved" | "existing";
  authority: BranchAuthorityRecord;
}

/** Exact captured initialization intent; it cannot replace reserved ownership or source revision. */
export interface BranchInitializeRecord extends BranchHeadQuery {
  reservationId: string;
  rootRevision: string;
  content: string;
}

/** Immutable snapshot-zero acknowledgement, independent of the branch's later head. */
export interface BranchInitializationReceipt extends BranchHeadQuery {
  reservationId: string;
  rootRevision: string;
  payloadHash: NulldownSourceHash;
  initialHead: BranchStateHead;
}

/** Retries return the original receipt; use readHead separately for the current head. */
export interface BranchInitializeOutcome {
  status: "created" | "duplicate";
  receipt: BranchInitializationReceipt;
}

/** Exact numeric snapshot lookup, including zero, that discovers its complete version identity. */
export interface BranchSnapshotQuery extends BranchHeadQuery {
  snapshotId: number;
}

/** Persisted metadata paired with the exact version required by readContent. */
export interface BranchSnapshotState extends BranchContentQuery {
  snapshot: DropSnapshotRecord;
}

/** Internal ascending keyset page, pinned to version as its inclusive upper bound. */
export interface BranchSnapshotPageQuery extends BranchContentQuery {
  afterSnapshotId: number;
  limit: number;
}

/** Bounded internal page; application adapters drain pages for the existing public all-history response. */
export interface BranchSnapshotPage {
  snapshots: BranchSnapshotState[];
  nextAfterSnapshotId: number | null;
}

/** Local branch lifecycle and history authority; callers establish authorization and exclude legacy evidence. */
export interface BranchLifecycleStatePlane
  extends BranchBatchStatePlane, BranchSnapshotStatePlane {
  readPlacement(
    query: BranchPlacementQuery,
  ): Promise<BranchAuthorityRecord | null>;
  reserve(command: BranchReserveRecord): Promise<BranchReserveOutcome>;
  initialize(command: BranchInitializeRecord): Promise<BranchInitializeOutcome>;
}

/** Exact snapshot discovery and bounded history, shared by request-scoped application adapters. */
export interface BranchSnapshotStatePlane {
  readSnapshot(
    query: BranchHeadQuery & { snapshotId: number },
  ): Promise<BranchSnapshotState | null>;
  listSnapshots(
    query: BranchContentQuery & { afterSnapshotId: number; limit: number },
  ): Promise<BranchSnapshotPage>;
}

const token = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s.trim() === s);
const identitySchema = z
  .object({
    baseDropId: token,
    mode: z.enum(["owner", "clone"]),
    ownerAccountId: token.nullable(),
    writerAccountId: token.nullable(),
    writerClientId: token.nullable(),
  })
  .strict();
const integer = z.number().int().safe();
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new BranchStateError("invalid_command");
  return result.data;
};

/** Synchronous defensive capture for lifecycle and history RPC inputs. */
export class BranchLifecycleQuery {
  /** Validates a persisted/RPC authority record before it can influence routing or initialization. */
  static authority(input: unknown): BranchAuthorityRecord {
    const value = parse(
      z
        .object({
          target: z.unknown(),
          placement: z.unknown(),
          backend: z.literal("state-plane"),
          state: z.enum(["pending", "active"]),
          reservation: z
            .object({
              reservationId: token,
              identity: identitySchema,
              rootRevision: token,
              createdAt: integer.nonnegative(),
            })
            .strict(),
        })
        .strict(),
      input,
    );
    const query = BranchStateQuery.head({
      target: value.target,
      placement: value.placement,
    });
    if (query.placement.routingVersion !== 1)
      throw new BranchStateError("invalid_command");
    return {
      ...query,
      backend: value.backend,
      state: value.state,
      reservation: value.reservation,
    };
  }
  /** Captures a target without requiring knowledge of its durable generation. */
  static placement(input: BranchPlacementQuery): BranchPlacementQuery {
    return {
      target: BranchStateQuery.head({
        target: input?.target,
        placement: { routingVersion: 1, generation: 0 },
      }).target,
    };
  }
  /** Captures a reservation before routing or root access can yield. */
  static reserve(input: BranchReserveRecord): BranchReserveRecord {
    const query = BranchStateQuery.head({
      target: input?.target,
      placement: input?.placement,
    });
    return {
      ...query,
      ...parse(
        z
          .object({
            reservationId: token,
            identity: identitySchema,
            rootRevision: token,
          })
          .strict(),
        {
          reservationId: input?.reservationId,
          identity: input?.identity,
          rootRevision: input?.rootRevision,
        },
      ),
    };
  }
  /** Captures exact root bytes and the reservation they initialize. */
  static initialize(input: BranchInitializeRecord): BranchInitializeRecord {
    const query = BranchStateQuery.head({
      target: input?.target,
      placement: input?.placement,
    });
    return {
      ...query,
      ...parse(
        z
          .object({
            reservationId: token,
            rootRevision: token,
            content: z.string(),
          })
          .strict(),
        {
          reservationId: input?.reservationId,
          rootRevision: input?.rootRevision,
          content: input?.content,
        },
      ),
    };
  }
  /** Captures exact metadata discovery, rejecting unsafe or negative IDs. */
  static snapshot(input: BranchSnapshotQuery): BranchSnapshotQuery {
    return {
      ...BranchStateQuery.head({
        target: input?.target,
        placement: input?.placement,
      }),
      snapshotId: parse(integer.nonnegative(), input?.snapshotId),
    };
  }
  /** Captures a bounded page with an exact historical upper bound. */
  static page(input: BranchSnapshotPageQuery): BranchSnapshotPageQuery {
    const query = BranchStateQuery.content({
      target: input?.target,
      placement: input?.placement,
      version: input?.version,
    });
    const afterSnapshotId = parse(integer.min(-1), input?.afterSnapshotId);
    const limit = parse(integer.min(1).max(200), input?.limit);
    if (afterSnapshotId > query.version.snapshotId)
      throw new BranchStateError("invalid_command");
    return { ...query, afterSnapshotId, limit };
  }
}

/** Compares durable principals; an account's incidental client ID does not change its branch assignment. */
export function sameBranchInitializationIdentity(
  a: BranchInitializationIdentity,
  b: BranchInitializationIdentity,
): boolean {
  return (
    a.baseDropId === b.baseDropId &&
    a.mode === b.mode &&
    a.ownerAccountId === b.ownerAccountId &&
    a.writerAccountId === b.writerAccountId &&
    (a.writerAccountId !== null || a.writerClientId === b.writerClientId)
  );
}

/** Builds the immutable initial metadata without introducing a synthetic event. */
export function initialBranchSnapshot(
  head: BranchStateHead,
  content: string,
): DropSnapshotRecord {
  return {
    version: 1,
    ...head.target,
    snapshotId: 0,
    parentSnapshotId: null,
    seq: 0,
    eventIds: [],
    checkpointed: true,
    patchStartSeq: null,
    patchEndSeq: null,
    textLength: content.length,
    sourceContentHash: head.version.sourceContentHash,
    createdAt: head.branch.createdAt,
  };
}

/** Prepared immutable snapshot-zero publication; storage rechecks the reservation before committing. */
export interface PreparedBranchInitialization {
  head: BranchStateHead;
  snapshot: DropSnapshotRecord;
  receipt: BranchInitializationReceipt;
  intent: string;
}

/** Prepares outside SQL transactions; canonical JSON preserves lone-surrogate distinctions in intent. */
export async function prepareBranchInitialization(
  authority: BranchAuthorityRecord,
  input: BranchInitializeRecord,
): Promise<PreparedBranchInitialization> {
  authority = BranchLifecycleQuery.authority(authority);
  const command = BranchLifecycleQuery.initialize(input);
  if (
    serializeCanonicalJson(authority.target) !==
    serializeCanonicalJson(command.target)
  )
    throw new BranchStateError("branch_initialization_conflict");
  if (authority.placement.routingVersion !== command.placement.routingVersion)
    throw new BranchStateError("routing_version_unsupported");
  if (authority.placement.generation !== command.placement.generation)
    throw new BranchStateError("routing_generation_mismatch");
  const reservation = authority.reservation;
  if (
    reservation.reservationId !== command.reservationId ||
    reservation.rootRevision !== command.rootRevision
  )
    throw new BranchStateError("branch_initialization_conflict");
  const intent = serializeCanonicalJson(command);
  const [sourceContentHash, payloadHash] = await Promise.all([
    hashNulldownSourceContent(command.content),
    hashNulldownSourceContent(`nulldown.branch-initialization.v1\n${intent}`),
  ]);
  const query = { target: command.target, placement: command.placement };
  const head: BranchStateHead = {
    ...query,
    version: { snapshotId: 0, eventSeq: -1, sourceContentHash },
    branch: {
      version: 1,
      ...command.target,
      ...reservation.identity,
      status: "active",
      headSnapshotId: 0,
      headEventSeq: -1,
      snapshotHeapVersion: 2,
      checkpointInterval: 24,
      createdAt: reservation.createdAt,
      updatedAt: reservation.createdAt,
    },
  };
  return {
    head,
    snapshot: initialBranchSnapshot(head, command.content),
    intent,
    receipt: {
      ...query,
      reservationId: command.reservationId,
      rootRevision: command.rootRevision,
      payloadHash,
      initialHead: head,
    },
  };
}
