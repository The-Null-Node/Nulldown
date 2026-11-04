import {
  isDropBranchRecord,
  isDropSnapshotRecord,
  type DropSnapshotRecord,
} from "../../../shared/drop/branch";
import {
  authorizeNullMem,
  captureNullMemQuery,
  captureNullMemPut,
  captureNullMemDelete,
  nullMemRecordIdentity,
  prepareNullMemPut,
  prepareNullMemDelete,
  queryNullMemRecords,
  validateNullMemState,
  type BranchNullMemStatePlane,
  type BranchNullMemQuery,
  type BranchNullMemQueryResult,
  type BranchNullMemPutCommand,
  type BranchNullMemPutResult,
  type BranchNullMemDeleteCommand,
  type BranchNullMemDeleteResult,
  type BranchNullMemRecord,
  type BranchNullMemOutbox,
} from "../../../shared/drop/branch-nullmem";
import { isDropDiffEvent, type DropDiffEvent } from "../../../shared/drop/diff";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import { prepareBranchCommit } from "../../../shared/drop/branch-commit";
import {
  captureBranchBatchAppend,
  hashBranchBatchEvents,
  prepareBranchBatch,
} from "../../../shared/drop/branch-batch";
import {
  BranchAppendCommand,
  BranchStateError,
  BranchStateQuery,
  sameBranchStateVersion,
  type BranchAppendRecord,
  type BranchAppendOutcome,
  type BranchBatchAppendRecord,
  type BranchBatchAppendResult,
  type BranchCommitReceipt,
  type BranchContentQuery,
  type BranchEventRangeQuery,
  type BranchHeadQuery,
  type BranchStateHead,
  type BranchStateContent,
} from "../../../shared/drop/branch-state";
import {
  BranchLifecycleQuery,
  prepareBranchInitialization,
  sameBranchInitializationIdentity,
  type BranchLifecycleStatePlane,
  type BranchAuthorityRecord,
  type BranchPlacementQuery,
  type BranchReserveRecord,
  type BranchReserveOutcome,
  type BranchInitializeRecord,
  type BranchInitializeOutcome,
  type BranchSnapshotQuery,
  type BranchSnapshotState,
  type BranchSnapshotPageQuery,
  type BranchSnapshotPage,
} from "../../../shared/drop/branch-lifecycle";
import { serializeCanonicalJson } from "../../../shared/drop/types";
import type { MemoryBranchStateSeed } from "./memory-commits";
import type { BranchSqlPort } from "./sqlite-port";
import type {
  BranchCanonicalOutbox,
  BranchClaimedOutbox,
  BranchOutboxClaimCommand,
  BranchOutboxClaimResultCommand,
  BranchOutboxDeliveryStatePlane,
  BranchOutboxDeliveryItem,
} from "../../../shared/drop/branch-outbox-delivery";
import {
  validateOutboxClaim,
  validateOutboxClaimResult,
  outboxRetryAt,
  canonicalOutboxPlacement,
  outboxLeaseToken,
} from "./outbox-delivery";
import {
  decodeBranchSqlText,
  encodeBranchSqlText,
  initializeBranchSqlSchema,
} from "./sqlite-schema";
import { ExactContentCache } from "./exact-content-cache";
import { nullplugUiRuntimeFactId } from "../../../shared/nullplug/ui";
import {
  authorizeRuntimeFact,
  canonicalRuntimeFactJson,
  captureRuntimeFactAppend,
  captureRuntimeFactPage,
  hashRuntimeFactIntent,
  prepareRuntimeFactReceipt,
  runtimeFactIdentity,
  runtimeFactIntent,
  runtimeFactKey,
  runtimeFactOutbox,
  validateRuntimeFactReceipt,
  type BranchRuntimeFactAppendCommand,
  type BranchRuntimeFactAppendResult,
  type BranchRuntimeFactHead,
  type BranchRuntimeFactPage,
  type BranchRuntimeFactPageQuery,
  type BranchRuntimeFactReceipt,
  type BranchRuntimeFactStatePlane,
} from "../../../shared/drop/branch-runtime-facts";

type Row = Record<string, unknown>;
const scope = (query: BranchHeadQuery): [string, string] => [
  encodeBranchSqlText(query.target.rootDropId),
  encodeBranchSqlText(query.target.branchId),
];
const corrupt = (): never => {
  throw new BranchStateError("state_corrupt");
};
const json = (value: unknown): unknown => {
  if (typeof value !== "string") return corrupt();
  try {
    return JSON.parse(value);
  } catch {
    return corrupt();
  }
};
const record = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return corrupt();
  return value as Row;
};
const storedQuery = (value: Row): BranchContentQuery => {
  try {
    return BranchStateQuery.content({
      target: value.target,
      placement: value.placement,
      version: value.version,
    });
  } catch {
    return corrupt();
  }
};
const sameScope = (a: BranchHeadQuery, b: BranchHeadQuery): boolean =>
  a.target.rootDropId === b.target.rootDropId &&
  a.target.branchId === b.target.branchId;
const samePlacement = (a: BranchHeadQuery, b: BranchHeadQuery): boolean =>
  a.placement.routingVersion === b.placement.routingVersion &&
  a.placement.generation === b.placement.generation;

/** Per-connection runtime dependencies. Cache state is always disposable and never establishes authority. */
export interface SqliteBranchCommitOptions {
  now?: () => number;
  cache?: ExactContentCache;
}

