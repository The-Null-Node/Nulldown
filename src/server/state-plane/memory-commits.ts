import {
  isDropBranchRecord,
  type DropBranchRecord,
} from "../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../shared/drop/diff";
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
  type BranchCommitOutboxRecord,
  type BranchContentQuery,
  type BranchEventRangeQuery,
  type BranchHeadQuery,
  type BranchStateHead,
  type BranchStateContent,
  type BranchStatePlacement,
} from "../../../shared/drop/branch-state";

/** Explicit local fixture initialization; not an import, migration, or branch-lifecycle API. */
export interface MemoryBranchStateSeed {
  branch: DropBranchRecord;
  content: string;
  placement: BranchStatePlacement;
}

type State = {
  head: BranchStateHead;
  snapshots: Map<number, BranchStateContent>;
  events: Map<number, DropDiffEvent>;
  receipts: Map<string, BranchCommitReceipt>;
  outbox: Map<string, BranchCommitOutboxRecord>;
};

const key = (target: BranchHeadQuery["target"]): string =>
  JSON.stringify([target.rootDropId, target.branchId]);

/**
 * Deterministic in-memory reference for local contract tests, not durable authority or a production cache.
 * Each instance owns seeded branches; returned values never share mutable state with storage.
 */
export class MemoryBranchCommitStatePlane implements BranchCommitStatePlane {
  private readonly states = new Map<string, State>();

  private constructor(private readonly now: () => number) {}

  /** Captures and validates all initial empty timelines before hashing; existing history cannot be silently truncated. */
  static async create(
    seeds: readonly MemoryBranchStateSeed[],
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
    if (!state) throw new BranchStateError("branch_not_found");
    if (state.head.placement.generation !== query.placement.generation)
      throw new BranchStateError("routing_generation_mismatch");
    return state;
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
    next.receipts.set(prepared.event.eventId, prepared.receipt);
    next.outbox.set(prepared.outbox.id, prepared.outbox);
    this.states.set(key(command.target), next);
    return { status: "accepted", receipt: structuredClone(prepared.receipt) };
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
    return structuredClone([
      ...this.state(BranchStateQuery.head(input)).outbox.values(),
    ]);
  }
}
