import type {
  NulleditNextRequest,
  NulleditNextResult,
  NulleditSnapshotContext,
  NulleditSnapshotFrameRecord,
  NulleditSnapshotter,
} from "../types";

const snapshotScope = (context: NulleditSnapshotContext) => ({
  rootDropId: context.rootDropId,
  branchId: context.branchId,
});

/** Creates the built-in snapshotter that persists materialized snapshot frames. */
export const createNulleditFrameSnapshotter = (): NulleditSnapshotter => ({
  id: "nulledit.frame",
  phase: "secondary",
  snapshot: async (context) => {
    const record: NulleditSnapshotFrameRecord = {
      version: 1,
      rootDropId: context.rootDropId,
      branchId: context.branchId,
      snapshotId: context.snapshotId,
      parentSnapshotId: context.parentSnapshotId,
      content: context.frame.content,
      textLength: context.snapshot.textLength,
      acceptedDiffRefs: context.acceptedDiffRefs,
      createdAt: context.snapshot.createdAt,
    };

    await context.data.put<NulleditSnapshotFrameRecord>(
      {
        namespace: "nulledit",
        collection: "snapshot_frames",
        scope: snapshotScope(context),
        id: String(context.snapshotId),
      },
      record,
      {
        indexes: [
          { name: "snapshotId", value: context.snapshotId, mode: "exact" },
          {
            name: "textLength",
            value: context.snapshot.textLength,
            mode: "range",
          },
        ],
      },
    );
  },
  yieldNext: (request?: NulleditNextRequest): NulleditNextResult => {
    // TODO: project compact frame data if useful for MCP
    return { items: [] };
  },
});
