import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  createNulldownServerRuntime,
  type NulldownServerRuntime,
} from "../../../../../src/server/runtime";
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
import type {
  NulleditNextRequest,
  NulleditNextResult,
} from "../../../../../src/server/nulledit/types";
import type {
  BlobObjectStore,
  RuntimeDataStore,
  SqlMetadataStore,
} from "../../../../../src/server/ports";
import { appendEventsToBranch } from "../../nulledit/service";
import { createNullMemService } from "../../nullmem/service";
import { listNullplugRuntimeFacts } from "../../nullplug/facts/repository";
import { createCloudflareRuntimePolicy } from "../../nullplug/policy";
import { createCloudflareNullplugRuntime } from "../../nullplug/runtime";
import { syncResolvedPriorityFactToD1 } from "../../resolved/heap/service";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
  createCloudflareRuntimeDataStore,
} from "./cloudflare-storage-adapters";
import type { AccountAuthRequest } from "../../accounts/session/authentication";

/** Cloudflare bindings required to compose the server runtime. */
export interface CloudflareBackendRuntimeBindings {
  /** R2 bucket for canonical branch and drop records. */
  R2_BUCKET: R2Bucket;
  /** Optional D1 database for queryable metadata and derived data. */
  DB?: D1Database;
  /** Provider escrow key used by trusted built-in nullplug resolvers. */
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
  /** Remote nullplug endpoint allowlist used at registration and invocation. */
  NULLPLUG_REGISTRY_ALLOWED_HOSTS?: string;
  /** Optional fetch implementation for focused runtime tests. */
  fetchImpl?: typeof fetch;
  /** Secret used to validate account bearer sessions for nullplug reads. */
  ACCOUNT_AUTH_SECRET?: string;
  /** Optional account session lifetime configuration. */
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  /** Explicit development-only account-header opt-in. */
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
  /** Authenticated request used for separately targeted built-in root reads. */
  nullplugReadRequest?: AccountAuthRequest;
  /** Canonical caller root already authorized by the route boundary. */
  nullplugCallerRootDropId?: string;
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
  data: RuntimeDataStore;
  /** Branch-scoped memory facade backed by NullMem records. */
  memory: NulldownServerRuntime["memory"];
  /** Nulledit append and snapshotter operations. */
  nulledit: NulldownServerRuntime["nulledit"];
  /** Server-runtime-owned nullplug runtime. */
  nullplug: NulldownServerRuntime["nullplug"];
  /** Server-runtime-owned policy service. */
  policy: NulldownServerRuntime["policy"];
  /** Backend server runtime, created lazily for routes that need it. */
  readonly serverRuntime: NulldownServerRuntime;
  /** Flushes buffered derived writes before explicit resolved-query reads. */
  repairBufferedCommitsForQuery(
    target: CloudflareBufferedCommitRepairTarget,
  ): Promise<void>;
  /** Ask a registered snapshotter for a compact "next n" projection (if it implements yieldNext). */
  getSnapshotterYieldNext(
    id: string,
    request?: NulleditNextRequest,
  ): NulleditNextResult | Promise<NulleditNextResult> | undefined;
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

const resolveBlobStore = (
  store: CloudflareBackendRuntimeBindings["R2_BUCKET"],
): BlobObjectStore => createCloudflareBlobStore(store);

const resolveSqlStore = (
  store: CloudflareBackendRuntimeBindings["DB"],
): SqlMetadataStore | undefined => createCloudflareSqlStore(store);

const registerBuiltInSnapshotters = (): void => {
  if (builtInSnapshottersRegistered) {
    return;
  }

  for (const snapshotter of createBuiltInNulleditSnapshotters()) {
    snapshotterRegistry.register(snapshotter);
  }
  builtInSnapshottersRegistered = true;
};

const writeNullMemFreshnessWatermark =
  (
    data: RuntimeDataStore,
  ): Parameters<
    typeof createNulleditNullMemFreshnessSnapshotter
  >[0]["writeWatermark"] =>
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
  bindings: CloudflareBackendRuntimeBindings,
  data: RuntimeDataStore,
  memory: NulldownServerRuntime["memory"],
): NulleditSnapshotter[] => {
  const db = resolveSqlStore(bindings.DB);
  const blobs = resolveBlobStore(bindings.R2_BUCKET);
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
          blobs,
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
      writeProcedure: (procedure, context) =>
        memory
          .createProcedure({
            rootDropId: context.rootDropId,
            branchId: context.branchId,
            procedure,
          })
          .then(() => undefined),
    }),
    createNulleditNullMemFreshnessSnapshotter({
      writeWatermark: writeNullMemFreshnessWatermark(data),
    }),
  ];
};

const createCloudflareNulleditRuntime = (
  bindings: CloudflareBackendRuntimeBindings,
  data: RuntimeDataStore,
  memory: NulldownServerRuntime["memory"],
): NulldownServerRuntime["nulledit"] => {
  const blobs = resolveBlobStore(bindings.R2_BUCKET);
  const sql = resolveSqlStore(bindings.DB);

  return {
    registerSnapshotter: (snapshotter) =>
      snapshotterRegistry.register(snapshotter),
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
        blobs,
        branch,
        events,
        {
          ...options,
          data,
          snapshotters: [
            ...registeredSnapshotters,
            ...(options.snapshotters ?? []),
          ],
          commitBuffer:
            sql && registeredSnapshotters.length
              ? branchCommitBuffer
              : undefined,
        },
        sql,
      );
    },
  };
};

/** Creates the composed Cloudflare backend runtime for Pages route adapters. */
export const createCloudflareBackendRuntime = (
  bindings: CloudflareBackendRuntimeBindings,
): CloudflareBackendRuntime => {
  const data = createCloudflareRuntimeDataStore(bindings);
  const blobs = resolveBlobStore(bindings.R2_BUCKET);
  const sql = resolveSqlStore(bindings.DB);
  const memory = createNullMemService({
    blobs,
    sql,
    data,
  });
  const nulledit = createCloudflareNulleditRuntime(bindings, data, memory);
  const policy = createCloudflareRuntimePolicy({
    bindings,
    trustedPluginIds: ["nd"],
    preauthorizedCallerRootDropId: bindings.nullplugCallerRootDropId,
  });
  const nullplug = createCloudflareNullplugRuntime(bindings, policy);
  let serverRuntime: NulldownServerRuntime | null = null;

  return {
    data,
    memory,
    nulledit,
    nullplug,
    policy,
    get serverRuntime() {
      serverRuntime ??= createNulldownServerRuntime({
        data,
        nulledit,
        memory,
        nullplug,
        policy,
      });
      return serverRuntime;
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
