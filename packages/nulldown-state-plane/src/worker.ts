import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  BranchAppendRecord,
  BranchContentQuery,
  BranchEventRangeQuery,
  BranchHeadQuery,
} from "../../../shared/drop/branch-state";
import type { BranchStateBindings } from "./branch-state-object";
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
        append: async (command) => await stub.append(command),
        readHead: async (query) => await stub.readHead(query),
        readContent: async (query) => await stub.readContent(query),
        readEvents: async (query) => await stub.readEvents(query),
      };
    });
  }
  /** Publishes one event through typed internal RPC. */
  async append(command: BranchAppendRecord) {
    return branchStateRpcResult(() => this.#plane().append(command));
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
