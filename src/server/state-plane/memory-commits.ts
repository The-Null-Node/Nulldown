import {
  isDropBranchRecord,
  type DropBranchRecord,
  type DropSnapshotRecord,
} from "../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../shared/drop/diff";
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
  type BranchBatchCommitOutboxRecord,
  type BranchCommitReceipt,
  type BranchCommitOutboxRecord,
  type BranchContentQuery,
  type BranchEventRangeQuery,
  type BranchHeadQuery,
  type BranchStateHead,
  type BranchStateContent,
  type BranchStatePlacement,
} from "../../../shared/drop/branch-state";
import {
  BranchLifecycleQuery,
  initialBranchSnapshot,
  prepareBranchInitialization,
  sameBranchInitializationIdentity,
  type BranchLifecycleStatePlane,
  type BranchAuthorityRecord,
  type BranchPlacementQuery,
  type BranchReserveRecord,
  type BranchReserveOutcome,
  type BranchInitializeRecord,
  type BranchInitializeOutcome,
  type BranchInitializationReceipt,
  type BranchSnapshotQuery,
  type BranchSnapshotState,
  type BranchSnapshotPageQuery,
  type BranchSnapshotPage,
} from "../../../shared/drop/branch-lifecycle";

/** Explicit local fixture initialization; not an import, migration, or branch-lifecycle API. */
export interface MemoryBranchStateSeed {
  branch: DropBranchRecord;
  content: string;
  placement: BranchStatePlacement;
}

type State = {
  head: BranchStateHead;
  snapshots: Map<number, BranchStateContent>;
  snapshotMetadata: Map<number, DropSnapshotRecord>;
  events: Map<number, DropDiffEvent>;
  receipts: Map<string, BranchCommitReceipt>;
  outbox: Map<string, BranchCommitOutboxRecord | BranchBatchCommitOutboxRecord>;
};

const key = (target: BranchHeadQuery["target"]): string =>
  JSON.stringify([target.rootDropId, target.branchId]);

/**
 * Deterministic in-memory reference for local contract tests, not durable authority or a production cache.
 * Each instance owns seeded branches; returned values never share mutable state with storage.
 */
export class MemoryBranchCommitStatePlane implements BranchLifecycleStatePlane {
  private readonly states = new Map<string, State>();
  private readonly authorities = new Map<string, BranchAuthorityRecord>();
  private readonly initializations = new Map<
    string,
    { intent: string; receipt: BranchInitializationReceipt }
  >();

  private constructor(private readonly now: () => number) {}

  /** Captures and validates all initial empty timelines before hashing; existing history cannot be silently truncated. */
  static async create(
    seeds: readonly MemoryBranchStateSeed[] = [],
    now: () => number = Date.now,
  ): Promise<MemoryBranchCommitStatePlane> {
    const plane = new MemoryBranchCommitStatePlane(now);
    const targets = new Set<string>();
    const capturedSeeds = seeds.map((seed) => {
      const branch = structuredClone(seed.branch);
      const content = seed.content;
      if (
        !isDropBranchRecord(branch) ||
        branch.headSnapshotId !== 0 ||
        branch.headEventSeq !== -1 ||
        typeof content !== "string"
      ) {
        throw new BranchStateError("invalid_command");
      }
      const query = BranchStateQuery.head({
        target: { rootDropId: branch.rootDropId, branchId: branch.branchId },
        placement: seed.placement,
      });
      if (query.placement.routingVersion !== 1)
        throw new BranchStateError("routing_version_unsupported");
      const target = key(query.target);
      if (targets.has(target)) throw new BranchStateError("invalid_command");
      targets.add(target);
      return { branch, content, query };
    });
    for (const { branch, content, query } of capturedSeeds) {
      const version = {
        snapshotId: 0,
        eventSeq: -1,
        sourceContentHash: await hashNulldownSourceContent(content),
      };
      plane.states.set(key(query.target), {
        head: { ...query, branch, version },
        snapshots: new Map([[0, { ...query, version, content }]]),
        snapshotMetadata: new Map([
          [0, initialBranchSnapshot({ ...query, branch, version }, content)],
        ]),
        events: new Map(),
        receipts: new Map(),
        outbox: new Map(),
      });
    }
    return plane;
  }

