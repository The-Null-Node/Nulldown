import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../../functions/api/_lib/core/platform/cloudflare/storage";
import { createLegacyBranchStatePlane } from "../../../src/server/state-plane/legacy";
import type {
  BranchAppendOutcome,
  BranchAppendRecord,
  BranchBatchAppendRecord,
  BranchBatchAppendResult,
  BranchBatchStatePlane,
  BranchContentQuery,
  BranchEventRangeQuery,
  BranchHeadQuery,
  BranchStateContent,
  BranchStateHead,
} from "../../../shared/drop/branch-state";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import type {
  BranchSnapshotPage,
  BranchSnapshotPageQuery,
  BranchSnapshotQuery,
  BranchSnapshotState,
} from "../../../shared/drop/branch-lifecycle";
import { queryResolvedHeap } from "../../../functions/api/_lib/resolved/heap/service";
import type { LocalBranchApplicationSelection } from "../../../src/server/state-plane/commit-application";
import {
  decodeBranchStateRpcResult,
  type BranchStateRpcResult,
} from "../src/shard-router";

interface StateService {
  append(
    command: BranchAppendRecord,
  ): Promise<BranchStateRpcResult<BranchAppendOutcome>>;
  appendBatch(
    command: BranchBatchAppendRecord,
  ): Promise<BranchStateRpcResult<BranchBatchAppendResult>>;
  readHead(
    query: BranchHeadQuery,
  ): Promise<BranchStateRpcResult<BranchStateHead>>;
  readContent(
    query: BranchContentQuery,
  ): Promise<BranchStateRpcResult<BranchStateContent>>;
  readEvents(
    query: BranchEventRangeQuery,
  ): Promise<BranchStateRpcResult<DropDiffEvent[]>>;
  readSnapshot(
    query: BranchSnapshotQuery,
  ): Promise<BranchStateRpcResult<BranchSnapshotState | null>>;
  listSnapshots(
    query: BranchSnapshotPageQuery,
  ): Promise<BranchStateRpcResult<BranchSnapshotPage>>;
}

interface Bindings {
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  BRANCH_STATE_SERVICE: StateService;
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

/** Executes both production read compositions inside workerd behind one Miniflare fetch boundary. */
export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/__benchmark")
      return new Response(null, { status: 404 });
    const arm = url.searchParams.get("arm");
    const operation = url.searchParams.get("operation");
    const target = {
      rootDropId: url.searchParams.get("root") ?? "",
      branchId: url.searchParams.get("branch") ?? "",
    };
    const legacy = createLegacyBranchStatePlane({
      blobs: createCloudflareBlobStore(env.R2_BUCKET),
      sql: createCloudflareSqlStore(env.DB),
    });
    if (arm === "legacy") {
      if (operation === "content") {
        const branch = await legacy.branches.readBranch(
          target.rootDropId,
          target.branchId,
        );
        if (!branch) return json({ error: "branch_not_found" });
        const content = await legacy.snapshots.readContent(
          target.rootDropId,
          target.branchId,
          branch.headSnapshotId,
        );
        if (content === null) return json({ error: "content_not_found" });
        return json({
          content,
          snapshotId: branch.headSnapshotId,
          eventSeq: branch.headEventSeq ?? -1,
        });
      }
      if (operation === "history") {
        const branch = await legacy.branches.readBranch(
          target.rootDropId,
          target.branchId,
        );
        if (!branch) return json({ error: "branch_not_found" });
        const endSeq = branch.headEventSeq ?? -1;
        const events =
          endSeq < 0
            ? []
            : await legacy.snapshots.readEventsBySeqRange(
                target.rootDropId,
                target.branchId,
                0,
                endSeq,
              );
        return json({
          events: events ?? [],
          snapshotId: branch.headSnapshotId,
          eventSeq: endSeq,
        });
      }
      if (operation === "resolved-query") {
        const queryUrl = new URL(request.url);
        queryUrl.searchParams.set("q", "migration");
        return queryResolvedHeap(
          {
            R2_BUCKET: createCloudflareBlobStore(env.R2_BUCKET),
            DB: createCloudflareSqlStore(env.DB),
          },
          { rootId: target.rootDropId, branchId: target.branchId },
          new Request(queryUrl, request),
          { onTiming: () => undefined },
        );
      }
    }
    if (arm === "state-plane") {
      const placement = { routingVersion: 1, generation: 0 };
      const commits: BranchBatchStatePlane = {
        append: async (command) =>
          decodeBranchStateRpcResult(
            await env.BRANCH_STATE_SERVICE.append(command),
          ),
        appendBatch: async (command) =>
          decodeBranchStateRpcResult(
            await env.BRANCH_STATE_SERVICE.appendBatch(command),
          ),
        readHead: async (query) =>
          decodeBranchStateRpcResult(
            await env.BRANCH_STATE_SERVICE.readHead(query),
          ),
        readContent: async (query) =>
          decodeBranchStateRpcResult(
            await env.BRANCH_STATE_SERVICE.readContent(query),
          ),
        readEvents: async (query) =>
          decodeBranchStateRpcResult(
            await env.BRANCH_STATE_SERVICE.readEvents(query),
          ),
      };
      const selection: LocalBranchApplicationSelection = {
        mode: "local-test",
        commits,
        placement,
        history: {
          readSnapshot: async (query) =>
            decodeBranchStateRpcResult(
              await env.BRANCH_STATE_SERVICE.readSnapshot(query),
            ),
          listSnapshots: async (query) =>
            decodeBranchStateRpcResult(
              await env.BRANCH_STATE_SERVICE.listSnapshots(query),
            ),
        },
        resolvedQuery: true,
      };
      if (operation === "resolved-query") {
        const queryUrl = new URL(request.url);
        queryUrl.searchParams.set("q", "migration");
        return queryResolvedHeap(
          {
            R2_BUCKET: createCloudflareBlobStore(env.R2_BUCKET),
            DB: createCloudflareSqlStore(env.DB),
            localBranchApplication: selection,
          },
          { rootId: target.rootDropId, branchId: target.branchId },
          new Request(queryUrl, request),
          { onTiming: () => undefined },
        );
      }
      const headResult = await env.BRANCH_STATE_SERVICE.readHead({
        target,
        placement: { routingVersion: 1, generation: 0 },
      });
      const head = decodeBranchStateRpcResult(headResult);
      if (operation === "content") {
        const result = await env.BRANCH_STATE_SERVICE.readContent({
          target,
          placement: { routingVersion: 1, generation: 0 },
          version: head.version,
        });
        const state = decodeBranchStateRpcResult(result);
        return json({
          content: state.content,
          snapshotId: state.version.snapshotId,
          eventSeq: state.version.eventSeq,
        });
      }
      if (operation === "history") {
        const endSeq = head.version.eventSeq;
        const events =
          endSeq < 0
            ? []
            : decodeBranchStateRpcResult(
                await env.BRANCH_STATE_SERVICE.readEvents({
                  target,
                  placement: { routingVersion: 1, generation: 0 },
                  version: head.version,
                  startSeq: 0,
                  endSeq,
                }),
              );
        return json({
          events,
          snapshotId: head.version.snapshotId,
          eventSeq: endSeq,
        });
      }
    }
    return new Response("Unsupported benchmark case", { status: 400 });
  },
};
