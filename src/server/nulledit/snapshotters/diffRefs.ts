import { createDropDiffRef } from "../../../../shared/drop/diff";
import type {
  NulleditNextRequest,
  NulleditNextResult,
  NulleditSnapshotContext,
  NulleditSnapshotDiffRefRecord,
  NulleditSnapshotter,
} from "../types";

const snapshotScope = (context: NulleditSnapshotContext) => ({
  rootDropId: context.rootDropId,
  branchId: context.branchId,
});

/** Creates the built-in snapshotter that persists accepted diff refs for the snapshot. */
export const createNulleditDiffRefSnapshotter = (): NulleditSnapshotter => ({
  id: "nulledit.diff-refs",
  phase: "secondary",
  snapshot: async (context) => {
    await Promise.all(
      context.acceptedEvents.map((event) => {
        const ref = createDropDiffRef({
          rootDropId: context.rootDropId,
          branchId: context.branchId,
          seq: event.seq,
          eventId: event.eventId,
          snapshotId: event.snapshotId,
        });
        const record: NulleditSnapshotDiffRefRecord = {
          version: 1,
          rootDropId: context.rootDropId,
          branchId: context.branchId,
          snapshotId: context.snapshotId,
          ref,
          sourceClientId: event.sourceClientId,
          createdAt: event.createdAt,
          metadata: event.metadata,
        };

        return context.data.put<NulleditSnapshotDiffRefRecord>(
          {
            namespace: "nulledit",
            collection: "snapshot_diff_refs",
            scope: {
              ...snapshotScope(context),
              snapshotId: context.snapshotId,
            },
            id: event.eventId,
          },
          record,
          {
            indexes: [
              { name: "eventId", value: event.eventId, mode: "exact" },
              { name: "seq", value: event.seq, mode: "range" },
              {
                name: "sourceClientId",
                value: event.sourceClientId,
                mode: "exact",
              },
              ...(event.metadata?.kind
                ? [
                    {
                      name: "kind",
                      value: event.metadata.kind,
                      mode: "exact" as const,
                    },
                  ]
                : []),
              ...(event.metadata?.labels?.length
                ? [
                    {
                      name: "labels",
                      value: event.metadata.labels,
                      mode: "exact" as const,
                    },
                  ]
                : []),
            ],
          },
        );
      }),
    );
  },
  yieldNext: (request?: NulleditNextRequest): NulleditNextResult => {
    // TODO: project compact diff-refs when useful for MCP
    return { items: [] };
  },
});