  private state(query: BranchHeadQuery): State {
    if (query.placement.routingVersion !== 1)
      throw new BranchStateError("routing_version_unsupported");
    const state = this.states.get(key(query.target));
    if (!state) {
      const authority = this.authorities.get(key(query.target));
      if (
        authority &&
        authority.placement.generation !== query.placement.generation
      )
        throw new BranchStateError("routing_generation_mismatch");
      throw new BranchStateError(
        authority?.state === "pending"
          ? "branch_initialization_pending"
          : authority
            ? "state_corrupt"
            : "branch_not_found",
      );
    }
    if (state.head.placement.generation !== query.placement.generation)
      throw new BranchStateError("routing_generation_mismatch");
    return state;
  }

  /** Discovers durable ownership without creating state or guessing a generation. */
  async readPlacement(
    input: BranchPlacementQuery,
  ): Promise<BranchAuthorityRecord | null> {
    const query = BranchLifecycleQuery.placement(input);
    const authority = this.authorities.get(key(query.target));
    if (!authority && this.states.has(key(query.target)))
      throw new BranchStateError("state_corrupt");
    return structuredClone(authority ?? null);
  }

  /** Publishes one winning reservation before any root bytes are supplied. */
  async reserve(input: BranchReserveRecord): Promise<BranchReserveOutcome> {
    const command = BranchLifecycleQuery.reserve(input);
    if (command.placement.routingVersion !== 1)
      throw new BranchStateError("routing_version_unsupported");
    const id = key(command.target);
    const existing = this.authorities.get(id);
    if (existing) {
      if (existing.placement.generation !== command.placement.generation)
        throw new BranchStateError("routing_generation_mismatch");
      if (
        !sameBranchInitializationIdentity(
          existing.reservation.identity,
          command.identity,
        )
      )
        throw new BranchStateError("branch_initialization_conflict");
      return { status: "existing", authority: structuredClone(existing) };
    }
    if (this.states.has(id))
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
    this.authorities.set(id, authority);
    return { status: "reserved", authority: structuredClone(authority) };
  }

  /** Atomically activates a reserved timeline; replays acknowledge the original snapshot zero. */
  async initialize(
    input: BranchInitializeRecord,
  ): Promise<BranchInitializeOutcome> {
    const command = BranchLifecycleQuery.initialize(input);
    if (command.placement.routingVersion !== 1)
      throw new BranchStateError("routing_version_unsupported");
    const id = key(command.target);
    const authority = this.authorities.get(id);
    if (!authority) throw new BranchStateError("branch_not_found");
    if (authority.placement.generation !== command.placement.generation)
      throw new BranchStateError("routing_generation_mismatch");
    const prepared = await prepareBranchInitialization(authority, command);
    const latest = this.authorities.get(id);
    if (!latest) throw new BranchStateError("state_corrupt");
    if (latest.placement.generation !== command.placement.generation)
      throw new BranchStateError("routing_generation_mismatch");
    if (latest.state === "active") {
      const stored = this.initializations.get(id);
      if (!stored || !this.states.has(id))
        throw new BranchStateError("state_corrupt");
      if (stored.intent !== prepared.intent)
        throw new BranchStateError("branch_initialization_conflict");
      return { status: "duplicate", receipt: structuredClone(stored.receipt) };
    }
    if (this.states.has(id) || this.initializations.has(id))
      throw new BranchStateError("state_corrupt");
    this.states.set(id, {
      head: prepared.head,
      snapshots: new Map([
        [
          0,
          {
            target: command.target,
            placement: command.placement,
            version: prepared.head.version,
            content: command.content,
          },
        ],
      ]),
      snapshotMetadata: new Map([[0, prepared.snapshot]]),
      events: new Map(),
      receipts: new Map(),
      outbox: new Map(),
    });
    this.initializations.set(id, {
      intent: prepared.intent,
      receipt: prepared.receipt,
    });
    this.authorities.set(id, { ...latest, state: "active" });
    return { status: "created", receipt: structuredClone(prepared.receipt) };
  }

