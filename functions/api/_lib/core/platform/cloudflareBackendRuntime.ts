import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  createVoidProvider,
  type VoidProvider,
} from "../../../../../src/server/provider";
import {
  createBuiltInNulleditSnapshotters,
  createInMemoryBranchCommitBuffer,
  createNulleditDiffPrioritySnapshotter,
  createNullMemFreshnessWatermarkKey,
  createNulleditNullMemFreshnessSnapshotter,
  createNulleditNullMemObserverSnapshotter,
  createNulleditResolvedRuntimeRefsSnapshotter,
  createNulleditSnapshotterRegistry,
  flushBranchCommitBufferSnapshotters,
  type NulleditSnapshotter,
} from "../../../../../src/server/nulledit";
import type { VoidDataStore } from "../../../../../src/server/ports";
import { appendEventsToBranch } from "../../nulledit/service";
import { createNullMemService } from "../../nullmem/service";
import { listNullplugRuntimeFacts } from "../../nullplug/facts/repository";
import { syncResolvedPriorityFactToD1 } from "../../resolved/heap/service";
import { createCloudflareVoidDataStore } from "./cloudflarePorts";

/** Cloudflare bindings required to compose the server runtime. */
export interface CloudflareVoidProviderBindings {
  /** R2-compatible blob bucket for canonical branch and drop records. */
  R2_BUCKET: R2Bucket;
  /** Optional D1-compatible SQL store for queryable metadata and derived data. */
  DB?: D1Database;
}

/** Branch whose buffered derived writes should be flushed before a read. */
export interface CloudflareBufferedCommitRepairTarget {
  /** Root drop id for the queried branch. */
  rootDropId: string;
  /** Branch id whose derived state should be repaired. */
  branchId: string;
}

/** Composed Cloudflare backend runtime used by route adapters. */
export interface CloudflareBackendRuntime {
  /** Cloudflare-backed functional data store. */
  data: VoidDataStore;
  /** Branch-scoped memory facade backed by NullMem records. */
  memory: VoidProvider["memory"];
  /** Nulledit append and snapshotter operations. */
  nulledit: VoidProvider["nulledit"];
  /** App-facing provider facade, created lazily for routes that need it. */
  readonly voidProvider: VoidProvider;
  /** Flushes buffered derived writes before explicit resolved-query reads. */
  repairBufferedCommitsForQuery(
    target: CloudflareBufferedCommitRepairTarget,
  ): Promise<void>;
  /** Ask a registered snapshotter for a compact "next n" projection (if it implements yieldNext). */
  getSnapshotterYieldNext(
    id: string,
    request?: import("../../../../../src/server/nulledit/types").NulleditNextRequest,
  ): import("../../../../../src/server/nulledit/types").NulleditNextResult | Promise<import("../../../../../src/server/nulledit/types").NulleditNextResult> | undefined;
}

const branchCommitBuffer = createInMemoryBranchCommitBuffer();
const builtInSnapshotterIds = new Set([
  "nulledit.frame",
  "nulledit.diff-refs",
  "nulledit.diff-priority",
  "nulledit.nullmem-observer",
  "nulledit.nullmem-freshness",
  "nulledit.policy-observer",
  "nulledit.resolved-document",
  "nulledit.resolved-runtime-refs",
]);
const snapshotterRegistry = createNulleditSnapshotterRegistry();
let builtInSnapshottersRegistered = false;

const registerBuiltInSnapshotters = (): void => {
  if (builtInSnapshottersRegistered) {
    return;
  }

  for (const snapshotter of createBuiltInNulleditSnapshotters()) {
    snapshotterRegistry.register(snapshotter);
  }
  builtInSnapshottersRegistered = true;
};

