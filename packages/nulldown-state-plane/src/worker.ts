import { WorkerEntrypoint } from "cloudflare:workers";
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
  #plane(): RpcBranchCommitStatePlane {
    return new RpcBranchCommitStatePlane((name) => {
      const stub = this.env.BRANCH_STATE.get(
        this.env.BRANCH_STATE.idFromName(name),
      );
      return {
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
  /** Publishes an authorized UI fact through typed service-binding RPC. */
  async appendRuntimeFact(
    input: BranchRuntimeFactAppendCommand,
  ): Promise<BranchStateRpcResult<unknown>> {
    return branchStateRpcResult(() =>
      this.#plane().appendRuntimeFact(captureRuntimeFactAppend(input)),
    );
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
    return branchStateRpcResult(() => this.#plane().initialize(command));
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
    return branchStateRpcResult(() => this.#plane().append(command));
  }
  /** Publishes one whole public envelope through internal batch RPC. */
  async appendBatch(
    command: BranchBatchAppendRecord,
  ): Promise<BranchStateRpcResult<unknown>> {
    const captured = structuredClone(command);
    return branchStateRpcResult(() => this.#plane().appendBatch(captured));
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
};
