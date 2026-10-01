import { useCallback, useEffect, useRef, useState } from "react";
import {
  diffToDropDiffOp,
  dropDiffOpToDiff,
  type DropBranchRuntimeFact,
} from "../../../../shared/drop/diff";
import type { Diff } from "../../../../shared/nulledit/types";
import type {
  DiffChannel,
  DiffChannelPublishAck,
} from "../../../lib/diff/channel";
import { createLocalDiffChannel } from "../../../lib/diff/local-channel";
import { createRemoteDiffChannel } from "../../../lib/diff/remote-channel";
import {
  createDiffSyncSession,
  type DiffSyncCursor,
  type DiffSyncPublishOptions,
  type DiffSyncSession,
  type DiffSyncState,
} from "./session";

export type { DiffSyncState } from "./session";

type EditorDiffApi = {
  addDiffs: (diffs: Diff[]) => void;
};

/** Inputs that bind an editor lifetime to local or remote diff synchronization. */
export interface UseDiffChannelOptions {
  dropId: string | null;
  branchId?: string | null;
  accountId?: string | null;
  clientId?: string | null;
  initialHeadSeq?: number | null;
  onRestoreBranchDraft?: (content: string) => void;
  authTokenProvider?:
    ((options?: { forceRefresh?: boolean }) => Promise<string | null>) | null;
  isOffline: boolean;
  editor: EditorDiffApi | null;
  enabled?: boolean;
  onRuntimeFacts?: (facts: DropBranchRuntimeFact[]) => void;
}

const applyEventsToEditor = (
  editor: EditorDiffApi | null,
  events: Parameters<DiffSyncSession["receive"]>[0],
): void => {
  const diffs = events
    .flatMap((event) => event.ops)
    .map((operation) => dropDiffOpToDiff(operation))
    .filter((entry): entry is Diff => Boolean(entry));
  if (editor && diffs.length > 0) editor.addDiffs(diffs);
};

/** Binds one editor to its diff transport and durable remote synchronization session. */
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
  const sessionRef = useRef<DiffSyncSession | null>(null);
  const pendingPublishesRef = useRef(new Set<Promise<unknown>>());
  const cursorRef = useRef<DiffSyncCursor>({
    contentScope: null,
    eventIds: new Set<string>(),
    nextFollowsSeq: -1,
  });
  const editorRef = useRef(editor);
  const onRuntimeFactsRef = useRef(onRuntimeFacts);
  const onRestoreBranchDraftRef = useRef(onRestoreBranchDraft);
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
  onRestoreBranchDraftRef.current = onRestoreBranchDraft;
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

  useEffect(() => {
    if (!enabled || !dropId) {
      sessionRef.current?.dispose();
      sessionRef.current = null;
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

    const applyEvents = (events: Parameters<DiffSyncSession["receive"]>[0]) =>
      applyEventsToEditor(editorRef.current, events);

    const session =
      remoteBranch && branchId && clientId
        ? createDiffSyncSession({
            scope: { rootId: dropId, branchId },
            clientId,
            initialHeadSeq,
            channel,
            cursor: cursorRef.current,
            isTransportPaused: () => transportPausedRef.current,
            restoreDraft: (content) =>
              onRestoreBranchDraftRef.current?.(content),
            applyEvents,
            updateState: setSyncState,
          })
        : null;
    sessionRef.current = session;
    if (!session) {
      setSyncState({
        mode: "inactive",
        pendingCount: 0,
        message: null,
        canEdit: true,
      });
    }

    const unsubscribe = channel.subscribe((batch) => {
      if (session) {
        void session.receive(batch.events);
      } else {
        applyEvents(batch.events);
        cursorRef.current.nextFollowsSeq = batch.events.reduce(
          (latest, event) => Math.max(latest, event.seq),
          cursorRef.current.nextFollowsSeq,
        );
      }
      if (batch.facts.length > 0) onRuntimeFactsRef.current?.(batch.facts);
    });

    return () => {
      session?.dispose();
      unsubscribe();
      channel.stop();
      if (channelRef.current === channel) channelRef.current = null;
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [
    accountId,
    authTokenProvider,
    branchId,
    clientId,
    dropId,
    enabled,
    initialHeadSeq,
  ]);

  useEffect(() => {
    const channel = channelRef.current;
    if (!channel) return;
    const session = sessionRef.current;
    if (session) {
      session.syncTransport();
    } else if (transportPaused) {
      channel.stop();
    } else {
      channel.start();
    }
  }, [branchId, dropId, enabled, transportPaused]);

  const publishDiffs = useCallback(
    (
      diffs: Diff[],
      options: DiffSyncPublishOptions = {},
    ): Promise<DiffChannelPublishAck[]> => {
      const channel = channelRef.current;
      if (!channel) return Promise.resolve([]);
      const operations = diffs.map((diff) => diffToDropDiffOp(diff));
      if (!operations.length) return Promise.resolve([]);

      const session = sessionRef.current;
      if (session) return session.publish(operations, options).then(() => []);

      let trackedPublish: Promise<DiffChannelPublishAck[]>;
      trackedPublish = channel.publish(operations, options).finally(() => {
        pendingPublishesRef.current.delete(trackedPublish);
      });
      pendingPublishesRef.current.add(trackedPublish);
      void trackedPublish.catch(() => undefined);
      return trackedPublish;
    },
    [],
  );

  const flushPendingDiffs = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (session) return session.flush();

    const pendingPublishes = Array.from(pendingPublishesRef.current);
    if (!pendingPublishes.length) return;
    const results = await Promise.allSettled(pendingPublishes);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  }, []);

  return {
    publishDiffs,
    flushPendingDiffs,
    clientId: channelRef.current?.clientId ?? null,
    syncState,
    discardSyncConflict: async () => sessionRef.current?.discard(),
    takeOverEditing: async () => sessionRef.current?.takeOver(),
  };
}
