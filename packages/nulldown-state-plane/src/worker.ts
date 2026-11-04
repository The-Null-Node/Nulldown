import { WorkerEntrypoint } from "cloudflare:workers";
import {
  captureNullMemQuery,
  captureNullMemPut,
  captureNullMemDelete,
  type BranchNullMemQuery,
  type BranchNullMemPutCommand,
  type BranchNullMemDeleteCommand,
} from "../../../shared/drop/branch-nullmem";
import type {
  BranchPlacementQuery,
  BranchReserveRecord,
  BranchInitializeRecord,
  BranchSnapshotQuery,
  BranchSnapshotPageQuery,
} from "../../../shared/drop/branch-lifecycle";
import type {
  BranchAppendRecord,
  BranchBatchAppendRecord,
  BranchContentQuery,
  BranchEventRangeQuery,
  BranchHeadQuery,
} from "../../../shared/drop/branch-state";
import type { BranchStateBindings } from "./branch-state-object";
import type { OutboxReferenceMessage } from "./outbox-platform";
import type {
  BranchStatePlacement,
  BranchStateTarget,
} from "../../../shared/drop/branch-state";
import {
  dispatchOutboxTarget,
  handleOutboxQueue,
  recoverOutbox,
} from "./outbox-runtime";
import {
  captureRuntimeFactAppend,
  captureRuntimeFactPage,
  type BranchRuntimeFactAppendCommand,
  type BranchRuntimeFactPageQuery,
} from "../../../shared/drop/branch-runtime-facts";
import {
  RpcBranchCommitStatePlane,
  branchStateRpcResult,
  type BranchStateRpcResult,
} from "./shard-router";

export { BranchStateObject } from "./branch-state-object";