  private duplicate(
    state: State,
    command: BranchAppendRecord,
  ): BranchAppendOutcome | undefined {
    const receipt = state.receipts.get(command.event.eventId);
    if (!receipt) return;
    if (receipt.payloadHash !== command.payloadHash)
      throw new BranchStateError("diff_event_id_reused");
    return { status: "duplicate", receipt: structuredClone(receipt) };
  }

  /** Applies generation, duplicate identity, then predecessor fencing; publishes all state with one synchronous map replacement. */
  async append(input: BranchAppendRecord): Promise<BranchAppendOutcome> {
    const command = (await BranchAppendCommand.fromRecord(input)).toRecord();
    const state = this.state(command);
    const duplicate = this.duplicate(state, command);
    if (duplicate) return duplicate;
    const current = state.snapshots.get(state.head.version.snapshotId);
    if (!current) throw new BranchStateError("state_corrupt");
    const prepared = await prepareBranchCommit(
      command,
      state.head,
      current.content,
      this.now(),
    );
    // No awaits between these final checks and publication: competing prepares cannot overwrite a winner.
    const latest = this.state(command);
    const replay = this.duplicate(latest, command);
    if (replay) return replay;
    if (!sameBranchStateVersion(latest.head.version, command.expected))
      throw new BranchStateError("diff_predecessor_mismatch");
    const query = { target: command.target, placement: command.placement };
    const next: State = {
      head: {
        ...query,
        branch: prepared.branch,
        version: prepared.receipt.version,
      },
      snapshots: new Map(latest.snapshots),
      snapshotMetadata: new Map(latest.snapshotMetadata),
      events: new Map(latest.events),
      receipts: new Map(latest.receipts),
      outbox: new Map(latest.outbox),
    };
    next.snapshots.set(prepared.snapshot.snapshotId, {
      ...query,
      version: prepared.receipt.version,
      content: prepared.content,
    });
    next.events.set(prepared.event.seq, prepared.event);
    next.snapshotMetadata.set(prepared.snapshot.snapshotId, prepared.snapshot);
    next.receipts.set(prepared.event.eventId, prepared.receipt);
    next.outbox.set(prepared.outbox.id, prepared.outbox);
    this.states.set(key(command.target), next);
    return { status: "accepted", receipt: structuredClone(prepared.receipt) };
  }

  /** Prepares an entire envelope and publishes it with one synchronous state replacement; contention restarts classification. */
  async appendBatch(
    input: BranchBatchAppendRecord,
  ): Promise<BranchBatchAppendResult> {
    const command = captureBranchBatchAppend(input);
    const identities = await hashBranchBatchEvents(command.events);
    for (let attempt = 0; attempt < 32; attempt++) {
      const state = this.state(command);
      const current = state.snapshots.get(state.head.version.snapshotId);
      if (!current) throw new BranchStateError("state_corrupt");
      const prepared = await prepareBranchBatch(
        command,
        identities,
        state.head,
        current.content,
        state.receipts,
        this.now(),
      );
      const latest = this.state(command);
      if (latest !== state) continue;
      if (!prepared.result.snapshot) return structuredClone(prepared.result);
      const next: State = {
        head: {
          target: command.target,
          placement: command.placement,
          branch: prepared.result.branch,
          version: prepared.version,
        },
        snapshots: new Map(state.snapshots),
        snapshotMetadata: new Map(state.snapshotMetadata),
        events: new Map(state.events),
        receipts: new Map(state.receipts),
        outbox: new Map(state.outbox),
      };
      next.snapshots.set(prepared.version.snapshotId, {
        target: command.target,
        placement: command.placement,
        version: prepared.version,
        content: prepared.result.content,
      });
      for (const event of prepared.result.acceptedEvents)
        next.events.set(event.seq, event);
      next.snapshotMetadata.set(
        prepared.version.snapshotId,
        prepared.result.snapshot,
      );
      for (const receipt of prepared.receipts)
        next.receipts.set(receipt.eventId, receipt);
      next.outbox.set(prepared.outbox!.id, prepared.outbox!);
      this.states.set(key(command.target), next);
      return structuredClone(prepared.result);
    }
    throw new BranchStateError("state_unavailable");
  }

