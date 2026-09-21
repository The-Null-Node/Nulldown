import type { DropDiffEvent, DropDiffOp } from "../../../../shared/drop/diff";
import type {
  DiffChannel,
  DiffChannelPublishOptions,
} from "../../../lib/diff/channel";
import {
  createDiffOutbox,
  type DiffOutbox,
  type DiffOutboxDrainResult,
} from "../../../lib/diff/outbox/service";
import type { DiffOutboxScope } from "../../../lib/diff/outbox/records";
import {
  indexedDbDiffOutboxStore,
  type DiffOutboxStore,
} from "../../../lib/diff/outbox/store";

/** User-visible state of one editor branch synchronization lifetime. */
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

/** Mutable event cursor retained while React recreates a same-snapshot session. */
export interface DiffSyncCursor {
  contentScope: string | null;
  eventIds: Set<string>;
  nextFollowsSeq: number;
}

/** Publication input accepted from the editor adapter. */
export interface DiffSyncPublishOptions extends DiffChannelPublishOptions {
  draftContent?: string;
}

/** Dependencies and callbacks for one branch-scoped synchronization session. */
export interface CreateDiffSyncSessionOptions {
  scope: DiffOutboxScope;
  clientId: string;
  initialHeadSeq?: number | null;
  channel: DiffChannel;
  cursor: DiffSyncCursor;
  store?: DiffOutboxStore;
  isTransportPaused: () => boolean;
  restoreDraft?: (content: string) => void;
  applyEvents: (events: DropDiffEvent[]) => void;
  updateState: (state: DiffSyncState) => void;
}

/** Branch-scoped non-React controller for durable editing and remote delivery. */
export interface DiffSyncSession {
  readonly ready: Promise<void>;
  publish: (
    ops: DropDiffOp[],
    options?: DiffSyncPublishOptions,
  ) => Promise<void>;
  flush: () => Promise<void>;
  receive: (events: DropDiffEvent[]) => Promise<void>;
  syncTransport: () => void;
  takeOver: () => Promise<void>;
  discard: () => Promise<void>;
  dispose: () => void;
}

const WRITER_LEASE_MS = 15_000;
const WRITER_LEASE_RENEW_MS = 5_000;

const scopeKey = (scope: DiffOutboxScope): string =>
  `${scope.rootId}\u0000${scope.branchId}`;

const nextFollowsSeq = (
  headSeq: number,
  events: Awaited<ReturnType<DiffOutboxStore["listEvents"]>>,
): number => {
  let next = headSeq;
  events.forEach((record) => {
    const followsSeq = record.event.metadata?.followsSeq;
    if (typeof followsSeq === "number") next = Math.max(next, followsSeq + 1);
  });
  return next;
};

