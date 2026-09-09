/*
This hook keeps the editor bound to either a local BroadcastChannel transport or the
remote branch diff API. Switching `dropId` or branch context tears down the old channel
so incoming events are always scoped to the currently open editing target.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import {
  diffToDropDiffOp,
  dropDiffOpToDiff,
  type DropBranchRuntimeFact,
  type DropDiffOp,
} from "../../../../shared/drop/diff";
import {
  createLocalDiffChannel,
  createRemoteDiffChannel,
  type DiffChannelPublishAck,
  type DiffChannelPublishOptions,
  type DiffChannel,
} from "../../../lib/diff/diffChannel";
import {
  createDiffOutbox,
  type DiffOutbox,
  type DiffOutboxDrainResult,
} from "../../../lib/diff/diffOutbox";
import {
  acknowledgeDiffOutboxEvent,
  acquireDiffOutboxWriterLease,
  clearDiffOutboxBranchDraft,
  listDiffOutboxEvents,
  readDiffOutboxBranchDraft,
  releaseDiffOutboxWriterLease,
  renewDiffOutboxWriterLease,
  updateDiffOutboxEventStatus,
  type DiffOutboxScope,
} from "../../../lib/diff/diffOutboxStore";
import type { Diff } from "../../../../shared/nulledit/types";

type EditorDiffApi = {
  addDiffs: (diffs: Diff[]) => void;
};

const editorDiffToDropDiffOps = (diffs: Diff[]): DropDiffOp[] =>
  diffs.map((diff) => diffToDropDiffOp(diff));

export interface UseDiffChannelOptions {
  dropId: string | null;
  branchId?: string | null;
  accountId?: string | null;
  clientId?: string | null;
  /** Durable branch cursor represented by the editor's initial content. */
  initialHeadSeq?: number | null;
  /** Restores a durable unsynced branch draft after branch bootstrap. */
  onRestoreBranchDraft?: (content: string) => void;
  authTokenProvider?: ((options?: { forceRefresh?: boolean }) => Promise<string | null>) | null;
  isOffline: boolean;
  editor: EditorDiffApi | null;
  enabled?: boolean;
  onRuntimeFacts?: (facts: DropBranchRuntimeFact[]) => void;
}

export interface DiffSyncState {
  mode:
    | "inactive"
    | "offline"
    | "syncing"
    | "synced"
    | "retrying"
    | "blocked"
    | "observer";
  pendingCount: number;
  message: string | null;
  canEdit: boolean;
}

interface PublishDiffOptions extends DiffChannelPublishOptions {
  /** Current browser text persisted atomically with a remote outbox event. */
  draftContent?: string;
}

interface RemoteOutboxState {
  scope: DiffOutboxScope;
  outbox: DiffOutbox;
  ready: Promise<void>;
  drain: () => Promise<DiffOutboxDrainResult>;
  refresh: () => Promise<void>;
  isWriter: () => boolean;
  takeOver: () => Promise<void>;
  discard: () => Promise<void>;
}

const WRITER_LEASE_MS = 15_000;
const WRITER_LEASE_RENEW_MS = 5_000;

const outboxScopeKey = (scope: DiffOutboxScope): string =>
  `${scope.rootId}\u0000${scope.branchId}`;

const nextFollowsSeq = (
  headSeq: number | null | undefined,
  events: Awaited<ReturnType<typeof listDiffOutboxEvents>>,
): number => {
  let next = typeof headSeq === "number" ? headSeq : -1;
  events.forEach((record) => {
    const followsSeq = record.event.metadata?.followsSeq;
    if (typeof followsSeq === "number") {
      next = Math.max(next, followsSeq + 1);
    }
  });
  return next;
};

