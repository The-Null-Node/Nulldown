import type { VoidDataKey, VoidDataStore } from "../../ports";
import type {
  NulleditNextRequest,
  NulleditNextResult,
  NulleditSnapshotContext,
  NulleditSnapshotter,
} from "../types";

/** Durable watermark record written by the NullMem freshness snapshotter. */
export interface NulleditNullMemFreshnessWatermark {
  /** Record schema version. */
  version: 1;
  /** Root drop id whose branch advanced. */
  rootDropId: string;
  /** Branch id that advanced. */
  branchId: string;
  /** New head snapshot id after the accepted commit. */
  headSnapshotId: number;
  /** Previous snapshot id before this commit. */
  previousSnapshotId: number | null;
  /** Timestamp of the branch advancement. */
  updatedAt: number;
  /** Number of accepted events in this commit. */
  acceptedEventCount: number;
}

/** VoidDataStore namespace for NullMem freshness watermarks. */
export const NULLMEM_FRESHNESS_WATERMARK_NAMESPACE = "nullmem" as const;

/** VoidDataStore collection for NullMem freshness watermarks. */
export const NULLMEM_FRESHNESS_WATERMARK_COLLECTION =
  "freshness_watermarks" as const;

/** Builds the VoidDataStore key for a branch freshness watermark. */
export const createNullMemFreshnessWatermarkKey = (
  rootDropId: string,
  branchId: string,
): VoidDataKey => ({
  namespace: NULLMEM_FRESHNESS_WATERMARK_NAMESPACE,
  collection: NULLMEM_FRESHNESS_WATERMARK_COLLECTION,
  scope: { rootDropId, branchId },
  id: "latest",
});

/** Persists a freshness watermark for the NullMem freshness snapshotter. */
export type NulleditNullMemFreshnessWatermarkWriter = (
  watermark: NulleditNullMemFreshnessWatermark,
  context: NulleditSnapshotContext,
) => Promise<void> | void;

/** Options for the built-in NullMem freshness watermark snapshotter. */
export interface NulleditNullMemFreshnessSnapshotterOptions {
  /** Writes the freshness watermark to the caller-chosen storage target. */
  writeWatermark: NulleditNullMemFreshnessWatermarkWriter;
}

/** Creates the built-in snapshotter that records branch freshness watermarks for NullMem. */
export const createNulleditNullMemFreshnessSnapshotter = ({
  writeWatermark,
}: NulleditNullMemFreshnessSnapshotterOptions): NulleditSnapshotter => ({
  id: "nulledit.nullmem-freshness",
  phase: "secondary",
  snapshot: async (context) => {
    if (!context.acceptedEvents.length) return;

    const watermark: NulleditNullMemFreshnessWatermark = {
      version: 1,
      rootDropId: context.rootDropId,
      branchId: context.branchId,
      headSnapshotId: context.snapshotId,
      previousSnapshotId: context.parentSnapshotId,
      updatedAt: Date.now(),
      acceptedEventCount: context.acceptedEvents.length,
    };

    await writeWatermark(watermark, context);
  },
  yieldNext: (request?: NulleditNextRequest): NulleditNextResult => {
    // freshness watermark is mostly internal; expose nothing by default
    return { items: [] };
  },
});

/** Reads the latest freshness watermark for a branch from the VoidDataStore. */
export const readNullMemFreshnessWatermark = async (
  data: VoidDataStore,
  rootDropId: string,
  branchId: string,
): Promise<NulleditNullMemFreshnessWatermark | null> =>
  data.get<NulleditNullMemFreshnessWatermark>(
    createNullMemFreshnessWatermarkKey(rootDropId, branchId),
  );
