import {
  isDropBranchRecord,
  isDropSnapshotRecord,
  type DropSnapshotRecord,
} from "../../../shared/drop/branch";
import { isDropDiffEvent, type DropDiffEvent } from "../../../shared/drop/diff";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import { prepareBranchCommit } from "../../../shared/drop/branch-commit";
import {
  BranchAppendCommand,
  BranchStateError,
  BranchStateQuery,
  sameBranchStateVersion,
  type BranchAppendRecord,
  type BranchAppendOutcome,
  type BranchCommitStatePlane,
  type BranchCommitReceipt,
  type BranchContentQuery,
  type BranchEventRangeQuery,
  type BranchHeadQuery,
  type BranchStateHead,
  type BranchStateContent,
} from "../../../shared/drop/branch-state";
import type { MemoryBranchStateSeed } from "./memory-commits";
import type { BranchSqlPort } from "./sqlite-port";
import {
  decodeBranchSqlText,
  encodeBranchSqlText,
  initializeBranchSqlSchema,
} from "./sqlite-schema";
import { ExactContentCache } from "./exact-content-cache";

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
export class SqliteBranchCommitStatePlane implements BranchCommitStatePlane {
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

  private head(query: BranchHeadQuery): BranchStateHead {
    this.routing(query);
    const row = this.sql.rows(
      "SELECT routing_version, generation, head_json FROM branch_heads WHERE root_drop_id = ? AND branch_id = ?",
      ...scope(query),
    )[0];
    if (!row) throw new BranchStateError("branch_not_found");
    // Stored placement is checked before receipt lookup and every cache lookup.
    if (
      row.routing_version !== 1 ||
      !Number.isSafeInteger(row.generation) ||
      (row.generation as number) < 0
    )
      return corrupt();
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
    return { ...identity, branch };
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
      `SELECT snapshot_id, event_seq, source_content_hash, snapshot_json${includeContent ? ", content" : ""} FROM branch_snapshots WHERE root_drop_id = ? AND branch_id = ? AND snapshot_id = ?`,
      ...scope(query),
      query.version.snapshotId,
    )[0];
    if (!row) throw new BranchStateError("snapshot_not_found");
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
    } else if (
      snapshot.parentSnapshotId !== snapshot.snapshotId - 1 ||
      snapshot.eventIds.length !== 1 ||
      snapshot.patchStartSeq !== identity.version.eventSeq ||
      snapshot.patchEndSeq !== identity.version.eventSeq ||
      identity.version.eventSeq !== snapshot.snapshotId - 1
    )
      return corrupt();
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
    command: BranchAppendRecord,
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
      identity.version.eventSeq !== identity.version.snapshotId - 1 ||
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
    };
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
        return { status: "accepted", receipt: prepared.receipt };
      });
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

  /** Reads one bounded contiguous inclusive range in a consistent SQL transaction; rejects malformed or missing rows. */
  async readEvents(input: BranchEventRangeQuery): Promise<DropDiffEvent[]> {
    return this.available(() => {
      const query = BranchStateQuery.range(input);
      return this.sql.transaction(() => {
        this.head(query);
        this.snapshot(query, false);
        const rows = this.sql.rows(
          "SELECT event_seq, event_id, snapshot_id, event_json FROM branch_events WHERE root_drop_id = ? AND branch_id = ? AND event_seq >= ? AND event_seq <= ? ORDER BY event_seq ASC LIMIT 200",
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
            event.snapshotId !== event.seq + 1 ||
            event.dropId !== query.target.rootDropId ||
            event.metadata?.followsSeq !== event.seq - 1
          )
            return corrupt();
          return event;
        });
      });
    });
  }
}