export function useDiffChannel({
  dropId,
  branchId,
  accountId,
  clientId,
  initialHeadSeq,
  onRestoreBranchDraft,
  authTokenProvider,
  isOffline,
  editor,
  enabled = true,
  onRuntimeFacts,
}: UseDiffChannelOptions) {
  const channelRef = useRef<DiffChannel | null>(null);
  const pendingPublishesRef = useRef(new Set<Promise<unknown>>());
  const remoteOutboxRef = useRef<RemoteOutboxState | null>(null);
  const enqueueTailRef = useRef<Promise<void>>(Promise.resolve());
  const nextFollowsSeqRef = useRef(-1);
  const localEventIdsRef = useRef(new Set<string>());
  const enqueueFailedRef = useRef(false);
  const writerRef = useRef(false);
  const editorRef = useRef(editor);
  const onRuntimeFactsRef = useRef(onRuntimeFacts);
  const [networkOnline, setNetworkOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const transportPaused = isOffline || !networkOnline;
  const transportPausedRef = useRef(transportPaused);
  const [syncState, setSyncState] = useState<DiffSyncState>({
    mode: "inactive",
    pendingCount: 0,
    message: null,
    canEdit: true,
  });
  editorRef.current = editor;
  onRuntimeFactsRef.current = onRuntimeFacts;
  transportPausedRef.current = transportPaused;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const markOnline = () => setNetworkOnline(true);
    const markOffline = () => setNetworkOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  // Start/stop channel when dropId changes
  useEffect(() => {
    if (!enabled || !dropId) {
      channelRef.current?.stop();
      channelRef.current = null;
      return;
    }

    const remoteBranch = Boolean(branchId && clientId);
    const channel = remoteBranch
      ? createRemoteDiffChannel({
           dropId,
           branchId,
           accountId,
           clientId: clientId ?? undefined,
           authTokenProvider,
            initialCursor:
              typeof initialHeadSeq === "number" ? String(initialHeadSeq) : null,
            enableRuntimeFacts: Boolean(accountId),
          })
      : createLocalDiffChannel({ dropId, clientId: clientId ?? undefined });

    channelRef.current = channel;

    let disposed = false;
    let leaseTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    if (remoteBranch && branchId && clientId) {
      const scope = { rootId: dropId, branchId };
      writerRef.current = false;
      localEventIdsRef.current.clear();
      const outbox = createDiffOutbox({
        transport: ({ event }) => {
          if (transportPausedRef.current) {
            return Promise.reject({ code: "offline" });
          }
          return channel.publishEvent(event);
        },
      });
      const refresh = async () => {
        const events = await listDiffOutboxEvents(scope);
        if (disposed) return;
        const firstBlocked = events.find((event) => event.status === "blocked");
        const firstRetry = events.find((event) => event.status === "retry");
        setSyncState({
          mode: !writerRef.current
            ? "observer"
            : firstBlocked
              ? "blocked"
              : firstRetry
                ? "retrying"
                : transportPausedRef.current
                  ? "offline"
                  : events.length > 0
                    ? "syncing"
                    : "synced",
          pendingCount: events.length,
          message: !writerRef.current
            ? "This branch is being edited in another tab."
            : firstBlocked
              ? "Remote changes require conflict recovery before local edits can sync."
              : firstRetry
                ? "Saved locally. Retrying remote sync."
                : null,
          canEdit: writerRef.current,
        });
      };
      const startLeaseRenewal = () => {
        if (leaseTimer) {
          clearInterval(leaseTimer);
        }
        leaseTimer = setInterval(() => {
          void renewDiffOutboxWriterLease({
            ...scope,
            ownerId: clientId,
            leaseDurationMs: WRITER_LEASE_MS,
          }).then((renewed) => {
            if (!renewed && !disposed) {
              writerRef.current = false;
              void refresh();
            }
          });
        }, WRITER_LEASE_RENEW_MS);
      };
      const drain = async () => {
        if (!writerRef.current) {
          await refresh();
          return {
            status: "retry" as const,
            sentCount: 0,
            retryClassification: "transport" as const,
          };
        }
        if (transportPausedRef.current) {
          await refresh();
          return {
            status: "retry" as const,
            sentCount: 0,
            retryClassification: "transport" as const,
          };
        }
        const result = await outbox.drain(scope);
        await refresh();
        if (
          (result.status === "drained" || result.status === "empty") &&
          !disposed &&
          !transportPausedRef.current
        ) {
          channel.start();
        }
        if (result.status === "retry" && !disposed && !transportPausedRef.current) {
          const retryCount = result.record?.retryCount ?? 1;
          const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(retryCount, 5));
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void drain();
          }, delayMs);
        }
        return result;
      };
      const ready = (async () => {
        const lease = await acquireDiffOutboxWriterLease({
          ...scope,
          ownerId: clientId,
          leaseDurationMs: WRITER_LEASE_MS,
        });
        writerRef.current = Boolean(lease);
        if (lease) {
          startLeaseRenewal();
        }
        const events = await listDiffOutboxEvents(scope);
        if (disposed) return;
        events.forEach((event) => localEventIdsRef.current.add(event.eventId));
        nextFollowsSeqRef.current = nextFollowsSeq(initialHeadSeq, events);
        if (writerRef.current && events.length > 0) {
          const draft = await readDiffOutboxBranchDraft(scope);
          if (!disposed && draft) {
            onRestoreBranchDraft?.(draft.content);
          }
        }
        enqueueFailedRef.current = false;
        await refresh();
        if (writerRef.current && !transportPausedRef.current) {
          await drain();
        }
      })().catch((error) => {
        if (!disposed) {
          enqueueFailedRef.current = true;
          setSyncState({
            mode: "blocked",
            pendingCount: 0,
            message:
              error instanceof Error
                ? error.message
                : "Unable to initialize durable browser storage.",
            canEdit: false,
          });
        }
      });
      const discard = async () => {
        const events = await listDiffOutboxEvents(scope);
        for (const event of events) {
          await acknowledgeDiffOutboxEvent({ ...scope, eventId: event.eventId });
        }
        await clearDiffOutboxBranchDraft(scope);
        nextFollowsSeqRef.current = typeof initialHeadSeq === "number" ? initialHeadSeq : -1;
        await refresh();
      };
      const takeOver = async () => {
        const lease = await acquireDiffOutboxWriterLease({
          ...scope,
          ownerId: clientId,
          leaseDurationMs: WRITER_LEASE_MS,
          force: true,
        });
        if (!lease) {
          throw new Error("Unable to take over this branch right now.");
        }
        writerRef.current = true;
        startLeaseRenewal();
        await refresh();
        if (!transportPausedRef.current) {
          await drain();
        }
      };
      remoteOutboxRef.current = {
        scope,
        outbox,
        ready,
        drain,
        refresh,
        isWriter: () => writerRef.current,
        takeOver,
        discard,
      };
    } else {
      remoteOutboxRef.current = null;
      setSyncState({
        mode: "inactive",
        pendingCount: 0,
        message: null,
        canEdit: true,
      });
    }

    const unsubscribe = channel.subscribe((batch) => {
      const editorApi = editorRef.current;

      const remoteOutbox = remoteOutboxRef.current;
      if (remoteOutbox && batch.events.length > 0) {
        void listDiffOutboxEvents(remoteOutbox.scope).then(async (pending) => {
          if (channelRef.current !== channel) return;
          const foreignEvents = batch.events.filter(
            (event) => !localEventIdsRef.current.has(event.eventId),
          );
          const latestSeq = batch.events.reduce(
            (latest, event) => Math.max(latest, event.seq),
            nextFollowsSeqRef.current,
          );
          nextFollowsSeqRef.current = latestSeq;
          if (foreignEvents.length === 0) {
            return;
          }
          if (pending.length === 0) {
            const editorDiffs = foreignEvents
              .flatMap((event) => event.ops)
              .map((op) => dropDiffOpToDiff(op))
              .filter((entry): entry is Diff => Boolean(entry));
            if (editorApi && editorDiffs.length > 0) {
              editorApi.addDiffs(editorDiffs);
            }
            return;
          }
          await updateDiffOutboxEventStatus({
            ...remoteOutbox.scope,
            eventId: pending[0]!.eventId,
            status: "blocked",
          });
          channel.stop();
          if (channelRef.current !== channel) return;
          setSyncState({
            mode: "blocked",
            pendingCount: pending.length,
            message:
              "Remote changes arrived while local edits were pending. Resolve the conflict before syncing.",
            canEdit: writerRef.current,
          });
        });
      } else {
        // Remote events can arrive batched; flatten them so the editor applies one ordered diff stream.
        const allOps = batch.events.flatMap((event) => event.ops);
        const editorDiffs = allOps
          .map((op) => dropDiffOpToDiff(op))
          .filter((entry): entry is Diff => Boolean(entry));
        if (editorApi && editorDiffs.length > 0) {
          editorApi.addDiffs(editorDiffs);
        }
        const latestSeq = batch.events.reduce(
          (latest, event) => Math.max(latest, event.seq),
          nextFollowsSeqRef.current,
        );
        nextFollowsSeqRef.current = latestSeq;
      }

      if (batch.facts.length > 0) {
        onRuntimeFactsRef.current?.(batch.facts);
      }
    });

    return () => {
      disposed = true;
      if (leaseTimer) {
        clearInterval(leaseTimer);
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (writerRef.current && branchId && clientId) {
        void releaseDiffOutboxWriterLease({
          rootId: dropId,
          branchId,
          ownerId: clientId,
        });
      }
      writerRef.current = false;
      unsubscribe();
      channel.stop();
      channelRef.current = null;
      remoteOutboxRef.current = null;
    };
  }, [
    accountId,
    authTokenProvider,
    branchId,
    clientId,
    dropId,
    enabled,
    initialHeadSeq,
    onRestoreBranchDraft,
  ]);

  useEffect(() => {
    const channel = channelRef.current;
    if (!channel) return;
    if (transportPaused) {
      channel.stop();
      void remoteOutboxRef.current?.refresh();
      return;
    }
    const remoteOutbox = remoteOutboxRef.current;
    if (remoteOutbox) {
      void remoteOutbox.ready.then(() => {
        if (remoteOutbox.isWriter()) {
          return remoteOutbox.drain();
        }
        channel.start();
      });
      return;
    }
    channel.start();
  }, [branchId, dropId, transportPaused]);

  // Publish local diffs to channel
  const publishDiffs = useCallback(
    (
      diffs: Diff[],
      options: PublishDiffOptions = {},
    ): Promise<DiffChannelPublishAck[]> => {
      const channel = channelRef.current;
      if (!channel) return Promise.resolve([]);

      const ops = editorDiffToDropDiffOps(diffs);
      if (ops.length > 0) {
        const remoteOutbox = remoteOutboxRef.current;
        if (remoteOutbox) {
          const operation = enqueueTailRef.current.then(async () => {
            if (!remoteOutbox.isWriter()) {
              throw new Error("This branch is open for editing in another tab.");
            }
            if (enqueueFailedRef.current) {
              throw new Error("Durable diff storage is unavailable for this branch.");
            }
            await remoteOutbox.ready;
            const branchHeadSeq = nextFollowsSeqRef.current;
            const record = await remoteOutbox.outbox.enqueue({
              ...remoteOutbox.scope,
              clientId: channel.clientId,
              branchHeadSeq,
              ops,
              metadata: options.metadata,
              eventId: options.eventId,
              createdAt: options.createdAt,
              draft: { content: options.draftContent ?? "" },
            });
            localEventIdsRef.current.add(record.eventId);
            nextFollowsSeqRef.current = branchHeadSeq + 1;
            await remoteOutbox.refresh();
            if (!transportPausedRef.current) {
              await remoteOutbox.drain();
            }
          });
          enqueueTailRef.current = operation.catch((error) => {
            enqueueFailedRef.current = true;
            setSyncState((current) => ({
              ...current,
              mode: "blocked",
              message:
                error instanceof Error
                  ? error.message
                  : "Unable to save this edit for sync.",
            }));
          });
          const publishResult = operation.then(() => []);
          void publishResult.catch(() => undefined);
          return publishResult;
        }

        let trackedPublish: Promise<DiffChannelPublishAck[]>;
        trackedPublish = channel.publish(ops, options).finally(() => {
          pendingPublishesRef.current.delete(trackedPublish);
        });
        pendingPublishesRef.current.add(trackedPublish);
        void trackedPublish.catch(() => undefined);
        return trackedPublish;
      }

      return Promise.resolve([]);
    },
    [],
  );

  const flushPendingDiffs = useCallback(async (): Promise<void> => {
    const remoteOutbox = remoteOutboxRef.current;
    if (remoteOutbox) {
      await enqueueTailRef.current;
      await remoteOutbox.ready;
      if (!remoteOutbox.isWriter()) {
        throw new Error("Take over this branch in its active editor tab before publishing.");
      }
      if (transportPausedRef.current) {
        throw new Error("Reconnect before publishing this branch.");
      }
      const result = await remoteOutbox.drain();
      if (result.status === "blocked") {
        throw new Error(
          "Resolve the branch sync conflict before publishing.",
        );
      }
      if (result.status === "retry") {
        throw new Error("Branch edits are still waiting for a confirmed receipt.");
      }
      const remaining = await listDiffOutboxEvents(remoteOutbox.scope);
      if (remaining.length > 0) {
        throw new Error("Branch edits are still waiting for a confirmed receipt.");
      }
      return;
    }

    const pendingPublishes = Array.from(pendingPublishesRef.current);
    if (!pendingPublishes.length) return;

    const results = await Promise.allSettled(pendingPublishes);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) {
      throw failed.reason;
    }
  }, []);

  return {
    publishDiffs,
    flushPendingDiffs,
    clientId: channelRef.current?.clientId ?? null,
    syncState,
    discardSyncConflict: async () => {
      const remoteOutbox = remoteOutboxRef.current;
      if (!remoteOutbox) return;
      await remoteOutbox.discard();
    },
    takeOverEditing: async () => {
      const remoteOutbox = remoteOutboxRef.current;
      if (!remoteOutbox) return;
      await remoteOutbox.takeOver();
    },
  };
}
