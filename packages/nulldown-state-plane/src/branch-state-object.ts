import { DurableObject } from "cloudflare:workers";
import {
  captureNullMemQuery,
  captureNullMemPut,
  captureNullMemDelete,
  type BranchNullMemQuery,
  type BranchNullMemPutCommand,
  type BranchNullMemDeleteCommand,
} from "../../../shared/drop/branch-nullmem";
import {
  BranchLifecycleQuery,
  type BranchPlacementQuery,
  type BranchReserveRecord,
  type BranchInitializeRecord,
  type BranchSnapshotQuery,
  type BranchSnapshotPageQuery,
} from "../../../shared/drop/branch-lifecycle";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchAppendRecord,
  type BranchBatchAppendRecord,
  type BranchContentQuery,
  type BranchEventRangeQuery,
  type BranchHeadQuery,
} from "../../../shared/drop/branch-state";
import { SqliteBranchCommitStatePlane } from "../../../src/server/state-plane/sqlite-commits";
import {
  synchronousSqlResult,
  type BranchSqlPort,
  type BranchSqlValue,
} from "../../../src/server/state-plane/sqlite-port";
import type { MemoryBranchStateSeed } from "../../../src/server/state-plane/memory-commits";
import type {
  BranchOutboxClaimCommand,
  BranchOutboxClaimResultCommand,
} from "../../../shared/drop/branch-outbox-delivery";
import { outboxJobRef, type OutboxReferenceMessage } from "./outbox-platform";
import {
  OUTBOX_ALARM_BATCH_SIZE,
  OUTBOX_ALARM_DRAIN_MS,
  OUTBOX_LEASE_MS,
  OUTBOX_RETRY_POLL_MS,
  normalizeOutboxWakeState,
  outboxWakeAfterEmpty,
  scheduleOutboxWake,
  type OutboxWakeState,
} from "./outbox-alarm";
import {
  captureRuntimeFactAppend,
  captureRuntimeFactPage,
  type BranchRuntimeFactAppendCommand,
  type BranchRuntimeFactPageQuery,
} from "../../../shared/drop/branch-runtime-facts";
import {
  branchStateRpcResult,
  branchStateShardName,
  type BranchStateRpcResult,
} from "./shard-router";

/** Internal binding dependency derived from Wrangler's generated configuration contract. */
export type BranchStateBindings = Pick<
  Env,
  "BRANCH_STATE" | "STATE_PLANE_LOCAL_TEST"
> &
  Partial<
    Pick<
      Env,
      | "OUTBOX_ARCHIVE"
      | "OUTBOX_DB"
      | "OUTBOX_QUEUE"
      | "ENVIRONMENT"
      | "STATE_PLANE_OUTBOX_ENABLED"
      | "OUTBOX_ARCHIVE_KEY_ID"
    >
  > & {
    OUTBOX_ARCHIVE_KEY?: string;
  };

const OUTBOX_WAKE_STATE_KEY = "state-plane-outbox-wake-v1";
/** Adapts one SQLite DO storage lifetime to the synchronous portable SQL port. */
export class DurableObjectBranchSqlite implements BranchSqlPort {
  constructor(private readonly storage: DurableObjectStorage) {}
  /** Materializes SQL rows before the owning synchronous transaction exits. */
  rows<T extends Record<string, unknown>>(
    sql: string,
    ...bindings: BranchSqlValue[]
  ): T[] {
    return this.storage.sql.exec(sql, ...bindings).toArray() as T[];
  }
  /** Executes SQL without awaiting; exceptions remain inside transactionSync. */
  execute(sql: string, ...bindings: BranchSqlValue[]): void {
    this.storage.sql.exec(sql, ...bindings);
  }
  /** Rolls back all SQL mutations if any synchronous publication step throws. */
  transaction<T>(body: () => T): T {
    return this.storage.transactionSync(() => synchronousSqlResult(body()));
  }
}

