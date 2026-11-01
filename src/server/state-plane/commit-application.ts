import type { DropBranchRecord } from "../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import {
  captureRuntimeFactAppend,
  hashRuntimeFactIntent,
  runtimeFactIntent,
  validateRuntimeFactEvent,
  validateRuntimeFactReceipt,
  type BranchRuntimeFactStatePlane,
} from "../../../shared/drop/branch-runtime-facts";
import {
  BranchStateError,
  BranchStateQuery,
  sameBranchStateVersion,
  type BranchBatchStatePlane,
  type BranchContentQuery,
  type BranchStateHead,
  type BranchStatePlacement,
  type BranchHeadQuery,
} from "../../../shared/drop/branch-state";
import { dispatchNulleditSnapshottersForCommit } from "../nulledit/dispatch";
import type { NulleditSnapshotter } from "../nulledit/types";
import type { RuntimeDataStore } from "../ports";
import type { BranchDiffCommands, BranchStatePlane } from "./contracts";
import type { LocalBranchLifecycle } from "./application-lifecycle";
import type { LocalBranchNullMemSelection } from "./nullmem-application";
import type {
  BranchSnapshotState,
  BranchSnapshotStatePlane,
} from "../../../shared/drop/branch-lifecycle";

/** Explicit in-process local-test authority and derived-work dependencies for an application instance. */
export interface LocalBranchApplicationSelection {
  mode: "local-test";
  commits: BranchBatchStatePlane;
  placement: BranchStatePlacement;
  /** Authorized bootstrap and durable authority discovery for unseeded local branches. */
  lifecycle?: LocalBranchLifecycle;
  /** Exact immutable snapshot metadata and bounded history discovery. */
  history?: BranchSnapshotStatePlane;
  /** Atomic immutable UI facts and their independently sequenced branch stream. */
  runtimeFacts?: BranchRuntimeFactStatePlane;
  /** Explicit branch-local memory authority and optional sensitive catalog dependency. */
  nullmem?: LocalBranchNullMemSelection;
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

const validateScope = (actual: BranchHeadQuery, expected: BranchHeadQuery) => {
  if (
    actual?.target?.rootDropId !== expected.target.rootDropId ||
    actual?.target?.branchId !== expected.target.branchId ||
    actual?.placement?.routingVersion !== expected.placement.routingVersion ||
    actual?.placement?.generation !== expected.placement.generation
  )
    throw new BranchStateError("state_corrupt");
};

/**
 * Adapts explicitly selected local commits to request-scoped application reads and appends.
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
  const capturedHeads = new Map<string, BranchStateHead>();
  const versions = new Map<string, BranchContentQuery>();
  const query = async (rootDropId: string, branchId: string) => {
    const target = { rootDropId, branchId };
    const selected = selection.lifecycle
      ? await selection.lifecycle.requireActivePlacement(target)
      : placement;
    return BranchStateQuery.head({ target, placement: selected });
  };

  const readHead = async (rootDropId: string, branchId: string) => {
    const selected = await query(rootDropId, branchId);
    const head = await commits.readHead(structuredClone(selected));
    validateScope(head, selected);
    if (
      head.branch?.rootDropId !== rootDropId ||
      head.branch?.branchId !== branchId ||
      head.branch.headSnapshotId !== head.version?.snapshotId ||
      head.branch.headEventSeq !== head.version?.eventSeq
    )
      throw new BranchStateError("state_corrupt");
    const captured = structuredClone(head);
    heads.set(head.branch, captured);
    capturedHeads.set(JSON.stringify([rootDropId, branchId]), captured);
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

  const captureSnapshot = (
    state: BranchSnapshotState,
    rootDropId: string,
    branchId: string,
  ) => {
    const { snapshot, version } = state;
    const key = snapshotKey(rootDropId, branchId, version.snapshotId);
    const existing = versions.get(key);
    if (
      state.target.rootDropId !== rootDropId ||
      state.target.branchId !== branchId ||
      snapshot.rootDropId !== rootDropId ||
      snapshot.branchId !== branchId ||
      snapshot.snapshotId !== version.snapshotId ||
      snapshot.sourceContentHash !== version.sourceContentHash ||
      (version.snapshotId === 0
        ? version.eventSeq !== -1 || snapshot.patchEndSeq != null
        : snapshot.patchEndSeq !== version.eventSeq) ||
      (existing &&
        (existing.placement.routingVersion !== state.placement.routingVersion ||
          existing.placement.generation !== state.placement.generation ||
          !sameBranchStateVersion(existing.version, version)))
    )
      throw new BranchStateError("state_corrupt");
    versions.set(
      key,
      BranchStateQuery.content({
        target: state.target,
        placement: state.placement,
        version,
      }),
    );
    return structuredClone(snapshot);
  };

  const readSnapshot = async (
    rootDropId: string,
    branchId: string,
    snapshotId: number,
  ) => {
    if (!selection.history) return unsupported();
    if (!Number.isSafeInteger(snapshotId) || snapshotId < 0)
      throw new BranchStateError("invalid_command");
    const head = capturedHeads.get(JSON.stringify([rootDropId, branchId]));
    if (head && snapshotId > head.version.snapshotId) return null;
    const selected = head
      ? BranchStateQuery.head({
          target: head.target,
          placement: head.placement,
        })
      : await query(rootDropId, branchId);
    const state = await selection.history.readSnapshot({
      ...structuredClone(selected),
      snapshotId,
    });
    if (!state) return null;
    if (
      state.version.snapshotId !== snapshotId ||
      state.placement.routingVersion !== selected.placement.routingVersion ||
      state.placement.generation !== selected.placement.generation
    )
      throw new BranchStateError("state_corrupt");
    return captureSnapshot(state, rootDropId, branchId);
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
    runtimeFacts: selection.runtimeFacts
      ? {
          async storeUiFact(request) {
            const captured = structuredClone(request);
            const command = captureRuntimeFactAppend({
              ...(await query(captured.rootDropId, captured.branchId)),
              actorAccountId: captured.actorAccountId,
              fact: captured.fact,
            });
            const result = await selection.runtimeFacts!.appendRuntimeFact(
              structuredClone(command),
            );
            validateScope(result, command);
            if (typeof result.appended !== "boolean")
              throw new BranchStateError("state_corrupt");
            validateRuntimeFactReceipt(result.receipt, command);
            const intent = runtimeFactIntent(command.fact);
            if (
              runtimeFactIntent(result.receipt.event.fact) !== intent ||
              result.receipt.payloadHash !==
                (await hashRuntimeFactIntent(intent))
            )
              throw new BranchStateError("state_corrupt");
            return {
              stored: true,
              duplicate: !result.appended,
              indexed: false,
              key: result.receipt.key,
              fact: result.receipt.event.fact,
              runtimeFact: {
                event: result.receipt.event,
                appended: result.appended,
              },
            };
          },
        }
      : undefined,
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
      resolveForActor: selection.lifecycle
        ? (...args) => selection.lifecycle!.resolveForActor(...args)
        : unsupported,
      listBranchesForRoot: unsupported,
    },
    snapshots: {
      async readContent(rootDropId, branchId, snapshotId) {
        const key = snapshotKey(rootDropId, branchId, snapshotId);
        if (!versions.has(key)) {
          if (!(await readSnapshot(rootDropId, branchId, snapshotId)))
            return null;
        }
        const captured = versions.get(key)!;
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
      readSnapshot,
      async listSnapshotsForBranch(rootDropId, branchId) {
        if (!selection.history) return unsupported();
        const head =
          capturedHeads.get(JSON.stringify([rootDropId, branchId])) ??
          (await readHead(rootDropId, branchId));
        const snapshots = [];
        let afterSnapshotId = -1;
        for (;;) {
          const page = await selection.history.listSnapshots(
            structuredClone({
              target: head.target,
              placement: head.placement,
              version: head.version,
              afterSnapshotId,
              limit: 200,
            }),
          );
          if (page.snapshots.length > 200)
            throw new BranchStateError("state_corrupt");
          for (const state of page.snapshots) {
            if (
              state.version.snapshotId !== afterSnapshotId + 1 ||
              state.version.snapshotId > head.version.snapshotId ||
              state.placement.routingVersion !==
                head.placement.routingVersion ||
              state.placement.generation !== head.placement.generation
            )
              throw new BranchStateError("state_corrupt");
            snapshots.push(captureSnapshot(state, rootDropId, branchId));
            afterSnapshotId = state.version.snapshotId;
          }
          if (page.nextAfterSnapshotId === null) {
            if (afterSnapshotId !== head.version.snapshotId)
              throw new BranchStateError("state_corrupt");
            return snapshots;
          }
          if (
            !page.snapshots.length ||
            page.nextAfterSnapshotId !== afterSnapshotId ||
            afterSnapshotId >= head.version.snapshotId
          )
            throw new BranchStateError("state_corrupt");
        }
      },
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
        factLimit,
      }) {
        if (factCursor !== undefined && !selection.runtimeFacts)
          return unsupported();
        const captured = heads.get(branch);
        const head =
          captured?.target.rootDropId === rootDropId
            ? captured
            : await readHead(rootDropId, branch.branchId);
        const headSeq = head.version.eventSeq;
        const factPage =
          factCursor === undefined
            ? null
            : await (async () => {
                const selected = BranchStateQuery.head({
                  target: head.target,
                  placement: head.placement,
                });
                const factHead =
                  await selection.runtimeFacts!.readRuntimeFactHead(
                    structuredClone(selected),
                  );
                validateScope(factHead, selected);
                if (
                  !Number.isSafeInteger(factHead.headSeq) ||
                  factHead.headSeq < -1
                )
                  throw new BranchStateError("state_corrupt");
                const factHeadSeq = factHead.headSeq;
                if (cursor === "__latest__" || factCursor === "__latest__") {
                  return {
                    facts: [],
                    nextCursor: factHeadSeq,
                    headSeq: factHeadSeq,
                  };
                }
                const parsedFactCursor = Number.parseInt(factCursor, 10);
                const afterSeq = Number.isFinite(parsedFactCursor)
                  ? Math.max(-1, parsedFactCursor)
                  : -1;
                if (afterSeq >= factHeadSeq)
                  return { facts: [], nextCursor: null, headSeq: factHeadSeq };
                const count = Number.isFinite(factLimit)
                  ? Math.max(1, Math.min(200, Math.floor(factLimit)))
                  : 200;
                const page = await selection.runtimeFacts!.readRuntimeFacts({
                  ...structuredClone(selected),
                  headSeq: factHeadSeq,
                  afterSeq,
                  limit: count,
                });
                validateScope(page, selected);
                const expectedCount = Math.min(
                  count,
                  Math.max(0, factHeadSeq - afterSeq),
                );
                if (
                  page.headSeq !== factHeadSeq ||
                  !Array.isArray(page.facts) ||
                  page.facts.length !== expectedCount ||
                  page.facts.some(
                    (event, i) =>
                      event?.seq !== afterSeq + i + 1 ||
                      event.rootDropId !== rootDropId ||
                      event.branchId !== branch.branchId,
                  ) ||
                  page.nextCursor !==
                    (expectedCount ? afterSeq + expectedCount : null)
                )
                  throw new BranchStateError("state_corrupt");
                for (const event of page.facts)
                  validateRuntimeFactEvent(event, selected);
                return page;
              })();
        const factsResponse = factPage
          ? {
              facts: factPage.facts,
              factCursor:
                factPage.nextCursor === null
                  ? null
                  : String(factPage.nextCursor),
            }
          : {};
        if (cursor === "__latest__") {
          return {
            response: {
              events: [],
              cursor: headSeq >= 0 ? String(headSeq) : null,
              ...factsResponse,
            },
            totalStored: headSeq + 1,
            totalFacts: factPage ? factPage.headSeq + 1 : undefined,
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
            ...factsResponse,
          },
          totalStored: headSeq + 1,
          totalFacts: factPage ? factPage.headSeq + 1 : undefined,
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
        ...(await query(request.branch.rootDropId, request.branch.branchId)),
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