  /** Returns the exact current head without resolving or creating missing branches. */
  async readHead(input: BranchHeadQuery): Promise<BranchStateHead> {
    return structuredClone(this.state(BranchStateQuery.head(input)).head);
  }

  private content(query: BranchContentQuery): BranchStateContent {
    const snapshot = this.state(query).snapshots.get(query.version.snapshotId);
    if (!snapshot) throw new BranchStateError("snapshot_not_found");
    if (!sameBranchStateVersion(snapshot.version, query.version))
      throw new BranchStateError("snapshot_version_mismatch");
    return snapshot;
  }

  /** Reads only the requested version, including snapshot zero and empty content. */
  async readContent(input: BranchContentQuery): Promise<BranchStateContent> {
    return structuredClone(this.content(BranchStateQuery.content(input)));
  }

  /** Discovers exact metadata and version without loading a different snapshot. */
  async readSnapshot(
    input: BranchSnapshotQuery,
  ): Promise<BranchSnapshotState | null> {
    return structuredClone(this.snapshot(BranchLifecycleQuery.snapshot(input)));
  }

  private snapshot(query: BranchSnapshotQuery): BranchSnapshotState | null {
    const state = this.state(query);
    const content = state.snapshots.get(query.snapshotId);
    const snapshot = state.snapshotMetadata.get(query.snapshotId);
    if (!content && !snapshot) {
      if (query.snapshotId <= state.head.version.snapshotId)
        throw new BranchStateError("state_corrupt");
      return null;
    }
    if (
      !content ||
      !snapshot ||
      query.snapshotId > state.head.version.snapshotId
    )
      throw new BranchStateError("state_corrupt");
    return {
      target: query.target,
      placement: query.placement,
      version: content.version,
      snapshot,
    };
  }

  /** Returns a contiguous ascending metadata page bounded by one captured exact version. */
  async listSnapshots(
    input: BranchSnapshotPageQuery,
  ): Promise<BranchSnapshotPage> {
    const query = BranchLifecycleQuery.page(input);
    this.content(query);
    const end = Math.min(
      query.version.snapshotId,
      query.afterSnapshotId + query.limit,
    );
    const snapshots: BranchSnapshotState[] = [];
    for (
      let snapshotId = query.afterSnapshotId + 1;
      snapshotId <= end;
      snapshotId++
    ) {
      const snapshot = this.snapshot({
        target: query.target,
        placement: query.placement,
        snapshotId,
      });
      if (!snapshot) throw new BranchStateError("state_corrupt");
      snapshots.push(snapshot);
    }
    return structuredClone({
      snapshots,
      nextAfterSnapshotId: end < query.version.snapshotId ? end : null,
    });
  }

  /** Returns the entire inclusive range or a corruption failure, never a partial result. */
  async readEvents(input: BranchEventRangeQuery): Promise<DropDiffEvent[]> {
    const query = BranchStateQuery.range(input);
    this.content(query);
    const state = this.state(query);
    const events: DropDiffEvent[] = [];
    for (let seq = query.startSeq; seq <= query.endSeq; seq++) {
      const event = state.events.get(seq);
      if (!event) throw new BranchStateError("state_corrupt");
      events.push(structuredClone(event));
    }
    return events;
  }

  /** Local test diagnostics only; queue delivery and outbox acknowledgement are not selected capabilities. */
  inspectOutbox(input: BranchHeadQuery): BranchCommitOutboxRecord[] {
    return structuredClone(
      [...this.state(BranchStateQuery.head(input)).outbox.values()].filter(
        (intent): intent is BranchCommitOutboxRecord =>
          intent.kind === "branch.commit.v1",
      ),
    );
  }

  /** Local batch-intent diagnostics; does not acknowledge or deliver outbox records. */
  inspectBatchOutbox(input: BranchHeadQuery): BranchBatchCommitOutboxRecord[] {
    return structuredClone(
      [...this.state(BranchStateQuery.head(input)).outbox.values()].filter(
        (intent): intent is BranchBatchCommitOutboxRecord =>
          intent.kind === "branch.batch-commit.v1",
      ),
    );
  }
}