const writeNullMemFreshnessWatermark = (
  data: VoidDataStore,
): Parameters<typeof createNulleditNullMemFreshnessSnapshotter>[0]["writeWatermark"] =>
  (watermark) =>
    data.put(
      createNullMemFreshnessWatermarkKey(
        watermark.rootDropId,
        watermark.branchId,
      ),
      watermark,
      {
        indexes: [
          { name: "rootDropId", value: watermark.rootDropId, mode: "exact" },
          { name: "branchId", value: watermark.branchId, mode: "exact" },
          {
            name: "headSnapshotId",
            value: watermark.headSnapshotId,
            mode: "range",
          },
        ],
      },
    );

const listCloudflareSnapshotters = (
  bindings: CloudflareVoidProviderBindings,
  data: VoidDataStore,
  memory: VoidProvider["memory"],
): NulleditSnapshotter[] => {
  const db = bindings.DB;
  if (db) {
    registerBuiltInSnapshotters();
  }

  const snapshotters = snapshotterRegistry.list();
  if (!db) {
    return snapshotters.filter(
      (snapshotter) => !builtInSnapshotterIds.has(snapshotter.id),
    );
  }

  return [
    ...snapshotters,
    createNulleditResolvedRuntimeRefsSnapshotter({
      loadRuntimeFacts: (context) =>
        listNullplugRuntimeFacts(
          bindings.R2_BUCKET,
          context.rootDropId,
          context.branchId,
          db,
        ),
    }),
    createNulleditDiffPrioritySnapshotter({
      writePriorityFact: (fact) => syncResolvedPriorityFactToD1(db, fact),
    }),
    createNulleditNullMemObserverSnapshotter({
      writeFact: (fact, context) =>
        memory
          .createFact({
            rootDropId: context.rootDropId,
            branchId: context.branchId,
            fact,
          })
          .then(() => undefined),
    }),
    createNulleditNullMemFreshnessSnapshotter({
      writeWatermark: writeNullMemFreshnessWatermark(data),
    }),
  ];
};

const createCloudflareNulleditRuntime = (
  bindings: CloudflareVoidProviderBindings,
  data: VoidDataStore,
  memory: VoidProvider["memory"],
): VoidProvider["nulledit"] => ({
  registerSnapshotter: (snapshotter) => snapshotterRegistry.register(snapshotter),
  yieldNext: (snapshotterId, request) => {
    registerBuiltInSnapshotters();
    return snapshotterRegistry.yieldNext?.(snapshotterId, request);
  },
  appendDiffEvents: ({ branch, events, ...options }) => {
    const registeredSnapshotters = listCloudflareSnapshotters(
      bindings,
      data,
      memory,
    );
    return appendEventsToBranch(
      bindings.R2_BUCKET,
      branch,
      events,
      {
        ...options,
        data,
        snapshotters: [
          ...registeredSnapshotters,
          ...(options.snapshotters ?? []),
        ],
        commitBuffer: bindings.DB && registeredSnapshotters.length
          ? branchCommitBuffer
          : undefined,
      },
      bindings.DB,
    );
  },
});

/** Creates the composed Cloudflare backend runtime for Pages route adapters. */
export const createCloudflareBackendRuntime = (
  bindings: CloudflareVoidProviderBindings,
): CloudflareBackendRuntime => {
  const data = createCloudflareVoidDataStore(bindings);
  const memory = createNullMemService({
    blobs: bindings.R2_BUCKET,
    sql: bindings.DB,
    data,
  });
  const nulledit = createCloudflareNulleditRuntime(bindings, data, memory);
  let voidProvider: VoidProvider | null = null;

  return {
    data,
    memory,
    nulledit,
    get voidProvider() {
      voidProvider ??= createVoidProvider({ data, nulledit, memory });
      return voidProvider;
    },
    async repairBufferedCommitsForQuery({ rootDropId, branchId }) {
      if (!bindings.DB) return;

      await flushBranchCommitBufferSnapshotters({
        commitBuffer: branchCommitBuffer,
        data,
        rootDropId,
        branchId,
        reason: "explicit-query",
        snapshotters: listCloudflareSnapshotters(bindings, data, memory),
      });
    },
    getSnapshotterYieldNext(id, request) {
      registerBuiltInSnapshotters();
      return snapshotterRegistry.yieldNext?.(id, request);
    },
  };
};