/** SQL-authoritative branch commits shared by local SQLite and SQLite-backed Durable Objects. */
export class SqliteBranchCommitStatePlane
  implements
    BranchLifecycleStatePlane,
    BranchRuntimeFactStatePlane,
    BranchNullMemStatePlane,
    BranchOutboxDeliveryStatePlane
{
  private readonly now: () => number;
  private readonly cache: ExactContentCache;

  constructor(
    private readonly sql: BranchSqlPort,
    options: SqliteBranchCommitOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.cache = options.cache ?? new ExactContentCache();
    try {
      initializeBranchSqlSchema(sql);
    } catch {
      throw new BranchStateError("state_unavailable");
    }
  }

  /** Opens the schema and explicitly seeds initial local fixtures; reads and append never initialize branches. */
  static async create(
    sql: BranchSqlPort,
    seeds: readonly MemoryBranchStateSeed[] = [],
    options: SqliteBranchCommitOptions = {},
  ): Promise<SqliteBranchCommitStatePlane> {
    const plane = new SqliteBranchCommitStatePlane(sql, options);
    await plane.seed(seeds);
    return plane;
  }

  /** Explicit local-fixture initialization only. Duplicate targets fail atomically without replacing history. */
  async seed(inputs: readonly MemoryBranchStateSeed[]): Promise<void> {
    return this.available(async () => {
      if (!Array.isArray(inputs)) throw new BranchStateError("invalid_command");
      const seeds = structuredClone(inputs);
      const prepared = await Promise.all(
        seeds.map(async (seed) => {
          if (
            !seed ||
            !isDropBranchRecord(seed.branch) ||
            seed.branch.headSnapshotId !== 0 ||
            seed.branch.headEventSeq !== -1 ||
            typeof seed.content !== "string"
          ) {
            throw new BranchStateError("invalid_command");
          }
          const query = BranchStateQuery.head({
            target: {
              rootDropId: seed.branch.rootDropId,
              branchId: seed.branch.branchId,
            },
            placement: seed.placement,
          });
          this.routing(query);
          const version = {
            snapshotId: 0,
            eventSeq: -1,
            sourceContentHash: await hashNulldownSourceContent(seed.content),
          };
          const head: BranchStateHead = {
            ...query,
            version,
            branch: seed.branch,
          };
          const snapshot: DropSnapshotRecord = {
            version: 1,
            ...query.target,
            snapshotId: 0,
            parentSnapshotId: null,
            seq: 0,
            eventIds: [],
            checkpointed: true,
            patchStartSeq: null,
            patchEndSeq: null,
            textLength: seed.content.length,
            sourceContentHash: version.sourceContentHash,
            createdAt: seed.branch.createdAt,
          };
          return { head, snapshot, content: seed.content };
        }),
      );
      if (prepared.length === 0) return;
      this.sql.transaction(() => {
        for (const { head, snapshot, content } of prepared) {
          if (
            this.sql.rows(
              "SELECT 1 FROM branch_heads WHERE root_drop_id = ? AND branch_id = ?",
              ...scope(head),
            ).length
          ) {
            throw new BranchStateError("invalid_command");
          }
          this.sql.execute(
            "INSERT INTO branch_fixture_seeds (root_drop_id, branch_id) VALUES (?, ?)",
            ...scope(head),
          );
          this.sql.execute(
            "INSERT INTO branch_heads (root_drop_id, branch_id, routing_version, generation, head_json) VALUES (?, ?, ?, ?, ?)",
            ...scope(head),
            head.placement.routingVersion,
            head.placement.generation,
            JSON.stringify(head),
          );
          this.sql.execute(
            "INSERT INTO branch_snapshots (root_drop_id, branch_id, snapshot_id, event_seq, source_content_hash, content, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ...scope(head),
            0,
            -1,
            head.version.sourceContentHash,
            encodeBranchSqlText(content),
            JSON.stringify(snapshot),
          );
        }
      });
    });
  }

  private async available<T>(body: () => Promise<T> | T): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (error instanceof BranchStateError) throw error;
      throw new BranchStateError("state_unavailable");
    }
  }

  private routing(query: BranchHeadQuery): void {
    if (query.placement.routingVersion !== 1)
      throw new BranchStateError("routing_version_unsupported");
  }

  /** Registers newly committed canonical work in the same SQL transaction as its witness. */
  private registerOutbox(
    outbox: BranchCanonicalOutbox,
    target: BranchHeadQuery["target"],
    placement: BranchHeadQuery["placement"],
  ): void {
    const captured = canonicalOutboxPlacement(outbox);
    if (
      captured.target.rootDropId !== target.rootDropId ||
      captured.target.branchId !== target.branchId ||
      captured.placement.generation !== placement.generation
    )
      return corrupt();
    const existing = this.sql.rows(
      `SELECT kind,root_drop_id,branch_id,generation FROM branch_outbox_delivery WHERE outbox_id=?`,
      outbox.id,
    )[0];
    if (existing) {
      if (
        existing.kind !== outbox.kind ||
        existing.root_drop_id !== encodeBranchSqlText(target.rootDropId) ||
        existing.branch_id !== encodeBranchSqlText(target.branchId) ||
        existing.generation !== placement.generation
      )
        return corrupt();
      return;
    }
    this.sql.execute(
      `INSERT INTO branch_outbox_delivery (outbox_id,kind,root_drop_id,branch_id,generation,status,attempts,next_attempt_at) VALUES (?,?,?,?,?,'pending',0,0)`,
      outbox.id,
      outbox.kind,
      encodeBranchSqlText(target.rootDropId),
      encodeBranchSqlText(target.branchId),
      placement.generation,
    );
  }

  private authority(
    query: BranchPlacementQuery,
    includeInitialization = false,
  ): { authority: BranchAuthorityRecord; row: Row } | null {
    const row = this.sql.rows(
      `SELECT authority_json, initialization_intent IS NOT NULL AS has_initialization_intent, initialization_receipt_json IS NOT NULL AS has_initialization_receipt${includeInitialization ? ", initialization_intent, initialization_receipt_json" : ""} FROM branch_authorities WHERE root_drop_id = ? AND branch_id = ?`,
      encodeBranchSqlText(query.target.rootDropId),
      encodeBranchSqlText(query.target.branchId),
    )[0];
    if (!row) return null;
    let authority: BranchAuthorityRecord;
    try {
      authority = BranchLifecycleQuery.authority(json(row.authority_json));
    } catch {
      return corrupt();
    }
    if (!sameScope(authority, { ...authority, target: query.target }))
      return corrupt();
    if (
      authority.state === "pending"
        ? row.has_initialization_intent !== 0 ||
          row.has_initialization_receipt !== 0
        : row.has_initialization_intent !== 1 ||
          row.has_initialization_receipt !== 1
    )
      return corrupt();
    if (
      includeInitialization &&
      authority.state === "active" &&
      (typeof row.initialization_intent !== "string" ||
        typeof row.initialization_receipt_json !== "string")
    )
      return corrupt();
    return { authority, row };
  }

  private fencedAuthority(
    query: BranchHeadQuery,
    includeInitialization = false,
  ) {
    this.routing(query);
    const stored = this.authority(query, includeInitialization);
    if (!stored) throw new BranchStateError("branch_not_found");
    if (stored.authority.placement.generation !== query.placement.generation)
      throw new BranchStateError("routing_generation_mismatch");
    return stored;
  }

  /** Discovers durable pending/active ownership; no branch is created on discovery. */
  async readPlacement(
    input: BranchPlacementQuery,
  ): Promise<BranchAuthorityRecord | null> {
    return this.available(() => {
      const query = BranchLifecycleQuery.placement(input);
      return this.sql.transaction(() => {
        const stored = this.authority(query);
        const hasHead =
          this.sql.rows(
            "SELECT 1 FROM branch_heads WHERE root_drop_id = ? AND branch_id = ?",
            encodeBranchSqlText(query.target.rootDropId),
            encodeBranchSqlText(query.target.branchId),
          ).length > 0;
        if (!stored) {
          if (hasHead) return corrupt();
          return null;
        }
        if ((stored.authority.state === "active") !== hasHead) return corrupt();
        if (hasHead) this.snapshot(this.head(stored.authority), false);
        return stored.authority;
      });
    });
  }

  /** Atomically reserves ownership before materialization; a competing resolver receives the original winner. */
  async reserve(input: BranchReserveRecord): Promise<BranchReserveOutcome> {
    return this.available(() => {
      const command = BranchLifecycleQuery.reserve(input);
      this.routing(command);
      return this.sql.transaction(() => {
        const stored = this.authority(command);
        if (stored) {
          if (
            stored.authority.placement.generation !==
            command.placement.generation
          )
            throw new BranchStateError("routing_generation_mismatch");
          if (
            !sameBranchInitializationIdentity(
              stored.authority.reservation.identity,
              command.identity,
            )
          )
            throw new BranchStateError("branch_initialization_conflict");
          if (stored.authority.state === "active") this.head(command);
          return { status: "existing", authority: stored.authority };
        }
        if (
          this.sql.rows(
            "SELECT 1 FROM branch_heads WHERE root_drop_id = ? AND branch_id = ?",
            ...scope(command),
          ).length
        )
          throw new BranchStateError("branch_initialization_conflict");
        const createdAt = this.now();
        if (!Number.isSafeInteger(createdAt) || createdAt < 0)
          throw new BranchStateError("invalid_command");
        const authority: BranchAuthorityRecord = {
          target: command.target,
          placement: command.placement,
          backend: "state-plane",
          state: "pending",
          reservation: {
            reservationId: command.reservationId,
            identity: command.identity,
            rootRevision: command.rootRevision,
            createdAt,
          },
        };
        this.sql.execute(
          "INSERT INTO branch_authorities (root_drop_id, branch_id, authority_json) VALUES (?, ?, ?)",
          ...scope(command),
          JSON.stringify(authority),
        );
        return { status: "reserved", authority };
      });
    });
  }

  /** Activates ownership, snapshot zero, head and immutable receipt in one synchronous transaction. */
  async initialize(
    input: BranchInitializeRecord,
  ): Promise<BranchInitializeOutcome> {
    return this.available(async () => {
      const command = BranchLifecycleQuery.initialize(input);
      const initial = this.sql.transaction(
        () => this.fencedAuthority(command).authority,
      );
      const prepared = await prepareBranchInitialization(initial, command);
      return this.sql.transaction(() => {
        const { authority, row } = this.fencedAuthority(command, true);
        if (
          serializeCanonicalJson(authority.reservation) !==
          serializeCanonicalJson(initial.reservation)
        )
          return corrupt();
        if (authority.state === "active") {
          this.head(command);
          if (row.initialization_intent !== prepared.intent)
            throw new BranchStateError("branch_initialization_conflict");
          if (
            serializeCanonicalJson(json(row.initialization_receipt_json)) !==
            serializeCanonicalJson(prepared.receipt)
          )
            return corrupt();
          if (this.snapshot(prepared.head, true).content !== command.content)
            return corrupt();
          return { status: "duplicate", receipt: prepared.receipt };
        }
        if (
          this.sql.rows(
            "SELECT 1 FROM branch_heads WHERE root_drop_id = ? AND branch_id = ?",
            ...scope(command),
          ).length ||
          this.sql.rows(
            "SELECT 1 FROM branch_snapshots WHERE root_drop_id = ? AND branch_id = ? LIMIT 1",
            ...scope(command),
          ).length
        )
          return corrupt();
        this.sql.execute(
          "INSERT INTO branch_heads (root_drop_id, branch_id, routing_version, generation, head_json) VALUES (?, ?, ?, ?, ?)",
          ...scope(command),
          command.placement.routingVersion,
          command.placement.generation,
          JSON.stringify(prepared.head),
        );
        this.sql.execute(
          "INSERT INTO branch_snapshots (root_drop_id, branch_id, snapshot_id, event_seq, source_content_hash, content, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ...scope(command),
          0,
          -1,
          prepared.head.version.sourceContentHash,
          encodeBranchSqlText(command.content),
          JSON.stringify(prepared.snapshot),
        );
        this.sql.execute(
          "UPDATE branch_authorities SET authority_json = ?, initialization_intent = ?, initialization_receipt_json = ? WHERE root_drop_id = ? AND branch_id = ?",
          JSON.stringify({ ...authority, state: "active" }),
          prepared.intent,
          JSON.stringify(prepared.receipt),
          ...scope(command),
        );
        return { status: "created", receipt: prepared.receipt };
      });
    });
  }

  private authorityHead(
    head: BranchStateHead,
    authority: BranchAuthorityRecord,
  ): void {
    const { branch, version } = head;
    const { identity, createdAt } = authority.reservation;
    // Reservation convergence ignores an account's incidental client; persisted identity must not.
    if (
      !isDropBranchRecord(branch) ||
      !sameScope(head, authority) ||
      !samePlacement(head, authority) ||
      branch.rootDropId !== authority.target.rootDropId ||
      branch.branchId !== authority.target.branchId ||
      branch.baseDropId !== identity.baseDropId ||
      branch.mode !== identity.mode ||
      branch.ownerAccountId !== identity.ownerAccountId ||
      branch.writerAccountId !== identity.writerAccountId ||
      branch.writerClientId !== identity.writerClientId ||
      branch.createdAt !== createdAt ||
      branch.status !== "active" ||
      branch.snapshotHeapVersion !== 2 ||
      branch.checkpointInterval !== 24 ||
      !Number.isSafeInteger(branch.updatedAt) ||
      branch.updatedAt < 0 ||
      branch.headSnapshotId !== version.snapshotId ||
      branch.headEventSeq !== version.eventSeq ||
      (version.snapshotId === 0
        ? version.eventSeq !== -1 || branch.updatedAt !== createdAt
        : version.eventSeq < version.snapshotId - 1)
    )
      return corrupt();
  }

  private head(query: BranchHeadQuery): BranchStateHead {
    this.routing(query);
    const row = this.sql.rows(
      "SELECT h.routing_version, h.generation, h.head_json, a.authority_json, a.initialization_receipt_json, a.initialization_intent IS NOT NULL AS has_initialization_intent, f.root_drop_id AS fixture_seed FROM branch_heads h LEFT JOIN branch_authorities a ON a.root_drop_id = h.root_drop_id AND a.branch_id = h.branch_id LEFT JOIN branch_fixture_seeds f ON f.root_drop_id = h.root_drop_id AND f.branch_id = h.branch_id WHERE h.root_drop_id = ? AND h.branch_id = ?",
      ...scope(query),
    )[0];
    if (!row) {
      const stored = this.authority(query);
      if (
        stored &&
        stored.authority.placement.generation !== query.placement.generation
      )
        throw new BranchStateError("routing_generation_mismatch");
      throw new BranchStateError(
        stored?.authority.state === "pending"
          ? "branch_initialization_pending"
          : stored
            ? "state_corrupt"
            : "branch_not_found",
      );
    }
    // Stored placement is checked before receipt lookup and every cache lookup.
    if (
      row.routing_version !== 1 ||
      !Number.isSafeInteger(row.generation) ||
      (row.generation as number) < 0
    )
      return corrupt();
    // Only the explicit seed path can persist a head without lifecycle authority.
    let authority: BranchAuthorityRecord | undefined;
    if (row.authority_json !== null) {
      try {
        authority = BranchLifecycleQuery.authority(json(row.authority_json));
      } catch {
        return corrupt();
      }
      if (!sameScope(authority, query) || authority.state !== "active")
        return corrupt();
      if (authority.placement.generation !== query.placement.generation)
        throw new BranchStateError("routing_generation_mismatch");
      if (authority.placement.generation !== row.generation) return corrupt();
      if (row.fixture_seed !== null || row.has_initialization_intent !== 1)
        return corrupt();
    } else if (row.fixture_seed === null) return corrupt();
    if (row.generation !== query.placement.generation)
      throw new BranchStateError("routing_generation_mismatch");
    const value = record(json(row.head_json));
    const identity = storedQuery(value);
    if (
      !sameScope(identity, query) ||
      !samePlacement(identity, query) ||
      !isDropBranchRecord(value.branch)
    )
      return corrupt();
    const branch = value.branch;
    if (
      branch.rootDropId !== query.target.rootDropId ||
      branch.branchId !== query.target.branchId ||
      branch.headSnapshotId !== identity.version.snapshotId ||
      branch.headEventSeq !== identity.version.eventSeq
    )
      return corrupt();
    const head = { ...identity, branch };
    if (authority) {
      this.authorityHead(head, authority);
      const receipt = record(json(row.initialization_receipt_json));
      const receiptIdentity = storedQuery({
        ...receipt,
        version: head.version,
      });
      const initialValue = record(receipt.initialHead);
      const initialIdentity = storedQuery(initialValue);
      if (!isDropBranchRecord(initialValue.branch)) return corrupt();
      const initialHead = { ...initialIdentity, branch: initialValue.branch };
      this.authorityHead(initialHead, authority);
      if (
        !sameScope(receiptIdentity, authority) ||
        !samePlacement(receiptIdentity, authority) ||
        receipt.reservationId !== authority.reservation.reservationId ||
        receipt.rootRevision !== authority.reservation.rootRevision ||
        typeof receipt.payloadHash !== "string" ||
        !/^sha256:[A-Za-z0-9_-]{43}$/.test(receipt.payloadHash) ||
        initialHead.version.snapshotId !== 0 ||
        initialHead.version.eventSeq !== -1 ||
        (head.version.snapshotId === 0 &&
          !sameBranchStateVersion(head.version, initialHead.version))
      )
        return corrupt();
    }
    return head;
  }

  private snapshot(
    query: BranchContentQuery,
    includeContent: boolean,
  ): {
    identity: BranchContentQuery;
    snapshot: DropSnapshotRecord;
    content?: string;
  } {
    const row = this.sql.rows(
      `SELECT s.snapshot_id, s.event_seq, s.source_content_hash, s.snapshot_json, p.event_seq AS parent_event_seq${includeContent ? ", s.content" : ""} FROM branch_snapshots s LEFT JOIN branch_snapshots p ON p.root_drop_id = s.root_drop_id AND p.branch_id = s.branch_id AND p.snapshot_id = s.snapshot_id - 1 WHERE s.root_drop_id = ? AND s.branch_id = ? AND s.snapshot_id = ?`,
      ...scope(query),
      query.version.snapshotId,
    )[0];
    if (!row) throw new BranchStateError("snapshot_not_found");
    return this.snapshotRecord(query, row, includeContent);
  }

  private snapshotRecord(
    query: BranchContentQuery,
    row: Row,
    includeContent: boolean,
  ): {
    identity: BranchContentQuery;
    snapshot: DropSnapshotRecord;
    content?: string;
  } {
    const identity = storedQuery({
      target: query.target,
      placement: query.placement,
      version: {
        snapshotId: row.snapshot_id,
        eventSeq: row.event_seq,
        sourceContentHash: row.source_content_hash,
      },
    });
    const snapshot = json(row.snapshot_json);
    if (
      !isDropSnapshotRecord(snapshot) ||
      snapshot.rootDropId !== query.target.rootDropId ||
      snapshot.branchId !== query.target.branchId ||
      snapshot.snapshotId !== identity.version.snapshotId ||
      snapshot.seq !== snapshot.snapshotId ||
      snapshot.sourceContentHash !== identity.version.sourceContentHash ||
      !Number.isSafeInteger(snapshot.textLength) ||
      snapshot.textLength < 0 ||
      !Number.isSafeInteger(snapshot.createdAt) ||
      snapshot.createdAt < 0 ||
      !snapshot.checkpointed
    )
      return corrupt();
    if (snapshot.snapshotId === 0) {
      if (
        snapshot.parentSnapshotId !== null ||
        snapshot.eventIds.length !== 0 ||
        identity.version.eventSeq !== -1 ||
        snapshot.patchStartSeq !== null ||
        snapshot.patchEndSeq !== null
      )
        return corrupt();
    } else {
      if (
        snapshot.parentSnapshotId !== snapshot.snapshotId - 1 ||
        !Number.isSafeInteger(snapshot.patchStartSeq) ||
        snapshot.patchStartSeq! < 0 ||
        snapshot.patchEndSeq !== identity.version.eventSeq ||
        snapshot.patchEndSeq! < snapshot.patchStartSeq! ||
        snapshot.eventIds.length !==
          snapshot.patchEndSeq! - snapshot.patchStartSeq! + 1 ||
        new Set(snapshot.eventIds).size !== snapshot.eventIds.length
      )
        return corrupt();
      if (row.parent_event_seq !== snapshot.patchStartSeq! - 1)
        return corrupt();
    }
    if (!sameBranchStateVersion(identity.version, query.version))
      throw new BranchStateError("snapshot_version_mismatch");
    const content = includeContent
      ? decodeBranchSqlText(row.content)
      : undefined;
    if (includeContent && content!.length !== snapshot.textLength)
      return corrupt();
    return {
      identity,
      snapshot,
      ...(includeContent ? { content } : {}),
    };
  }

  private currentSnapshot(head: BranchStateHead): string {
    try {
      return this.snapshot(head, true).content!;
    } catch (error) {
      if (
        error instanceof BranchStateError &&
        (error.code === "snapshot_not_found" ||
          error.code === "snapshot_version_mismatch")
      )
        return corrupt();
      throw error;
    }
  }

  private duplicate(
    command: BranchHeadQuery &
      Pick<BranchAppendRecord, "event" | "payloadHash">,
  ): BranchAppendOutcome | undefined {
    const row = this.sql.rows(
      "SELECT event_id, payload_hash, receipt_json FROM branch_receipts WHERE root_drop_id = ? AND branch_id = ? AND event_id = ?",
      ...scope(command),
      encodeBranchSqlText(command.event.eventId),
    )[0];
    if (!row) return;
    const value = record(json(row.receipt_json));
    const identity = storedQuery(value);
    if (
      !sameScope(identity, command) ||
      !samePlacement(identity, command) ||
      identity.version.snapshotId < 1 ||
      !Number.isSafeInteger(value.eventSeq ?? identity.version.eventSeq) ||
      Number(value.eventSeq ?? identity.version.eventSeq) < 0 ||
      Number(value.eventSeq ?? identity.version.eventSeq) >
        identity.version.eventSeq ||
      value.eventId !== command.event.eventId ||
      row.event_id !== encodeBranchSqlText(command.event.eventId) ||
      value.payloadHash !== row.payload_hash ||
      typeof value.payloadHash !== "string" ||
      !/^sha256:[A-Za-z0-9_-]{43}$/.test(value.payloadHash)
    )
      return corrupt();
    if (value.payloadHash !== command.payloadHash)
      throw new BranchStateError("diff_event_id_reused");
    const receipt: BranchCommitReceipt = {
      ...identity,
      eventId: value.eventId as string,
      payloadHash: command.payloadHash,
      ...(value.eventSeq !== undefined
        ? { eventSeq: value.eventSeq as number }
        : {}),
    };
    const head = this.head(command);
    if (
      identity.version.snapshotId > head.version.snapshotId ||
      identity.version.eventSeq > head.version.eventSeq
    )
      return corrupt();
    let snapshot: DropSnapshotRecord;
    try {
      snapshot = this.snapshot(identity, false).snapshot;
    } catch (error) {
      if (
        error instanceof BranchStateError &&
        (error.code === "snapshot_not_found" ||
          error.code === "snapshot_version_mismatch")
      )
        return corrupt();
      throw error;
    }
    const eventSeq = receipt.eventSeq ?? receipt.version.eventSeq;
    const eventRow = this.sql.rows(
      "SELECT event_json FROM branch_events WHERE root_drop_id = ? AND branch_id = ? AND event_seq = ?",
      ...scope(command),
      eventSeq,
    )[0];
    const event = eventRow ? json(eventRow.event_json) : null;
    if (
      !isDropDiffEvent(event) ||
      event.eventId !== receipt.eventId ||
      event.seq !== eventSeq ||
      event.snapshotId !== receipt.version.snapshotId ||
      event.dropId !== command.target.rootDropId ||
      snapshot.eventIds[eventSeq - snapshot.patchStartSeq!] !== receipt.eventId
    )
      return corrupt();
    return { status: "duplicate", receipt };
  }

  /** Hashes/prepares outside transactions; revalidates placement, immutable receipt and predecessor before five-row publication. */
  async append(input: BranchAppendRecord): Promise<BranchAppendOutcome> {
    return this.available(async () => {
      const command = (await BranchAppendCommand.fromRecord(input)).toRecord();
      const initial = this.sql.transaction(() => {
        const head = this.head(command);
        const duplicate = this.duplicate(command);
        if (duplicate) return { duplicate };
        if (!sameBranchStateVersion(head.version, command.expected))
          throw new BranchStateError("diff_predecessor_mismatch");
        return { head, content: this.currentSnapshot(head) };
      });
      if (initial.duplicate) return initial.duplicate;
      const prepared = await prepareBranchCommit(
        command,
        initial.head!,
        initial.content!,
        this.now(),
      );
      return this.sql.transaction(() => {
        const head = this.head(command);
        const duplicate = this.duplicate(command);
        if (duplicate) return duplicate;
        if (!sameBranchStateVersion(head.version, command.expected))
          throw new BranchStateError("diff_predecessor_mismatch");
        // Recheck the captured predecessor itself after async preparation, not merely its numeric snapshot ID.
        if (this.currentSnapshot(head) !== initial.content) return corrupt();
        const next: BranchStateHead = {
          target: command.target,
          placement: command.placement,
          branch: prepared.branch,
          version: prepared.receipt.version,
        };
        this.sql.execute(
          "INSERT INTO branch_events (root_drop_id, branch_id, event_seq, event_id, snapshot_id, event_json) VALUES (?, ?, ?, ?, ?, ?)",
          ...scope(command),
          prepared.event.seq,
          encodeBranchSqlText(prepared.event.eventId),
          prepared.snapshot.snapshotId,
          JSON.stringify(prepared.event),
        );
        this.sql.execute(
          "INSERT INTO branch_snapshots (root_drop_id, branch_id, snapshot_id, event_seq, source_content_hash, content, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ...scope(command),
          prepared.snapshot.snapshotId,
          prepared.event.seq,
          prepared.receipt.version.sourceContentHash,
          encodeBranchSqlText(prepared.content),
          JSON.stringify(prepared.snapshot),
        );
        this.sql.execute(
          "UPDATE branch_heads SET head_json = ? WHERE root_drop_id = ? AND branch_id = ?",
          JSON.stringify(next),
          ...scope(command),
        );
        this.sql.execute(
          "INSERT INTO branch_receipts (root_drop_id, branch_id, event_id, payload_hash, receipt_json) VALUES (?, ?, ?, ?, ?)",
          ...scope(command),
          encodeBranchSqlText(prepared.event.eventId),
          prepared.receipt.payloadHash,
          JSON.stringify(prepared.receipt),
        );
        this.sql.execute(
          "INSERT INTO branch_outbox (root_drop_id, branch_id, event_id, outbox_id, outbox_json) VALUES (?, ?, ?, ?, ?)",
          ...scope(command),
          encodeBranchSqlText(prepared.event.eventId),
          prepared.outbox.id,
          JSON.stringify(prepared.outbox),
        );
        this.registerOutbox(prepared.outbox, command.target, command.placement);
        return { status: "accepted", receipt: prepared.receipt };
      });
    });
  }

  /** Atomically publishes a whole envelope. Async preparation retries a changed head before any rows are written. */
  async appendBatch(
    input: BranchBatchAppendRecord,
  ): Promise<BranchBatchAppendResult> {
    return this.available(async () => {
      const command = captureBranchBatchAppend(input);
      const identities = await hashBranchBatchEvents(command.events);
      for (let attempt = 0; attempt < 32; attempt++) {
        const initial = this.sql.transaction(() => {
          const head = this.head(command);
          const receipts = new Map<string, BranchCommitReceipt>();
          for (const identity of identities) {
            const duplicate = this.duplicate({ ...command, ...identity });
            if (duplicate)
              receipts.set(identity.event.eventId, duplicate.receipt);
          }
          return { head, receipts, content: this.currentSnapshot(head) };
        });
        const prepared = await prepareBranchBatch(
          command,
          identities,
          initial.head,
          initial.content,
          initial.receipts,
          this.now(),
        );
        const committed = this.sql.transaction(() => {
          const head = this.head(command);
          if (!sameBranchStateVersion(head.version, initial.head.version))
            return false;
          if (this.currentSnapshot(head) !== initial.content) return corrupt();
          // Receipts are immutable, but validate them again after preparation yields.
          for (const identity of identities) {
            const duplicate = this.duplicate({ ...command, ...identity });
            if (
              JSON.stringify(duplicate?.receipt) !==
              JSON.stringify(initial.receipts.get(identity.event.eventId))
            )
              return corrupt();
          }
          if (!prepared.result.snapshot) return true;
          const { result, version, receipts, outbox } = prepared;
          for (const event of result.acceptedEvents)
            this.sql.execute(
              "INSERT INTO branch_events (root_drop_id, branch_id, event_seq, event_id, snapshot_id, event_json) VALUES (?, ?, ?, ?, ?, ?)",
              ...scope(command),
              event.seq,
              encodeBranchSqlText(event.eventId),
              version.snapshotId,
              JSON.stringify(event),
            );
          this.sql.execute(
            "INSERT INTO branch_snapshots (root_drop_id, branch_id, snapshot_id, event_seq, source_content_hash, content, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ...scope(command),
            version.snapshotId,
            version.eventSeq,
            version.sourceContentHash,
            encodeBranchSqlText(result.content),
            JSON.stringify(result.snapshot),
          );
          this.sql.execute(
            "UPDATE branch_heads SET head_json = ? WHERE root_drop_id = ? AND branch_id = ?",
            JSON.stringify({
              target: command.target,
              placement: command.placement,
              branch: result.branch,
              version,
            }),
            ...scope(command),
          );
          for (const receipt of receipts)
            this.sql.execute(
              "INSERT INTO branch_receipts (root_drop_id, branch_id, event_id, payload_hash, receipt_json) VALUES (?, ?, ?, ?, ?)",
              ...scope(command),
              encodeBranchSqlText(receipt.eventId),
              receipt.payloadHash,
              JSON.stringify(receipt),
            );
          this.sql.execute(
            "INSERT INTO branch_outbox (root_drop_id, branch_id, event_id, outbox_id, outbox_json) VALUES (?, ?, ?, ?, ?)",
            ...scope(command),
            encodeBranchSqlText(receipts[0].eventId),
            outbox!.id,
            JSON.stringify(outbox),
          );
          this.registerOutbox(outbox!, command.target, command.placement);
          return true;
        });
        if (committed) return prepared.result;
      }
      throw new BranchStateError("state_unavailable");
    });
  }

  private runtimeHead(query: BranchHeadQuery): number {
    const row = this.sql.rows(
      "SELECT head_seq FROM branch_runtime_fact_heads WHERE root_drop_id = ? AND branch_id = ?",
      ...scope(query),
    )[0];
    const maximum = this.sql.rows(
      "SELECT MAX(seq) AS maximum FROM branch_runtime_facts WHERE root_drop_id = ? AND branch_id = ?",
      ...scope(query),
    )[0];
    const headSeq = row ? row.head_seq : -1;
    if (
      !Number.isSafeInteger(headSeq) ||
      Number(headSeq) < -1 ||
      maximum?.maximum !== (headSeq === -1 ? null : headSeq)
    )
      return corrupt();
    return headSeq as number;
  }

  private runtimeReceipt(
    query: BranchHeadQuery,
    identity: string,
  ): { intent: string; receipt: BranchRuntimeFactReceipt } | null {
    const rows = this.sql.rows(
      "SELECT f.identity, f.fact_id, f.fact_key, f.seq, f.event_json, r.intent, r.receipt_json, o.outbox_id, o.outbox_json FROM branch_runtime_facts f LEFT JOIN branch_runtime_fact_receipts r ON r.root_drop_id = f.root_drop_id AND r.branch_id = f.branch_id AND r.identity = f.identity LEFT JOIN branch_runtime_fact_outbox o ON o.root_drop_id = f.root_drop_id AND o.branch_id = f.branch_id AND o.identity = f.identity WHERE f.root_drop_id = ? AND f.branch_id = ? AND f.identity = ?",
      ...scope(query),
      identity,
    );
    if (!rows.length) return null;
    const row = rows[0];
    const receipt = json(row.receipt_json) as BranchRuntimeFactReceipt;
    validateRuntimeFactReceipt(receipt, query);
    if (
      receipt.identity !== identity ||
      row.identity !== identity ||
      row.fact_id !== encodeBranchSqlText(receipt.event.factId) ||
      row.fact_key !== encodeBranchSqlText(receipt.key) ||
      row.seq !== receipt.event.seq ||
      canonicalRuntimeFactJson(json(row.event_json)) !==
        canonicalRuntimeFactJson(receipt.event) ||
      row.intent !== runtimeFactIntent(receipt.event.fact) ||
      row.outbox_id !== runtimeFactOutbox(query, receipt).id ||
      canonicalRuntimeFactJson(json(row.outbox_json)) !==
        canonicalRuntimeFactJson(runtimeFactOutbox(query, receipt))
    )
      return corrupt();
    const snapshot = this.sql.rows(
      "SELECT event_seq, source_content_hash FROM branch_snapshots WHERE root_drop_id = ? AND branch_id = ? AND snapshot_id = ?",
      ...scope(query),
      receipt.event.fact.source.snapshotId!,
    )[0];
    if (
      !snapshot ||
      snapshot.source_content_hash !==
        receipt.event.fact.source.sourceContentHash
    )
      return corrupt();
    try {
      this.snapshot(
        {
          target: query.target,
          placement: query.placement,
          version: {
            snapshotId: receipt.event.fact.source.snapshotId!,
            eventSeq: snapshot.event_seq as number,
            sourceContentHash: receipt.event.fact.source
              .sourceContentHash as `sha256:${string}`,
          },
        },
        false,
      );
    } catch (error) {
      if (
        error instanceof BranchStateError &&
        (error.code === "snapshot_not_found" ||
          error.code === "snapshot_version_mismatch")
      )
        return corrupt();
      throw error;
    }
    return { intent: row.intent as string, receipt };
  }

  private nullMemState(query: BranchHeadQuery) {
    const head = this.head(query);
    const snapshots = new Map<number, BranchStateHead["version"]>();
    const verifySnapshot = (captured: BranchStateHead) => {
      const known = snapshots.get(captured.version.snapshotId);
      if (known) {
        if (!sameBranchStateVersion(known, captured.version)) return corrupt();
        return;
      }
      try {
        this.snapshot(captured, false);
      } catch (error) {
        if (
          error instanceof BranchStateError &&
          (error.code === "snapshot_not_found" ||
            error.code === "snapshot_version_mismatch")
        )
          return corrupt();
        throw error;
      }
      snapshots.set(captured.version.snapshotId, captured.version);
    };
    verifySnapshot(head);
    const heads = this.sql.rows(
      "SELECT memory_revision FROM branch_nullmem_heads WHERE root_drop_id = ? AND branch_id = ?",
      ...scope(query),
    );
    const revision = heads.length ? heads[0].memory_revision : 0;
    if (typeof revision !== "number" || (heads.length && revision < 1))
      return corrupt();
    const records = this.sql
      .rows(
        "SELECT identity, record_json FROM branch_nullmem_records WHERE root_drop_id = ? AND branch_id = ? ORDER BY rowid",
        ...scope(query),
      )
      .map((row) => {
        const value = json(row.record_json) as BranchNullMemRecord;
        if (!value || row.identity !== nullMemRecordIdentity(value))
          return corrupt();
        return value;
      });
    const outbox = this.sql
      .rows(
        "SELECT memory_revision, outbox_id, outbox_json FROM branch_nullmem_outbox WHERE root_drop_id = ? AND branch_id = ? ORDER BY memory_revision",
        ...scope(query),
      )
      .map((row) => {
        const value = json(row.outbox_json) as BranchNullMemOutbox;
        if (
          !value?.result ||
          row.memory_revision !== value.result.memoryRevision ||
          row.outbox_id !== value.id
        )
          return corrupt();
        return value;
      });
    validateNullMemState(head, revision, records, outbox);
    for (const entry of outbox) verifySnapshot(entry.result.head);
    return { head, revision, records, outbox };
  }

  private publishNullMem(entry: BranchNullMemOutbox): void {
    const query = entry.result;
    this.sql.execute(
      "INSERT INTO branch_nullmem_heads (root_drop_id, branch_id, memory_revision) VALUES (?, ?, ?) ON CONFLICT(root_drop_id, branch_id) DO UPDATE SET memory_revision = excluded.memory_revision",
      ...scope(query),
      query.memoryRevision,
    );
    this.sql.execute(
      "INSERT INTO branch_nullmem_outbox (root_drop_id, branch_id, memory_revision, outbox_id, outbox_json) VALUES (?, ?, ?, ?, ?)",
      ...scope(query),
      query.memoryRevision,
      entry.id,
      JSON.stringify(entry),
    );
    this.registerOutbox(entry, query.target, query.placement);
  }

  /** Reads exact head and filtered top-N in one transaction; validation and selection may scan all branch memory. */
  async queryNullMem(
    input: BranchNullMemQuery,
  ): Promise<BranchNullMemQueryResult> {
    const query = captureNullMemQuery(input);
    return this.available(() =>
      this.sql.transaction(() => {
        const state = this.nullMemState(query);
        return {
          target: query.target,
          placement: query.placement,
          head: state.head,
          memoryRevision: state.revision,
          records: queryNullMemRecords(state.records, query),
        };
      }),
    );
  }

  /** Assigns a new timestamp and atomically replaces the record, advances revision and publishes an outbox intent. */
  async putNullMem(
    input: BranchNullMemPutCommand,
  ): Promise<BranchNullMemPutResult> {
    const command = captureNullMemPut(input);
    return this.available(() =>
      this.sql.transaction(() => {
        const state = this.nullMemState(command);
        authorizeNullMem(command, state.head);
        const entry = prepareNullMemPut(
          command,
          state.head,
          state.revision,
          this.now(),
        );
        this.sql.execute(
          "INSERT INTO branch_nullmem_records (root_drop_id, branch_id, identity, record_json) VALUES (?, ?, ?, ?) ON CONFLICT(root_drop_id, branch_id, identity) DO UPDATE SET record_json = excluded.record_json",
          ...scope(command),
          nullMemRecordIdentity(entry.result.record),
          JSON.stringify(entry.result.record),
        );
        this.publishNullMem(entry);
        return entry.result;
      }),
    );
  }

  /** Deletes all kinds with the exact ID and commits revision/outbox even when no record exists. */
  async deleteNullMem(
    input: BranchNullMemDeleteCommand,
  ): Promise<BranchNullMemDeleteResult> {
    const command = captureNullMemDelete(input);
    return this.available(() =>
      this.sql.transaction(() => {
        const state = this.nullMemState(command);
        authorizeNullMem(command, state.head);
        const entry = prepareNullMemDelete(
          command,
          state.head,
          state.revision,
          this.now(),
        );
        for (const kind of ["fact", "procedure"])
          this.sql.execute(
            "DELETE FROM branch_nullmem_records WHERE root_drop_id = ? AND branch_id = ? AND identity = ?",
            ...scope(command),
            JSON.stringify([kind, command.recordId]),
          );
        this.publishNullMem(entry);
        return entry.result;
      }),
    );
  }

  /** Test-only authoritative outbox inspection; no derived-work delivery is performed. */
  inspectNullMemOutbox(input: BranchHeadQuery): BranchNullMemOutbox[] {
    const query = BranchStateQuery.head(input);
    return this.sql.transaction(() => this.nullMemState(query).outbox);
  }

  /** Checks generation and current actor before replay, then publishes fact, receipt, head and outbox atomically. */
  async appendRuntimeFact(
    input: BranchRuntimeFactAppendCommand,
  ): Promise<BranchRuntimeFactAppendResult> {
    return this.available(async () => {
      const command = captureRuntimeFactAppend(input);
      const intent = runtimeFactIntent(command.fact);
      const payloadHash = await hashRuntimeFactIntent(intent);
      return this.sql.transaction(() => {
        const head = this.head(command);
        authorizeRuntimeFact(command, head);
        const query = { target: command.target, placement: command.placement };
        const headSeq = this.runtimeHead(query);
        const identity = runtimeFactIdentity(command.fact);
        const existing = this.runtimeReceipt(query, identity);
        if (existing) {
          if (existing.intent !== intent)
            throw new BranchStateError("idempotency_key_reused");
          if (
            existing.receipt.payloadHash !== payloadHash ||
            existing.receipt.event.seq > headSeq
          )
            return corrupt();
          return { ...query, appended: false, receipt: existing.receipt };
        }
        const alias = this.sql.rows(
          "SELECT identity FROM branch_runtime_facts WHERE root_drop_id = ? AND branch_id = ? AND (fact_id = ? OR fact_key = ?)",
          ...scope(query),
          encodeBranchSqlText(nullplugUiRuntimeFactId(command.fact)),
          encodeBranchSqlText(runtimeFactKey(command.fact)),
        );
        if (alias.length) throw new BranchStateError("idempotency_key_reused");
        this.snapshot(head, false);
        const receipt = prepareRuntimeFactReceipt(
          command,
          head,
          headSeq,
          payloadHash,
          this.now(),
        );
        const outbox = runtimeFactOutbox(query, receipt);
        this.sql.execute(
          "INSERT INTO branch_runtime_facts (root_drop_id, branch_id, identity, fact_id, fact_key, seq, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ...scope(query),
          identity,
          encodeBranchSqlText(receipt.event.factId),
          encodeBranchSqlText(receipt.key),
          receipt.event.seq,
          JSON.stringify(receipt.event),
        );
        this.sql.execute(
          "INSERT INTO branch_runtime_fact_receipts (root_drop_id, branch_id, identity, intent, receipt_json) VALUES (?, ?, ?, ?, ?)",
          ...scope(query),
          identity,
          intent,
          JSON.stringify(receipt),
        );
        this.sql.execute(
          "INSERT INTO branch_runtime_fact_heads (root_drop_id, branch_id, head_seq) VALUES (?, ?, ?) ON CONFLICT(root_drop_id, branch_id) DO UPDATE SET head_seq = excluded.head_seq",
          ...scope(query),
          receipt.event.seq,
        );
        this.sql.execute(
          "INSERT INTO branch_runtime_fact_outbox (root_drop_id, branch_id, identity, outbox_id, outbox_json) VALUES (?, ?, ?, ?, ?)",
          ...scope(query),
          identity,
          outbox.id,
          JSON.stringify(outbox),
        );
        this.registerOutbox(outbox, query.target, query.placement);
        return { ...query, appended: true, receipt };
      });
    });
  }

  /** Captures the runtime horizon under durable placement fencing, without initializing missing state. */
  async readRuntimeFactHead(
    input: BranchHeadQuery,
  ): Promise<BranchRuntimeFactHead> {
    return this.available(() => {
      const query = BranchStateQuery.head(input);
      return this.sql.transaction(() => {
        this.head(query);
        return { ...query, headSeq: this.runtimeHead(query) };
      });
    });
  }

  /** Reads a complete contiguous page bounded by the caller's captured runtime horizon. */
  async readRuntimeFacts(
    input: BranchRuntimeFactPageQuery,
  ): Promise<BranchRuntimeFactPage> {
    return this.available(async () => {
      const query = captureRuntimeFactPage(input);
      const page = this.sql.transaction(() => {
        this.head(query);
        if (query.headSeq > this.runtimeHead(query))
          throw new BranchStateError("invalid_command");
        const rows = this.sql.rows(
          "SELECT identity, seq FROM branch_runtime_facts WHERE root_drop_id = ? AND branch_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?",
          ...scope(query),
          query.afterSeq,
          query.headSeq,
          query.limit,
        );
        const count = Math.max(
          0,
          Math.min(query.limit, query.headSeq - query.afterSeq),
        );
        if (rows.length !== count) return corrupt();
        const receipts = rows.map((row, index) => {
          if (
            row.seq !== query.afterSeq + index + 1 ||
            typeof row.identity !== "string"
          )
            return corrupt();
          const stored = this.runtimeReceipt(query, row.identity);
          if (!stored) return corrupt();
          return stored;
        });
        return receipts;
      });
      for (const stored of page)
        if (
          (await hashRuntimeFactIntent(stored.intent)) !==
          stored.receipt.payloadHash
        )
          return corrupt();
      // Hash verification yields; durable generation is rechecked before returning the captured page.
      this.sql.transaction(() => {
        this.head(query);
      });
      const facts = page.map(({ receipt }) => receipt.event);
      return {
        target: query.target,
        placement: query.placement,
        headSeq: query.headSeq,
        facts,
        nextCursor: facts.length ? facts[facts.length - 1].seq : null,
      };
    });
  }

  /** Reads a persisted head and verifies that its exact snapshot exists; no cache authority or initialization. */
  async readHead(input: BranchHeadQuery): Promise<BranchStateHead> {
    return this.available(() =>
      this.sql.transaction(() => {
        const head = this.head(BranchStateQuery.head(input));
        try {
          this.snapshot(head, false);
        } catch (error) {
          if (
            error instanceof BranchStateError &&
            (error.code === "snapshot_not_found" ||
              error.code === "snapshot_version_mismatch")
          )
            return corrupt();
          throw error;
        }
        return head;
      }),
    );
  }

  /** Verifies durable placement and exact snapshot identity even on L1 hits; hash-verifies cold content before caching. */
  async readContent(input: BranchContentQuery): Promise<BranchStateContent> {
    return this.available(async () => {
      const query = BranchStateQuery.content(input);
      this.sql.transaction(() => {
        this.head(query);
        this.snapshot(query, false);
      });
      const content = await this.cache.load(query, async () => {
        const stored = this.sql.transaction(() => {
          this.head(query);
          return this.snapshot(query, true);
        });
        if (
          (await hashNulldownSourceContent(stored.content!)) !==
          query.version.sourceContentHash
        )
          return corrupt();
        return { ...query, content: stored.content! };
      });
      // Hashing/singleflight may yield: placement must still be valid at the response boundary.
      const latest = this.sql.transaction(() => {
        this.head(query);
        return this.snapshot(query, false);
      });
      if (content.content.length !== latest.snapshot.textLength)
        return corrupt();
      return content;
    });
  }

  private discoveredSnapshot(
    query: BranchHeadQuery,
    row: Row,
  ): BranchSnapshotState {
    const identity = storedQuery({
      target: query.target,
      placement: query.placement,
      version: {
        snapshotId: row.snapshot_id,
        eventSeq: row.event_seq,
        sourceContentHash: row.source_content_hash,
      },
    });
    return {
      ...identity,
      snapshot: this.snapshotRecord(identity, row, false).snapshot,
    };
  }

  /** Reads persisted metadata and its complete version in one transaction, including snapshot zero. */
  async readSnapshot(
    input: BranchSnapshotQuery,
  ): Promise<BranchSnapshotState | null> {
    return this.available(() => {
      const query = BranchLifecycleQuery.snapshot(input);
      return this.sql.transaction(() => {
        const head = this.head(query);
        const row = this.sql.rows(
          "SELECT s.snapshot_id, s.event_seq, s.source_content_hash, s.snapshot_json, p.event_seq AS parent_event_seq FROM branch_snapshots s LEFT JOIN branch_snapshots p ON p.root_drop_id = s.root_drop_id AND p.branch_id = s.branch_id AND p.snapshot_id = s.snapshot_id - 1 WHERE s.root_drop_id = ? AND s.branch_id = ? AND s.snapshot_id = ?",
          ...scope(query),
          query.snapshotId,
        )[0];
        if (!row) {
          if (query.snapshotId <= head.version.snapshotId) return corrupt();
          return null;
        }
        if (query.snapshotId > head.version.snapshotId) return corrupt();
        const snapshot = this.discoveredSnapshot(query, row);
        if (
          query.snapshotId === head.version.snapshotId &&
          !sameBranchStateVersion(snapshot.version, head.version)
        )
          return corrupt();
        return snapshot;
      });
    });
  }

  /** Indexed contiguous ascending page pinned to an exact captured snapshot, without hydrating content. */
  async listSnapshots(
    input: BranchSnapshotPageQuery,
  ): Promise<BranchSnapshotPage> {
    return this.available(() => {
      const query = BranchLifecycleQuery.page(input);
      return this.sql.transaction(() => {
        const head = this.head(query);
        if (query.version.snapshotId > head.version.snapshotId)
          throw new BranchStateError("snapshot_not_found");
        this.snapshot(query, false);
        const end = Math.min(
          query.version.snapshotId,
          query.afterSnapshotId + query.limit,
        );
        const rows = this.sql.rows(
          "SELECT s.snapshot_id, s.event_seq, s.source_content_hash, s.snapshot_json, p.event_seq AS parent_event_seq FROM branch_snapshots s LEFT JOIN branch_snapshots p ON p.root_drop_id = s.root_drop_id AND p.branch_id = s.branch_id AND p.snapshot_id = s.snapshot_id - 1 WHERE s.root_drop_id = ? AND s.branch_id = ? AND s.snapshot_id > ? AND s.snapshot_id <= ? ORDER BY s.snapshot_id ASC LIMIT ?",
          ...scope(query),
          query.afterSnapshotId,
          query.version.snapshotId,
          query.limit,
        );
        if (rows.length !== end - query.afterSnapshotId) return corrupt();
        const snapshots = rows.map((row, index) => {
          if (row.snapshot_id !== query.afterSnapshotId + index + 1)
            return corrupt();
          return this.discoveredSnapshot(query, row);
        });
        return {
          snapshots,
          nextAfterSnapshotId: end < query.version.snapshotId ? end : null,
        };
      });
    });
  }

  /** Reads one bounded contiguous inclusive range in a consistent SQL transaction; rejects malformed or missing rows. */
  async readEvents(input: BranchEventRangeQuery): Promise<DropDiffEvent[]> {
    return this.available(() => {
      const query = BranchStateQuery.range(input);
      return this.sql.transaction(() => {
        this.head(query);
        this.snapshot(query, false);
        const rows = this.sql.rows(
          "SELECT branch_events.event_seq, branch_events.event_id, branch_events.snapshot_id, branch_events.event_json, s.event_seq AS snapshot_event_seq, s.source_content_hash, s.snapshot_json, p.event_seq AS parent_event_seq FROM branch_events LEFT JOIN branch_snapshots s ON s.root_drop_id = branch_events.root_drop_id AND s.branch_id = branch_events.branch_id AND s.snapshot_id = branch_events.snapshot_id LEFT JOIN branch_snapshots p ON p.root_drop_id = s.root_drop_id AND p.branch_id = s.branch_id AND p.snapshot_id = s.snapshot_id - 1 WHERE branch_events.root_drop_id = ? AND branch_events.branch_id = ? AND branch_events.event_seq >= ? AND branch_events.event_seq <= ? ORDER BY branch_events.event_seq ASC LIMIT 200",
          ...scope(query),
          query.startSeq,
          query.endSeq,
        );
        if (rows.length !== query.endSeq - query.startSeq + 1) return corrupt();
        return rows.map((row, index) => {
          const event = json(row.event_json);
          if (
            !isDropDiffEvent(event) ||
            event.seq !== query.startSeq + index ||
            event.seq !== row.event_seq ||
            encodeBranchSqlText(event.eventId) !== row.event_id ||
            event.snapshotId !== row.snapshot_id ||
            event.dropId !== query.target.rootDropId ||
            event.snapshotId === undefined ||
            event.snapshotId > query.version.snapshotId ||
            (event.metadata?.followsSeq !== undefined &&
              event.metadata.followsSeq !== event.seq - 1)
          )
            return corrupt();
          const eventQuery = storedQuery({
            target: query.target,
            placement: query.placement,
            version: {
              snapshotId: event.snapshotId,
              eventSeq: row.snapshot_event_seq,
              sourceContentHash: row.source_content_hash,
            },
          });
          const eventSnapshot = this.snapshotRecord(
            eventQuery,
            { ...row, event_seq: row.snapshot_event_seq },
            false,
          ).snapshot;
          if (
            eventSnapshot.eventIds[event.seq - eventSnapshot.patchStartSeq!] !==
            event.eventId
          )
            return corrupt();
          return event;
        });
      });
    });
  }

  /** Looks up one canonical witness by unique indexed ID without scanning unrelated histories. */
  private canonicalOutboxById(
    id: string,
    root: string,
    branch: string,
  ): BranchCanonicalOutbox | null {
    const candidates = [
      this.sql.rows(
        `SELECT outbox_json FROM branch_outbox WHERE outbox_id=? AND root_drop_id=? AND branch_id=?`,
        id,
        root,
        branch,
      ),
      this.sql.rows(
        `SELECT outbox_json FROM branch_runtime_fact_outbox WHERE outbox_id=? AND root_drop_id=? AND branch_id=?`,
        id,
        root,
        branch,
      ),
      this.sql.rows(
        `SELECT outbox_json FROM branch_nullmem_outbox WHERE outbox_id=? AND root_drop_id=? AND branch_id=?`,
        id,
        root,
        branch,
      ),
    ].flat();
    if (candidates.length > 1) return corrupt();
    return candidates.length
      ? (json(candidates[0].outbox_json) as BranchCanonicalOutbox)
      : null;
  }

  /** Incrementally registers canonical rows that predate delivery bookkeeping. Cursor state is durable and keyed per source. */
  private bootstrapOutbox(pageSize: number): void {
    const sources = [
      { id: "diff", table: "branch_outbox" },
      { id: "runtime", table: "branch_runtime_fact_outbox" },
      { id: "nullmem", table: "branch_nullmem_outbox" },
    ] as const;
    for (const source of sources) {
      this.sql.execute(
        `INSERT OR IGNORE INTO branch_outbox_delivery_bootstrap (source,rowid_cursor,complete) VALUES (?,0,0)`,
        source.id,
      );
      const progress = this.sql.rows(
        `SELECT rowid_cursor,complete FROM branch_outbox_delivery_bootstrap WHERE source=?`,
        source.id,
      )[0];
      if (!progress || progress.complete === 1) continue;
      const rows = this.sql.rows(
        `SELECT rowid AS source_rowid,root_drop_id,branch_id,outbox_id,outbox_json FROM ${source.table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        progress.rowid_cursor as number,
        pageSize,
      );
      for (const row of rows) {
        const target = {
          rootDropId: decodeBranchSqlText(row.root_drop_id),
          branchId: decodeBranchSqlText(row.branch_id),
        };
        const outbox = json(row.outbox_json) as BranchCanonicalOutbox;
        if (!outbox || outbox.id !== row.outbox_id) return corrupt();
        const captured = canonicalOutboxPlacement(outbox);
        if (
          captured.target.rootDropId !== target.rootDropId ||
          captured.target.branchId !== target.branchId
        )
          return corrupt();
        const existing = this.sql.rows(
          `SELECT kind,root_drop_id,branch_id,generation FROM branch_outbox_delivery WHERE outbox_id=?`,
          outbox.id,
        )[0];
        if (existing) {
          if (
            existing.kind !== outbox.kind ||
            existing.root_drop_id !== row.root_drop_id ||
            existing.branch_id !== row.branch_id ||
            existing.generation !== captured.placement.generation
          )
            return corrupt();
        } else
          this.sql.execute(
            `INSERT INTO branch_outbox_delivery (outbox_id,kind,root_drop_id,branch_id,generation,status,attempts,next_attempt_at) VALUES (?,?,?,?,?,'pending',0,0)`,
            outbox.id,
            outbox.kind,
            row.root_drop_id as string,
            row.branch_id as string,
            captured.placement.generation,
          );
      }
      const cursor = rows.length
        ? (rows[rows.length - 1].source_rowid as number)
        : (progress.rowid_cursor as number);
      this.sql.execute(
        `UPDATE branch_outbox_delivery_bootstrap SET rowid_cursor=?,complete=? WHERE source=?`,
        cursor,
        rows.length < pageSize ? 1 : 0,
        source.id,
      );
    }
  }

  /** Claims due canonical work across all branch rows owned by this SQL shard. */
  async claimOutbox(command: BranchOutboxClaimCommand) {
    validateOutboxClaim(command);
    return this.available(() =>
      this.sql.transaction(() => {
        this.bootstrapOutbox(Math.max(16, command.limit));
        const candidates = this.sql.rows(
          `SELECT d.outbox_id,d.kind,d.root_drop_id,d.branch_id,d.generation,d.attempts,d.status,d.next_attempt_at,d.lease_until
         FROM branch_outbox_delivery d INDEXED BY branch_outbox_delivery_active_due
           WHERE d.status IN ('pending','claimed') AND d.next_attempt_at<=?
         ORDER BY d.next_attempt_at,d.outbox_id LIMIT ?`,
          command.now,
          command.limit,
        );
        const leaseUntil = command.now + command.leaseMs;
        const items: BranchOutboxDeliveryItem[] = [];
        for (const row of candidates) {
          if (
            typeof row.outbox_id !== "string" ||
            ![
              "branch.commit.v1",
              "branch.batch-commit.v1",
              "branch.runtime-fact.v1",
              "branch.nullmem.v1",
            ].includes(row.kind as string) ||
            typeof row.root_drop_id !== "string" ||
            typeof row.branch_id !== "string" ||
            !Number.isSafeInteger(row.generation)
          )
            return corrupt();
          const target = {
            rootDropId: decodeBranchSqlText(row.root_drop_id),
            branchId: decodeBranchSqlText(row.branch_id),
          };
          const generation = row.generation as number;
          if (
            row.status === "claimed" &&
            (typeof row.lease_until !== "number" ||
              row.next_attempt_at !== row.lease_until)
          )
            return corrupt();
          const head = this.sql.rows(
            `SELECT generation FROM branch_heads WHERE root_drop_id=? AND branch_id=?`,
            row.root_drop_id as string,
            row.branch_id as string,
          )[0];
          if (!head || head.generation !== generation) {
            this.sql.execute(
              `UPDATE branch_outbox_delivery SET status='fenced',lease_id=NULL,lease_token=NULL,lease_until=NULL WHERE outbox_id=? AND status IN ('pending','claimed')`,
              row.outbox_id,
            );
            continue;
          }
          const attempt =
            (typeof row.attempts === "number" ? row.attempts : 0) + 1;
          const leaseToken = outboxLeaseToken(
            command.leaseId,
            row.outbox_id as string,
            attempt,
          );
          this.sql.execute(
            `INSERT INTO branch_outbox_delivery (outbox_id,kind,root_drop_id,branch_id,generation,status,attempts,next_attempt_at,lease_id,lease_token,lease_until)
           VALUES (?,?,?,?,?,'claimed',?,?,?,?,?) ON CONFLICT(outbox_id) DO UPDATE SET kind=excluded.kind,generation=excluded.generation,status='claimed',attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,lease_id=excluded.lease_id,lease_token=excluded.lease_token,lease_until=excluded.lease_until,completed_at=NULL`,
            row.outbox_id,
            row.kind as string,
            row.root_drop_id,
            row.branch_id,
            generation,
            attempt,
            leaseUntil,
            command.leaseId,
            leaseToken,
            leaseUntil,
          );
          items.push({
            target,
            placement: { routingVersion: 1, generation },
            outboxId: row.outbox_id,
            leaseToken,
          });
        }
        return { leaseId: command.leaseId, leaseUntil, items };
      }),
    );
  }

  /** Returns exact canonical records only while their individual claim and current generation are valid. */
  async readClaimedOutbox(
    command: BranchOutboxClaimResultCommand,
  ): Promise<BranchClaimedOutbox[]> {
    validateOutboxClaimResult(command);
    return this.available(() =>
      this.sql.transaction(() =>
        command.items.flatMap((item) => {
          const status = this.sql.rows(
            `SELECT kind,status,attempts,next_attempt_at,lease_id,lease_token,lease_until,root_drop_id,branch_id,generation FROM branch_outbox_delivery WHERE outbox_id = ?`,
            item.outboxId,
          )[0];
          if (
            !status ||
            status.status !== "claimed" ||
            status.lease_id !== command.leaseId ||
            status.lease_token !== item.leaseToken ||
            typeof status.lease_until !== "number" ||
            status.lease_until <= command.now ||
            status.next_attempt_at !== status.lease_until ||
            status.generation !== item.placement.generation ||
            status.root_drop_id !==
              encodeBranchSqlText(item.target.rootDropId) ||
            status.branch_id !== encodeBranchSqlText(item.target.branchId)
          )
            return [];
          const head = this.sql.rows(
            `SELECT generation FROM branch_heads WHERE root_drop_id = ? AND branch_id = ?`,
            status.root_drop_id as string,
            status.branch_id as string,
          )[0];
          if (!head || head.generation !== item.placement.generation) return [];
          const outbox = this.canonicalOutboxById(
            item.outboxId,
            status.root_drop_id as string,
            status.branch_id as string,
          );
          if (
            !outbox ||
            outbox.id !== item.outboxId ||
            outbox.kind !== status.kind
          )
            return corrupt();
          const witness = canonicalOutboxPlacement(outbox);
          if (
            witness.placement.generation !== item.placement.generation ||
            witness.target.rootDropId !== item.target.rootDropId ||
            witness.target.branchId !== item.target.branchId
          )
            return corrupt();
          return [
            {
              target: item.target,
              placement: item.placement,
              outbox,
              status: "claimed" as const,
              attempt: status.attempts as number,
              leaseUntil: status.lease_until,
            },
          ];
        }),
      ),
    );
  }

  /** Acknowledges exact live claims; completed markers make acknowledgement idempotent. */
  async acknowledgeOutbox(command: BranchOutboxClaimResultCommand) {
    validateOutboxClaimResult(command);
    return this.available(() =>
      this.sql.transaction(() => {
        let acknowledged = 0,
          duplicate = 0,
          stale = 0;
        for (const item of command.items) {
          const row = this.sql.rows(
            `SELECT status,next_attempt_at,lease_id,lease_token,lease_until,root_drop_id,branch_id,generation FROM branch_outbox_delivery WHERE outbox_id = ?`,
            item.outboxId,
          )[0];
          const head = row
            ? this.sql.rows(
                `SELECT generation FROM branch_heads WHERE root_drop_id = ? AND branch_id = ?`,
                row.root_drop_id as string,
                row.branch_id as string,
              )[0]
            : undefined;
          if (
            !row ||
            row.generation !== item.placement.generation ||
            row.root_drop_id !== encodeBranchSqlText(item.target.rootDropId) ||
            row.branch_id !== encodeBranchSqlText(item.target.branchId) ||
            !head ||
            head.generation !== item.placement.generation
          ) {
            stale++;
            continue;
          }
          if (row.status === "completed") {
            duplicate++;
            continue;
          }
          if (
            row.status !== "claimed" ||
            row.lease_id !== command.leaseId ||
            row.lease_token !== item.leaseToken ||
            typeof row.lease_until !== "number" ||
            row.lease_until <= command.now
          ) {
            stale++;
            continue;
          }
          this.sql.execute(
            `UPDATE branch_outbox_delivery SET status='completed',completed_at=?,lease_id=NULL,lease_token=NULL,lease_until=NULL WHERE outbox_id=?`,
            command.now,
            item.outboxId,
          );
          acknowledged++;
        }
        return { acknowledged, duplicate, stale };
      }),
    );
  }

  /** Stores exponential retry timing without affecting canonical accepted state. */
  async retryOutbox(
    command: BranchOutboxClaimResultCommand & { errorCode: string },
  ) {
    validateOutboxClaimResult(command);
    if (
      typeof command.errorCode !== "string" ||
      !/^[a-z0-9_.-]{1,80}$/.test(command.errorCode)
    )
      throw new BranchStateError("invalid_command");
    return this.available(() =>
      this.sql.transaction(() => {
        let retried = 0,
          stale = 0;
        for (const item of command.items) {
          const row = this.sql.rows(
            `SELECT status,attempts,next_attempt_at,lease_id,lease_token,lease_until,root_drop_id,branch_id,generation FROM branch_outbox_delivery WHERE outbox_id = ?`,
            item.outboxId,
          )[0];
          const head = row
            ? this.sql.rows(
                `SELECT generation FROM branch_heads WHERE root_drop_id = ? AND branch_id = ?`,
                row.root_drop_id as string,
                row.branch_id as string,
              )[0]
            : undefined;
          if (
            !row ||
            row.status !== "claimed" ||
            row.lease_id !== command.leaseId ||
            row.lease_token !== item.leaseToken ||
            typeof row.lease_until !== "number" ||
            row.lease_until <= command.now ||
            row.next_attempt_at !== row.lease_until ||
            row.generation !== item.placement.generation ||
            row.root_drop_id !== encodeBranchSqlText(item.target.rootDropId) ||
            row.branch_id !== encodeBranchSqlText(item.target.branchId) ||
            !head ||
            head.generation !== item.placement.generation
          ) {
            stale++;
            continue;
          }
          this.sql.execute(
            `UPDATE branch_outbox_delivery SET status='pending',next_attempt_at=?,last_error_code=?,lease_id=NULL,lease_token=NULL,lease_until=NULL WHERE outbox_id=?`,
            outboxRetryAt(command.now, row.attempts as number),
            command.errorCode,
            item.outboxId,
          );
          retried++;
        }
        return { retried, stale };
      }),
    );
  }

  /** Compacts old completion timestamps while retaining outbox-ID tombstones against replay. */
  async pruneCompletedOutbox(command: { before: number; limit: number }) {
    if (
      !command ||
      !Number.isSafeInteger(command.before) ||
      command.before < 0 ||
      !Number.isSafeInteger(command.limit) ||
      command.limit < 1 ||
      command.limit > 256
    )
      throw new BranchStateError("invalid_command");
    return this.available(() =>
      this.sql.transaction(() => {
        const rows = this.sql.rows(
          `SELECT outbox_id FROM branch_outbox_delivery WHERE status='completed' AND completed_at IS NOT NULL AND completed_at <= ? ORDER BY completed_at,outbox_id LIMIT ?`,
          command.before,
          command.limit,
        );
        for (const row of rows)
          this.sql.execute(
            `UPDATE branch_outbox_delivery SET completed_at=NULL,attempts=0,next_attempt_at=0,last_error_code=NULL WHERE outbox_id=? AND status='completed'`,
            row.outbox_id as string,
          );
        return { pruned: rows.length };
      }),
    );
  }
}
