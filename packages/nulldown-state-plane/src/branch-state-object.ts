/// <reference path="../branch-state-bindings.d.ts" />
import { DurableObject } from "cloudflare:workers";
import {
  SqliteBranchAuthorityControl,
  captureMigrationCertificate,
} from "../../../src/server/state-plane/authority-control";
import type {
  SourceFenceCertificate,
  SourceWritePermit,
} from "../../../src/server/state-plane/source-fence";
import type { BranchStateTarget } from "../../../shared/drop/branch-state";
import { captureLegacyMigrationSource } from "../../../src/server/state-plane/legacy-migration-source";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../../functions/api/_lib/core/platform/cloudflare/storage";
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
import { DurableObjectBranchSqlite } from "./durable-object-sqlite";
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
  BranchStateEnvironment,
  "BRANCH_STATE" | "STATE_PLANE_LOCAL_TEST"
> &
  Partial<
    Pick<
      BranchStateEnvironment,
      | "OUTBOX_ARCHIVE"
      | "OUTBOX_DB"
      | "OUTBOX_QUEUE"
      | "ENVIRONMENT"
      | "STATE_PLANE_OUTBOX_ENABLED"
      | "OUTBOX_ARCHIVE_KEY_ID"
      | "LEGACY_R2"
      | "LEGACY_D1"
    >
  > & {
    OUTBOX_ARCHIVE_KEY?: string;
  };

const OUTBOX_WAKE_STATE_KEY = "state-plane-outbox-wake-v1";
/** Internal fixed-pool branch authority; SQL survives eviction, exact-content cache does not. */
export class BranchStateObject extends DurableObject<BranchStateBindings> {
  readonly #plane: SqliteBranchCommitStatePlane;
  readonly #authority: SqliteBranchAuthorityControl;
  #wakeSerial: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: BranchStateBindings) {
    super(ctx, env);
    const sql = new DurableObjectBranchSqlite(ctx.storage);
    this.#plane = new SqliteBranchCommitStatePlane(sql);
    this.#authority = new SqliteBranchAuthorityControl(sql);
  }

  async #authorityTarget(
    target: BranchStateTarget,
  ): Promise<BranchStateTarget> {
    const query = BranchStateQuery.head({
      target,
      placement: { routingVersion: 1, generation: 0 },
    });
    await this.#placement(query);
    return query.target;
  }

  /** Reads persisted backend authority without enrolling absent branches. */
  async readAuthority(target: BranchStateTarget) {
    return branchStateRpcResult(async () =>
      this.#authority.select(await this.#authorityTarget(target)),
    );
  }

  /** Explicit private enrollment must precede the first source write; repeated calls preserve its fence. */
  async registerLegacyBranch(target: BranchStateTarget) {
    return branchStateRpcResult(async () =>
      this.#authority.register(await this.#authorityTarget(target)),
    );
  }

  /** Admits a source mutation on its exact owning shard and generation. */
  async admitSourceWriter(input: SourceWritePermit) {
    return branchStateRpcResult(async () => {
      const permit = structuredClone(input);
      await this.#authorityTarget(permit.target);
      return this.#authority.admit(permit);
    });
  }

  /** Acknowledges only caller-proved settled writes; no expiry-based reconciliation exists. */
  async completeSourceWriter(input: SourceWritePermit) {
    return branchStateRpcResult(async () => {
      const permit = structuredClone(input);
      await this.#authorityTarget(permit.target);
      this.#authority.complete(permit);
      return { completed: true as const };
    });
  }

  /** Exposes exact source drain counts to the private migration coordinator. */
  async readSourceFence(target: BranchStateTarget) {
    return branchStateRpcResult(async () =>
      this.#authority.source(await this.#authorityTarget(target)),
    );
  }

  async #migration<T>(
    input: SourceFenceCertificate,
    operation: string,
    work: (certificate: SourceFenceCertificate) => T | Promise<T>,
  ) {
    return branchStateRpcResult(async () => {
      const certificate = captureMigrationCertificate(input);
      await this.#authorityTarget(certificate.target);
      let reason = "completed";
      let outcome = "success";
      try {
        return await work(certificate);
      } catch (error) {
        outcome = "failure";
        reason =
          error instanceof BranchStateError ? error.code : "state_unavailable";
        throw error;
      } finally {
        try {
          console.info(
            JSON.stringify({
              event: "state_plane.authority",
              version: 1,
              operation,
              migrationId: certificate.migrationId,
              generation: certificate.sourceGeneration,
              outcome,
              reason,
            }),
          );
        } catch {
          /* Telemetry cannot change authority. */
        }
      }
    });
  }

  /** Closes admission before reporting whether existing writers have drained. */
  async freezeLegacyBranch(input: SourceFenceCertificate) {
    return this.#migration(input, "freeze", (certificate) =>
      this.#authority.freeze(certificate),
    );
  }

  /** Captures configured legacy storage under a continuously checked frozen source; no caller-supplied data. */
  async prepareBranchMigration(input: SourceFenceCertificate) {
    return this.#migration(input, "prepare", (certificate) =>
      this.#authority.prepare(certificate, async (assertFrozen) => {
        if (!this.env.LEGACY_R2 || !this.env.LEGACY_D1)
          throw new BranchStateError("state_unavailable");
        const sql = createCloudflareSqlStore(this.env.LEGACY_D1);
        if (!sql) throw new BranchStateError("state_unavailable");
        return captureLegacyMigrationSource({
          blobs: createCloudflareBlobStore(
            this.env.LEGACY_R2 as Parameters<
              typeof createCloudflareBlobStore
            >[0],
          ),
          sql,
          target: certificate.target,
          assertFrozen,
        });
      }),
    );
  }

  /** Imports one bounded persisted chunk; index and migration identity determine its bytes. */
  async importBranchMigrationChunk(
    input: SourceFenceCertificate,
    index: number,
  ) {
    return this.#migration(input, "import", (certificate) =>
      this.#authority.importChunk(certificate, index),
    );
  }

  /** Reads durable progress for retries and redeployment recovery. */
  async readBranchMigration(input: SourceFenceCertificate) {
    return this.#migration(input, "progress", (certificate) =>
      this.#authority.progress(certificate),
    );
  }

  /** Verifies exact content and provenance before authority transfer. */
  async verifyBranchMigration(input: SourceFenceCertificate) {
    return this.#migration(input, "verify", (certificate) =>
      this.#authority.verify(certificate),
    );
  }

  /** Commits source retirement independently of destination publication. */
  async transferBranchMigration(input: SourceFenceCertificate) {
    return this.#migration(input, "transfer", (certificate) =>
      this.#authority.transfer(certificate),
    );
  }

  /** Publishes destination records, recovering forward after an interrupted transfer. */
  async activateBranchMigration(input: SourceFenceCertificate) {
    return this.#migration(input, "activate", (certificate) =>
      this.#authority.activate(certificate),
    );
  }

  /** Reopens only pretransfer sources, with a new generation that rejects stale writers. */
  async abortBranchMigration(input: SourceFenceCertificate) {
    return this.#migration(input, "abort", (certificate) =>
      this.#authority.abort(certificate),
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
      this.#authority.assertBootstrapAllowed(command.target);
      return this.#plane.reserve(command);
    });
  }

  /** Atomically activates a reserved local branch and its immutable snapshot-zero receipt. */
  async initialize(input: BranchInitializeRecord) {
    return branchStateRpcResult(async () => {
      const command = BranchLifecycleQuery.initialize(input);
      await this.#placement(command);
      this.#authority.assertBootstrapAllowed(command.target);
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
        this.#authority.assertBootstrapAllowed(query.target);
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