/** Internal fixed-pool branch authority; SQL survives eviction, exact-content cache does not. */
export class BranchStateObject extends DurableObject<BranchStateBindings> {
  readonly #plane: SqliteBranchCommitStatePlane;
  #wakeSerial: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: BranchStateBindings) {
    super(ctx, env);
    this.#plane = new SqliteBranchCommitStatePlane(
      new DurableObjectBranchSqlite(ctx.storage),
    );
  }

  #outboxEnabled(): boolean {
    return (
      this.env.STATE_PLANE_OUTBOX_ENABLED === "1" &&
      this.env.ENVIRONMENT === "staging" &&
      !!this.env.OUTBOX_QUEUE
    );
  }

  /** Serializes alarm metadata updates while preserving the durable state across eviction. */
  async #updateWakeState(
    update: (state: OutboxWakeState) => OutboxWakeState,
  ): Promise<OutboxWakeState> {
    const run = this.#wakeSerial.then(async () => {
      const stored = await this.ctx.storage.get<OutboxWakeState>(
        OUTBOX_WAKE_STATE_KEY,
      );
      const state = update(normalizeOutboxWakeState(stored));
      await this.ctx.storage.put(OUTBOX_WAKE_STATE_KEY, state);
      if (state.scheduledAt === null) await this.ctx.storage.deleteAlarm();
      else
        await this.ctx.storage.setAlarm(
          Math.max(Date.now() + 1, state.scheduledAt),
        );
      return state;
    });
    this.#wakeSerial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Persists a bounded wake-up without letting storage scheduling failure change a committed result. */
  async #scheduleOutboxWake(
    kind: "new" | "claim" | "retry",
    at: number,
    leaseUntil?: number,
  ): Promise<void> {
    if (!this.#outboxEnabled()) return;
    try {
      await this.#updateWakeState((state) =>
        scheduleOutboxWake(state, kind, at, leaseUntil),
      );
    } catch {
      this.#wakeEvent("retry", "schedule_failed");
    }
  }

  #wakeEvent(
    outcome: "success" | "retry",
    reason: "schedule_failed" | "claim_failed" | "queue_unavailable" | "queued",
    jobRef?: string,
  ): void {
    try {
      console.log(
        JSON.stringify({
          event: "state_plane.outbox.enqueue",
          version: 1,
          outcome,
          reason,
          ...(jobRef ? { jobRef } : {}),
        }),
      );
    } catch {
      /* best effort only */
    }
  }

  /** Runs a bounded per-shard alarm page and hands only fenced references to Queue. */
  async alarm(): Promise<void> {
    if (!this.#outboxEnabled() || !this.env.OUTBOX_QUEUE) {
      try {
        await this.#updateWakeState((state) => ({
          ...state,
          scheduledAt: null,
          retryPolling: false,
          retryPolls: 0,
          leaseUntil: 0,
        }));
      } catch {
        /* cron remains the recovery safety net */
      }
      return;
    }
    const now = Date.now();
    try {
      await this.#updateWakeState((state) => ({ ...state, scheduledAt: null }));
      const leaseId = crypto.randomUUID();
      const claim = await this.#plane.claimOutbox({
        leaseId,
        now,
        leaseMs: OUTBOX_LEASE_MS,
        limit: OUTBOX_ALARM_BATCH_SIZE,
      });
      if (claim.items.length === 0) {
        await this.#updateWakeState((state) => {
          return outboxWakeAfterEmpty(state, now);
        });
        return;
      }
      const nextWake =
        claim.items.length === OUTBOX_ALARM_BATCH_SIZE
          ? now + OUTBOX_ALARM_DRAIN_MS
          : claim.leaseUntil + 1;
      await this.#scheduleOutboxWake("claim", nextWake, claim.leaseUntil);
      for (const item of claim.items) {
        const message: OutboxReferenceMessage = {
          version: 1,
          target: item.target,
          placement: item.placement,
          item,
          leaseId: claim.leaseId,
        };
        let jobRef: string | undefined;
        try {
          jobRef = await outboxJobRef(item);
          await this.env.OUTBOX_QUEUE.send(message);
          this.#wakeEvent("success", "queued", jobRef);
        } catch {
          try {
            await this.#plane.retryOutbox({
              leaseId: claim.leaseId,
              now: Date.now(),
              items: [item],
              errorCode: "queue_send_failed",
            });
          } catch {
            /* lease alarm recovers after expiry */
          }
          await this.#scheduleOutboxWake(
            "retry",
            Date.now() + OUTBOX_RETRY_POLL_MS,
          );
          this.#wakeEvent("retry", "queue_unavailable", jobRef);
        }
      }
    } catch {
      this.#wakeEvent("retry", "claim_failed");
      await this.#scheduleOutboxWake(
        "retry",
        Date.now() + OUTBOX_RETRY_POLL_MS,
      );
    }
  }

  async #placement(query: BranchHeadQuery): Promise<void> {
    const name = await branchStateShardName({
      target: query.target,
      placement: query.placement,
    });
    if (!this.ctx.id.equals(this.env.BRANCH_STATE.idFromName(name))) {
      throw new BranchStateError("routing_placement_mismatch");
    }
  }

  /** Claims bounded due work across this shard for the private queue producer/recovery sweep. */
  async claimOutbox(command: BranchOutboxClaimCommand) {
    return branchStateRpcResult(async () => {
      const claim = await this.#plane.claimOutbox(command);
      if (claim.items.length)
        await this.#scheduleOutboxWake(
          "claim",
          claim.items.length === OUTBOX_ALARM_BATCH_SIZE
            ? Date.now() + OUTBOX_ALARM_DRAIN_MS
            : claim.leaseUntil + 1,
          claim.leaseUntil,
        );
      return claim;
    });
  }

  /** Reads exact canonical work only while the individual lease and generation remain live. */
  async readClaimedOutbox(command: BranchOutboxClaimResultCommand) {
    return branchStateRpcResult(() => this.#plane.readClaimedOutbox(command));
  }

  /** Fenced completion acknowledgement after external archive and projection verification. */
  async acknowledgeOutbox(command: BranchOutboxClaimResultCommand) {
    return branchStateRpcResult(() => this.#plane.acknowledgeOutbox(command));
  }

  /** Fenced retry transition; external failures never mutate canonical primary state. */
  async retryOutbox(
    command: BranchOutboxClaimResultCommand & { errorCode: string },
  ) {
    return branchStateRpcResult(async () => {
      const result = await this.#plane.retryOutbox(command);
      if (result.retried)
        await this.#scheduleOutboxWake(
          "retry",
          Date.now() + OUTBOX_RETRY_POLL_MS,
        );
      return result;
    });
  }

  /** Clears old completion timestamps in bounded batches while preserving canonical outbox proofs. */
  async pruneCompletedOutbox(command: { before: number; limit: number }) {
    return branchStateRpcResult(() =>
      this.#plane.pruneCompletedOutbox(command),
    );
  }

  /** Captures query filters before shard routing and reads branch-local memory plus current head atomically. */
  async queryNullMem(
    input: BranchNullMemQuery,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(async () => {
      const query = captureNullMemQuery(input);
      await this.#placement(query);
      return this.#plane.queryNullMem(query);
    });
  }

  /** Publishes one fresh mutable upsert using the authenticated actor supplied by the internal application. */
  async putNullMem(
    input: BranchNullMemPutCommand,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(async () => {
      const command = captureNullMemPut(input);
      await this.#placement(command);
      const result = await this.#plane.putNullMem(command);
      await this.#scheduleOutboxWake("new", Date.now() + 10);
      return result;
    });
  }

  /** Publishes an all-kinds deletion and revision-keyed intent in the same SQLite transaction. */
  async deleteNullMem(
    input: BranchNullMemDeleteCommand,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(async () => {
      const command = captureNullMemDelete(input);
      await this.#placement(command);
      const result = await this.#plane.deleteNullMem(command);
      await this.#scheduleOutboxWake("new", Date.now() + 10);
      return result;
    });
  }

  /** Publishes one immutable UI fact through the branch-local transaction. */
  async appendRuntimeFact(
    input: BranchRuntimeFactAppendCommand,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(async () => {
      const command = captureRuntimeFactAppend(input);
      await this.#placement(command);
      const result = await this.#plane.appendRuntimeFact(command);
      await this.#scheduleOutboxWake("new", Date.now() + 10);
      return result;
    });
  }

  /** Captures an independently sequenced fact head under shard and generation fencing. */
  async readRuntimeFactHead(input: BranchHeadQuery) {
    return branchStateRpcResult(async () => {
      const query = BranchStateQuery.head(input);
      await this.#placement(query);
      return this.#plane.readRuntimeFactHead(query);
    });
  }

  /** Reads a bounded page pinned to an exact fact-stream horizon. */
  async readRuntimeFacts(
    input: BranchRuntimeFactPageQuery,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(async () => {
      const query = captureRuntimeFactPage(input);
      await this.#placement(query);
      return this.#plane.readRuntimeFacts(query);
    });
  }

  /** Internal discovery exposes pending ownership before any branch head exists. */
  async readPlacement(input: BranchPlacementQuery) {
    return branchStateRpcResult(async () => {
      const query = BranchLifecycleQuery.placement(input);
      await this.#placement({
        ...query,
        placement: { routingVersion: 1, generation: 0 },
      });
      return this.#plane.readPlacement(query);
    });
  }

  /** Upstream-authorized reservation; this is a service-binding operation, never a public endpoint. */
  async reserve(input: BranchReserveRecord) {
    return branchStateRpcResult(async () => {
      const command = BranchLifecycleQuery.reserve(input);
      await this.#placement(command);
      return this.#plane.reserve(command);
    });
  }

  /** Atomically activates a reserved local branch and its immutable snapshot-zero receipt. */
  async initialize(input: BranchInitializeRecord) {
    return branchStateRpcResult(async () => {
      const command = BranchLifecycleQuery.initialize(input);
      await this.#placement(command);
      const result = await this.#plane.initialize(command);
      await this.#scheduleOutboxWake("new", Date.now() + 10);
      return result;
    });
  }

  /** Discovers exact snapshot metadata and version without content replay. */
  async readSnapshot(input: BranchSnapshotQuery) {
    return branchStateRpcResult(async () => {
      const query = BranchLifecycleQuery.snapshot(input);
      await this.#placement(query);
      return this.#plane.readSnapshot(query);
    });
  }

  /** Reads one bounded, captured-version history page. */
  async listSnapshots(input: BranchSnapshotPageQuery) {
    return branchStateRpcResult(async () => {
      const query = BranchLifecycleQuery.page(input);
      await this.#placement(query);
      return this.#plane.listSnapshots(query);
    });
  }

  /** Typed append RPC; receiver rejects direct stubs targeting the wrong deterministic shard. */
  async append(input: BranchAppendRecord) {
    return branchStateRpcResult(async () => {
      const command = structuredClone(input);
      await this.#placement(
        BranchStateQuery.head({
          target: command?.target,
          placement: command?.placement,
        }),
      );
      const result = await this.#plane.append(command);
      await this.#scheduleOutboxWake("new", Date.now() + 10);
      return result;
    });
  }
  /** One public envelope crosses RPC by value and commits as one SQLite transaction. */
  async appendBatch(
    input: BranchBatchAppendRecord,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(async () => {
      const command = structuredClone(input);
      await this.#placement(
        BranchStateQuery.head({
          target: command?.target,
          placement: command?.placement,
        }),
      );
      const result = await this.#plane.appendBatch(command);
      await this.#scheduleOutboxWake("new", Date.now() + 10);
      return result;
    });
  }
  /** Read-only head RPC with explicit result envelope. */
  async readHead(input: BranchHeadQuery) {
    return branchStateRpcResult(async () => {
      const query = BranchStateQuery.head(input);
      await this.#placement(query);
      return this.#plane.readHead(query);
    });
  }
  /** Read-only exact-version content RPC with durable generation checks on cache hits. */
  async readContent(input: BranchContentQuery) {
    return branchStateRpcResult(async () => {
      const query = BranchStateQuery.content(input);
      await this.#placement({
        target: query.target,
        placement: query.placement,
      });
      return this.#plane.readContent(query);
    });
  }
  /** Read-only contiguous event range RPC. */
  async readEvents(
    input: BranchEventRangeQuery,
  ): Promise<BranchStateRpcResult<unknown[]>> {
    return branchStateRpcResult(async () => {
      const query = BranchStateQuery.range(input);
      await this.#placement({
        target: query.target,
        placement: query.placement,
      });
      return this.#plane.readEvents(query);
    });
  }
  /** Fixture-only initializer; requires an explicit local-test binding and never replaces existing branches. */
  async seedLocalFixtures(input: readonly MemoryBranchStateSeed[]) {
    return branchStateRpcResult(async () => {
      if (this.env.STATE_PLANE_LOCAL_TEST !== "1")
        throw new BranchStateError("capability_unsupported");
      if (!Array.isArray(input)) throw new BranchStateError("invalid_command");
      const seeds = structuredClone(input);
      for (const seed of seeds) {
        const query = BranchStateQuery.head({
          target: {
            rootDropId: seed?.branch?.rootDropId,
            branchId: seed?.branch?.branchId,
          },
          placement: seed?.placement,
        });
        await this.#placement(query);
      }
      await this.#plane.seed(seeds);
      return { seeded: seeds.length };
    });
  }
  /** No unauthenticated HTTP state surface. Authorization remains at the existing application route boundary. */
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }
}