/** Creates and starts one durable remote branch synchronization session. */
export const createDiffSyncSession = (
  options: CreateDiffSyncSessionOptions,
): DiffSyncSession => {
  const store = options.store ?? indexedDbDiffOutboxStore;
  const { channel, clientId, cursor, scope } = options;
  let disposed = false;
  let writer = false;
  let enqueueFailed = false;
  let enqueueTail = Promise.resolve();
  let leaseTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const contentScope = JSON.stringify([
    scopeKey(scope),
    options.initialHeadSeq ?? -1,
  ]);
  if (cursor.contentScope !== contentScope) {
    cursor.contentScope = contentScope;
    cursor.eventIds.clear();
    cursor.nextFollowsSeq = options.initialHeadSeq ?? -1;
  }

  const outbox: DiffOutbox = createDiffOutbox({
    store,
    transport: ({ event }) => {
      if (options.isTransportPaused())
        return Promise.reject({ code: "offline" });
      return channel.publishEvent(event);
    },
    canDrain: async (leaseScope) => {
      const held = await store.hasWriterLease({
        ...leaseScope,
        ownerId: clientId,
      });
      if (!held) writer = false;
      return held;
    },
    writerId: clientId,
  });

  const restoreDraft = async (): Promise<void> => {
    const events = await store.listEvents(scope);
    const draft = await store.readDraft(scope);
    if (disposed) return;
    if (draft && options.restoreDraft) {
      options.restoreDraft(draft.content);
      events.forEach((record) => cursor.eventIds.add(record.eventId));
    }
    cursor.nextFollowsSeq = nextFollowsSeq(cursor.nextFollowsSeq, events);
  };

  const refresh = async (): Promise<void> => {
    const events = await store.listEvents(scope);
    if (disposed) return;
    const firstBlocked = events.find((event) => event.status === "blocked");
    const firstRetry = events.find((event) => event.status === "retry");
    options.updateState({
      mode: !writer
        ? "observer"
        : firstBlocked
          ? "blocked"
          : firstRetry
            ? "retrying"
            : options.isTransportPaused()
              ? "offline"
              : events.length > 0
                ? "syncing"
                : "synced",
      pendingCount: events.length,
      message: !writer
        ? "This branch is being edited in another tab."
        : firstBlocked
          ? "Remote changes require conflict recovery before local edits can sync."
          : firstRetry
            ? "Saved locally. Retrying remote sync."
            : null,
      canEdit: writer,
    });
  };

  const startLeaseRenewal = (): void => {
    if (leaseTimer) clearInterval(leaseTimer);
    leaseTimer = setInterval(() => {
      void store
        .renewWriterLease({
          ...scope,
          ownerId: clientId,
          leaseDurationMs: WRITER_LEASE_MS,
        })
        .then((renewed) => {
          if (disposed) return;
          if (!renewed) {
            writer = false;
            void refresh();
          }
        });
    }, WRITER_LEASE_RENEW_MS);
  };

  const drain = async (): Promise<DiffOutboxDrainResult> => {
    if (!writer || options.isTransportPaused()) {
      await refresh();
      return {
        status: "retry",
        sentCount: 0,
        retryClassification: "transport",
      };
    }
    const result = await outbox.drain(scope);
    await refresh();
    if (
      (result.status === "drained" || result.status === "empty") &&
      !disposed &&
      !options.isTransportPaused()
    ) {
      channel.start();
    }
    if (
      result.status === "retry" &&
      !disposed &&
      !options.isTransportPaused()
    ) {
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
    const lease = await store.acquireWriterLease({
      ...scope,
      ownerId: clientId,
      leaseDurationMs: WRITER_LEASE_MS,
    });
    if (disposed) {
      if (lease)
        await store.releaseWriterLease({ ...scope, ownerId: clientId });
      return;
    }
    writer = Boolean(lease);
    if (lease) startLeaseRenewal();
    const events = await store.listEvents(scope);
    if (disposed) return;
    cursor.nextFollowsSeq = nextFollowsSeq(cursor.nextFollowsSeq, events);
    if (writer && events.length > 0) await restoreDraft();
    enqueueFailed = false;
    await refresh();
    if (writer && !options.isTransportPaused()) await drain();
  })().catch((error) => {
    if (disposed) return;
    enqueueFailed = true;
    options.updateState({
      mode: "blocked",
      pendingCount: 0,
      message:
        error instanceof Error
          ? error.message
          : "Unable to initialize durable browser storage.",
      canEdit: false,
    });
  });

  const publish = (
    ops: DropDiffOp[],
    publishOptions: DiffSyncPublishOptions = {},
  ): Promise<void> => {
    const persisted = enqueueTail.then(async () => {
      if (disposed)
        throw new Error(
          "Branch editing context changed before this edit was saved.",
        );
      if (!writer)
        throw new Error("This branch is open for editing in another tab.");
      if (enqueueFailed)
        throw new Error("Durable diff storage is unavailable for this branch.");
      await ready;
      if (disposed)
        throw new Error(
          "Branch editing context changed before this edit was saved.",
        );
      const branchHeadSeq = cursor.nextFollowsSeq;
      const record = await outbox.enqueue({
        ...scope,
        clientId: channel.clientId,
        ownerId: channel.clientId,
        branchHeadSeq,
        ops,
        metadata: publishOptions.metadata,
        eventId: publishOptions.eventId,
        createdAt: publishOptions.createdAt,
        draft: { content: publishOptions.draftContent ?? "" },
      });
      if (disposed)
        throw new Error(
          "Branch editing context changed before this edit was saved.",
        );
      cursor.eventIds.add(record.eventId);
      cursor.nextFollowsSeq = branchHeadSeq + 1;
      await refresh();
    });
    enqueueTail = persisted.catch((error) => {
      if (disposed) return;
      enqueueFailed = true;
      writer = false;
      channel.stop();
      options.updateState({
        mode: "blocked",
        pendingCount: 0,
        message:
          error instanceof Error
            ? error.message
            : "Unable to save this edit for sync.",
        canEdit: false,
      });
    });
    void persisted
      .then(async () => {
        if (!disposed && !options.isTransportPaused()) await drain();
      })
      .catch(() => undefined);
    return persisted;
  };

  const flush = async (): Promise<void> => {
    try {
      await enqueueTail;
    } catch {
      // The durable failure is surfaced below with a stable publishing message.
    }
    if (enqueueFailed)
      throw new Error("Durable diff storage is unavailable for this branch.");
    await ready;
    if (!writer) {
      throw new Error(
        "Take over this branch in its active editor tab before publishing.",
      );
    }
    if (options.isTransportPaused()) {
      throw new Error("Reconnect before publishing this branch.");
    }
    const result = await drain();
    if (result.status === "blocked") {
      throw new Error("Resolve the branch sync conflict before publishing.");
    }
    if (result.status === "retry") {
      throw new Error(
        "Branch edits are still waiting for a confirmed receipt.",
      );
    }
    if ((await store.listEvents(scope)).length > 0) {
      throw new Error(
        "Branch edits are still waiting for a confirmed receipt.",
      );
    }
  };

  const receive = async (events: DropDiffEvent[]): Promise<void> => {
    if (!events.length || disposed) return;
    const pending = await store.listEvents(scope);
    if (disposed) return;
    const foreignEvents = events.filter(
      (event) =>
        event.sourceClientId !== clientId &&
        !cursor.eventIds.has(event.eventId),
    );
    if (!foreignEvents.length) return;
    if (!writer || pending.length === 0) {
      options.applyEvents(foreignEvents);
      cursor.nextFollowsSeq = foreignEvents.reduce(
        (latest, event) => Math.max(latest, event.seq),
        cursor.nextFollowsSeq,
      );
      return;
    }
    const blocked = await store.blockEventForWriter({
      ...scope,
      eventId: pending[0]!.eventId,
      ownerId: clientId,
    });
    if (!blocked) {
      writer = false;
      await refresh();
      return;
    }
    channel.stop();
    if (disposed) return;
    options.updateState({
      mode: "blocked",
      pendingCount: pending.length,
      message:
        "Remote changes arrived while local edits were pending. Resolve the conflict before syncing.",
      canEdit: writer,
    });
  };

  const takeOver = async (): Promise<void> => {
    const lease = await store.acquireWriterLease({
      ...scope,
      ownerId: clientId,
      leaseDurationMs: WRITER_LEASE_MS,
      force: true,
    });
    if (!lease) throw new Error("Unable to take over this branch right now.");
    writer = true;
    startLeaseRenewal();
    await restoreDraft();
    await refresh();
    if (!options.isTransportPaused()) await drain();
  };

  const discard = async (): Promise<void> => {
    const discarded = await store.discardForWriter({
      ...scope,
      ownerId: clientId,
    });
    if (!discarded) {
      writer = false;
      await refresh();
      throw new Error("This branch is being edited in another tab.");
    }
    cursor.nextFollowsSeq = options.initialHeadSeq ?? -1;
    cursor.eventIds.clear();
    await refresh();
  };

  const syncTransport = (): void => {
    if (options.isTransportPaused()) {
      channel.stop();
      void refresh();
      return;
    }
    void ready.then(() => {
      if (writer) return drain();
      channel.start();
    });
  };

  const dispose = (): void => {
    disposed = true;
    if (leaseTimer) clearInterval(leaseTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (writer) void store.releaseWriterLease({ ...scope, ownerId: clientId });
    writer = false;
  };

  return {
    ready,
    publish,
    flush,
    receive,
    syncTransport,
    takeOver,
    discard,
    dispose,
  };
};