/** Internal service-binding entrypoint only; local composition must explicitly select this authority. */
export class BranchStateService extends WorkerEntrypoint<BranchStateBindings> {
  #outboxEnabled(): boolean {
    return (
      this.env.STATE_PLANE_OUTBOX_ENABLED === "1" &&
      this.env.ENVIRONMENT === "staging"
    );
  }

  #scheduleDispatch(
    target: BranchStateTarget,
    placement: BranchStatePlacement,
  ): void {
    if (!this.#outboxEnabled()) return;
    const failure = () => {
      try {
        console.log(
          JSON.stringify({
            event: "state_plane.outbox.enqueue",
            version: 1,
            outcome: "retry",
            reason: "dispatch_unavailable",
          }),
        );
      } catch {
        /* best effort */
      }
    };
    try {
      this.ctx.waitUntil(
        dispatchOutboxTarget(this.env, target, placement).catch(failure),
      );
    } catch {
      failure();
    }
  }

  #plane(): RpcBranchCommitStatePlane {
    return new RpcBranchCommitStatePlane((name) => {
      const stub = this.env.BRANCH_STATE.get(
        this.env.BRANCH_STATE.idFromName(name),
      );
      return {
        queryNullMem: async (query) => await stub.queryNullMem(query),
        putNullMem: async (command) => await stub.putNullMem(command),
        deleteNullMem: async (command) => await stub.deleteNullMem(command),
        appendRuntimeFact: async (command) =>
          await stub.appendRuntimeFact(command),
        readRuntimeFactHead: async (query) =>
          await stub.readRuntimeFactHead(query),
        readRuntimeFacts: async (query) => await stub.readRuntimeFacts(query),
        readPlacement: async (query) => await stub.readPlacement(query),
        reserve: async (command) => await stub.reserve(command),
        initialize: async (command) => await stub.initialize(command),
        readSnapshot: async (query) => await stub.readSnapshot(query),
        listSnapshots: async (query) => await stub.listSnapshots(query),
        append: async (command) => await stub.append(command),
        appendBatch: async (command) => await stub.appendBatch(command),
        readHead: async (query) => await stub.readHead(query),
        readContent: async (query) => await stub.readContent(query),
        readEvents: async (query) => await stub.readEvents(query),
      };
    });
  }
  /** Reads bounded branch-local memory through the existing private service binding. */
  async queryNullMem(
    input: BranchNullMemQuery,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(() =>
      this.#plane().queryNullMem(captureNullMemQuery(input)),
    );
  }
  /** Publishes a mutable upsert; repeated calls intentionally create new revisions. */
  async putNullMem(
    input: BranchNullMemPutCommand,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(async () => {
      const command = captureNullMemPut(input);
      const result = await this.#plane().putNullMem(command);
      this.#scheduleDispatch(command.target, command.placement);
      return result;
    });
  }
  /** Deletes every branch-local kind for the requested exact ID. */
  async deleteNullMem(
    input: BranchNullMemDeleteCommand,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(async () => {
      const command = captureNullMemDelete(input);
      const result = await this.#plane().deleteNullMem(command);
      this.#scheduleDispatch(command.target, command.placement);
      return result;
    });
  }

  /** Publishes an authorized UI fact through typed service-binding RPC. */
  async appendRuntimeFact(
    input: BranchRuntimeFactAppendCommand,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(async () => {
      const command = captureRuntimeFactAppend(input);
      const result = await this.#plane().appendRuntimeFact(command);
      this.#scheduleDispatch(command.target, command.placement);
      return result;
    });
  }
  /** Captures the durable runtime-fact stream horizon. */
  async readRuntimeFactHead(query: BranchHeadQuery) {
    return branchStateRpcResult(() => this.#plane().readRuntimeFactHead(query));
  }
  /** Reads a bounded captured runtime-fact page. */
  async readRuntimeFacts(
    input: BranchRuntimeFactPageQuery,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(() =>
      this.#plane().readRuntimeFacts(captureRuntimeFactPage(input)),
    );
  }
  /** Discovers durable local ownership without creating a branch. */
  async readPlacement(query: BranchPlacementQuery) {
    return branchStateRpcResult(() => this.#plane().readPlacement(query));
  }
  /** Reserves a new branch after upstream authorization and strict legacy exclusion. */
  async reserve(command: BranchReserveRecord) {
    return branchStateRpcResult(() => this.#plane().reserve(command));
  }
  /** Activates the exact winning reservation after authorized root materialization. */
  async initialize(command: BranchInitializeRecord) {
    return branchStateRpcResult(async () => {
      const captured = structuredClone(command);
      const result = await this.#plane().initialize(captured);
      this.#scheduleDispatch(captured.target, captured.placement);
      return result;
    });
  }
  /** Reads exact historical snapshot identity and metadata. */
  async readSnapshot(query: BranchSnapshotQuery) {
    return branchStateRpcResult(() => this.#plane().readSnapshot(query));
  }
  /** Reads a bounded ascending page pinned to an exact version. */
  async listSnapshots(query: BranchSnapshotPageQuery) {
    return branchStateRpcResult(() => this.#plane().listSnapshots(query));
  }
  /** Publishes one event through typed internal RPC. */
  async append(command: BranchAppendRecord) {
    return branchStateRpcResult(async () => {
      const captured = structuredClone(command);
      const result = await this.#plane().append(captured);
      this.#scheduleDispatch(captured.target, captured.placement);
      return result;
    });
  }
  /** Publishes one whole public envelope through internal batch RPC. */
  async appendBatch(
    command: BranchBatchAppendRecord,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(async () => {
      const captured = structuredClone(command);
      const result = await this.#plane().appendBatch(captured);
      this.#scheduleDispatch(captured.target, captured.placement);
      return result;
    });
  }
  /** Reads a branch head through typed internal RPC. */
  async readHead(query: BranchHeadQuery) {
    return branchStateRpcResult(() => this.#plane().readHead(query));
  }
  /** Reads exact content through typed internal RPC. */
  async readContent(query: BranchContentQuery) {
    return branchStateRpcResult(() => this.#plane().readContent(query));
  }
  /** Reads a bounded event range through typed internal RPC. */
  async readEvents(
    query: BranchEventRangeQuery,
  ): Promise<BranchStateRpcResult<unknown[]>> {
    return branchStateRpcResult(() => this.#plane().readEvents(query));
  }
  /** This service has no public HTTP endpoints. */
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }
}

export default {
  /** Default public entrypoint is deliberately disabled. */
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
  /** Queue consumer; messages contain references only and are verified against the live shard lease. */
  async queue(
    batch: MessageBatch<OutboxReferenceMessage>,
    env: BranchStateBindings,
  ): Promise<void> {
    await handleOutboxQueue(batch, env);
  },
  /** Bounded recovery scheduler for all fixed routing-v1 shards. */
  async scheduled(
    _controller: ScheduledController,
    env: BranchStateBindings,
  ): Promise<void> {
    await recoverOutbox(env);
  },
};
