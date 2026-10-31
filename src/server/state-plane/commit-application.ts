import type { DropBranchRecord } from "../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchBatchStatePlane,
  type BranchContentQuery,
  type BranchStateHead,
  type BranchStatePlacement,
} from "../../../shared/drop/branch-state";
import { dispatchNulleditSnapshottersForCommit } from "../nulledit/dispatch";
import type { NulleditSnapshotter } from "../nulledit/types";
import type { RuntimeDataStore } from "../ports";
import type { BranchDiffCommands, BranchStatePlane } from "./contracts";

/** Explicit in-process local-test authority and derived-work dependencies for an application instance. */
export interface LocalBranchApplicationSelection {
  mode: "local-test";
  commits: BranchBatchStatePlane;
  placement: BranchStatePlacement;
  data?: RuntimeDataStore;
  snapshotters?: NulleditSnapshotter[];
}

const unsupported = async (): Promise<never> => {
  throw new BranchStateError("capability_unsupported");
};

const snapshotKey = (
  rootDropId: string,
  branchId: string,
  snapshotId: number,
): string => JSON.stringify([rootDropId, branchId, snapshotId]);

/**
 * Adapts explicitly seeded local commits to request-scoped application reads and appends.
 * Captured heads live only for this adapter; unsupported domains never fall back to legacy storage.
 */
export const createCommitApplicationStatePlane = (
  selection: LocalBranchApplicationSelection,
): BranchStatePlane & BranchDiffCommands => {
  if (selection.mode !== "local-test") {
    throw new BranchStateError("capability_unsupported");
  }
  const { commits } = selection;
  const placement = { ...selection.placement };
  const heads = new WeakMap<DropBranchRecord, BranchStateHead>();
  const versions = new Map<string, BranchContentQuery>();
  const query = (rootDropId: string, branchId: string) =>
    BranchStateQuery.head({ target: { rootDropId, branchId }, placement });

  const readHead = async (rootDropId: string, branchId: string) => {
    const head = await commits.readHead(query(rootDropId, branchId));
    const captured = structuredClone(head);
    heads.set(head.branch, captured);
    versions.set(
      snapshotKey(rootDropId, branchId, captured.version.snapshotId),
      BranchStateQuery.content({
        target: captured.target,
        placement: captured.placement,
        version: captured.version,
      }),
    );
    return head;
  };

  const readRange = async (
    head: BranchStateHead,
    startSeq: number,
    endSeq: number,
  ): Promise<DropDiffEvent[]> => {
    const range = BranchStateQuery.range({
      target: head.target,
      placement: head.placement,
      version: head.version,
      startSeq,
      endSeq,
    });
    const events = await commits.readEvents(range);
    if (
      events.length !== endSeq - startSeq + 1 ||
      events.some((event, index) => event.seq !== startSeq + index)
    ) {
      throw new BranchStateError("state_corrupt");
    }
    return events;
  };

  return {
    branches: {
      async readBranch(rootDropId, branchId) {
        try {
          return (await readHead(rootDropId, branchId)).branch;
        } catch (error) {
          if (
            error instanceof BranchStateError &&
            error.code === "branch_not_found"
          ) {
            return null;
          }
          throw error;
        }
      },
      resolveForActor: unsupported,
      listBranchesForRoot: unsupported,
    },
    snapshots: {
      async readContent(rootDropId, branchId, snapshotId) {
        const captured = versions.get(
          snapshotKey(rootDropId, branchId, snapshotId),
        );
        if (!captured) return unsupported();
        return (await commits.readContent(structuredClone(captured))).content;
      },
      async readEventsBySeqRange(rootDropId, branchId, startSeq, endSeq) {
        if (
          !Number.isSafeInteger(startSeq) ||
          !Number.isSafeInteger(endSeq) ||
          startSeq < 0 ||
          endSeq < startSeq
        ) {
          throw new BranchStateError("invalid_command");
        }
        const head = await readHead(rootDropId, branchId);
        if (endSeq > head.version.eventSeq) {
          throw new BranchStateError("invalid_command");
        }
        const events: DropDiffEvent[] = [];
        for (let start = startSeq; start <= endSeq; start += 200) {
          events.push(
            ...(await readRange(head, start, Math.min(start + 199, endSeq))),
          );
        }
        return events;
      },
      readSnapshot: unsupported,
      listSnapshotsForBranch: unsupported,
    },
    maintenance: {
      listBranchesForRootPage: unsupported,
      backfillSnapshotHeap: unsupported,
    },
    diffs: {
      async poll({
        rootDropId,
        branch,
        cursor,
        excludeClient,
        limit,
        factCursor,
      }) {
        if (factCursor !== undefined) return unsupported();
        const captured = heads.get(branch);
        const head =
          captured?.target.rootDropId === rootDropId
            ? captured
            : await readHead(rootDropId, branch.branchId);
        const headSeq = head.version.eventSeq;
        if (cursor === "__latest__") {
          return {
            response: {
              events: [],
              cursor: headSeq >= 0 ? String(headSeq) : null,
            },
            totalStored: headSeq + 1,
          };
        }
        const parsed = cursor === null ? -1 : Number.parseInt(cursor, 10);
        const after = Number.isFinite(parsed) ? Math.max(-1, parsed) : -1;
        const count = Number.isFinite(limit)
          ? Math.max(1, Math.min(200, Math.floor(limit)))
          : 200;
        const events: DropDiffEvent[] = [];
        let scanned = after;
        while (scanned < headSeq && events.length < count) {
          const chunk = await readRange(
            head,
            scanned + 1,
            Math.min(scanned + 200, headSeq),
          );
          for (const event of chunk) {
            scanned = event.seq;
            if (excludeClient && event.sourceClientId === excludeClient)
              continue;
            events.push(event);
            if (events.length === count) break;
          }
        }
        return {
          response: {
            events,
            cursor: scanned === after ? null : String(scanned),
          },
          totalStored: headSeq + 1,
        };
      },
    },
    async appendDiffEvents(request) {
      const snapshotters = [
        ...(selection.snapshotters ?? []),
        ...(request.snapshotters ?? []),
      ];
      const data = selection.data;
      if (snapshotters.length && !data) return unsupported();
      const result = await commits.appendBatch({
        ...query(request.branch.rootDropId, request.branch.branchId),
        events: request.events,
      });
      if (result.acceptedEvents.length && result.snapshot && data) {
        dispatchNulleditSnapshottersForCommit(
          {
            rootDropId: result.branch.rootDropId,
            branchId: result.branch.branchId,
            snapshotId: result.snapshot.snapshotId,
            parentSnapshotId: result.snapshot.parentSnapshotId,
            branch: result.branch,
            snapshot: result.snapshot,
            content: result.content,
            acceptedEvents: result.acceptedEvents,
            deduplicatedCount: result.deduplicatedCount,
            totalStored: result.totalStored,
          },
          {
            data,
            snapshotters,
            waitUntil: request.waitUntil,
            onSnapshotterError(error, id) {
              try {
                request.onSnapshotterError?.(error, id);
              } catch {
                // A derived-work observer cannot invalidate an accepted commit or sibling work.
              }
            },
          },
        );
      }
      return {
        branch: result.branch,
        snapshot: result.snapshot,
        content: result.content,
        acceptedEvents: result.acceptedEvents,
        acknowledgements: result.acknowledgements,
        deduplicatedCount: result.deduplicatedCount,
        totalStored: result.totalStored,
      };
    },
  };
};
