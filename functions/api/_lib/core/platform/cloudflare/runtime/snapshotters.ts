import type { NulldownServerRuntime } from "../../../../../../../src/server/runtime";
import { createBuiltInNulleditSnapshotters } from "../../../../../../../src/server/nulledit/snapshotters/built-ins";
import { createNulleditDiffPrioritySnapshotter } from "../../../../../../../src/server/nulledit/snapshotters/diff-priority";
import {
  createNullMemFreshnessWatermarkKey,
  createNulleditNullMemFreshnessSnapshotter,
} from "../../../../../../../src/server/nulledit/snapshotters/nullmem-freshness";
import { createNulleditNullMemObserverSnapshotter } from "../../../../../../../src/server/nulledit/snapshotters/nullmem-observer";
import { createNulleditResolvedRuntimeRefsSnapshotter } from "../../../../../../../src/server/nulledit/snapshotters/runtime-refs";
import { createNulleditSnapshotterRegistry } from "../../../../../../../src/server/nulledit/registry";
import type { NulleditSnapshotter } from "../../../../../../../src/server/nulledit/types";
import type {
  NulleditNextRequest,
  NulleditNextResult,
} from "../../../../../../../src/server/nulledit/types";
import type { RuntimeDataStore } from "../../../../../../../src/server/ports";
import { listNullplugRuntimeFacts } from "../../../../nullplug/facts/repository";
import { syncResolvedPriorityFactToD1 } from "../../../../resolved/heap/service";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../storage";
import type { CloudflareBackendRuntimeBindings } from "./contracts";

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
  if (builtInSnapshottersRegistered) return;
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

/** Lists snapshotters active for one Cloudflare runtime composition. */
export const listCloudflareSnapshotters = (
  bindings: CloudflareBackendRuntimeBindings,
  data: RuntimeDataStore,
  memory: NulldownServerRuntime["memory"],
): NulleditSnapshotter[] => {
  const db = createCloudflareSqlStore(bindings.DB);
  const blobs = createCloudflareBlobStore(bindings.R2_BUCKET);
  if (db) registerBuiltInSnapshotters();

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

/** Registers a runtime-supplied snapshotter for subsequent compositions. */
export const registerCloudflareSnapshotter = (
  snapshotter: NulleditSnapshotter,
) => snapshotterRegistry.register(snapshotter);

/** Returns a compact next-step projection from a registered snapshotter. */
export const getCloudflareSnapshotterYieldNext = (
  id: string,
  request?: NulleditNextRequest,
): NulleditNextResult | Promise<NulleditNextResult> | undefined => {
  registerBuiltInSnapshotters();
  return snapshotterRegistry.yieldNext?.(id, request);
};
