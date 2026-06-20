/*
This hook keeps the editor bound to either a local BroadcastChannel transport or the
remote branch diff API. Switching `dropId` or branch context tears down the old channel
so incoming events are always scoped to the currently open editing target.
*/

import { useCallback, useEffect, useRef } from "react";
import {
  diffToDropDiffOp,
  dropDiffOpToDiff,
  type DropDiffEventMetadata,
  type DropDiffOp,
} from "../../../../shared/drop/diff";
import {
  createLocalDiffChannel,
  createRemoteDiffChannel,
  type DiffChannel,
} from "../../../lib/diff/diffChannel";
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
  authTokenProvider?: (() => Promise<string | null>) | null;
  isOffline: boolean;
  editor: EditorDiffApi | null;
  enabled?: boolean;
}

export function useDiffChannel({
  dropId,
  branchId,
  accountId,
  clientId,
  authTokenProvider,
  isOffline,
  editor,
  enabled = true,
}: UseDiffChannelOptions) {
  const channelRef = useRef<DiffChannel | null>(null);
  const pendingPublishesRef = useRef(new Set<Promise<void>>());
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // Start/stop channel when dropId changes
  useEffect(() => {
    if (!enabled || !dropId) {
      channelRef.current?.stop();
      channelRef.current = null;
      return;
    }

    const channel = isOffline
      ? createLocalDiffChannel({ dropId })
      : createRemoteDiffChannel({
          dropId,
          branchId,
          accountId,
          clientId: clientId ?? undefined,
          authTokenProvider,
        });

    channelRef.current = channel;

    const unsubscribe = channel.subscribe((events) => {
      const editorApi = editorRef.current;
      if (!editorApi) return;

      // Remote events can arrive batched; flatten them so the editor applies one ordered diff stream.
      const allOps = events.flatMap((event) => event.ops);
      const editorDiffs = allOps
        .map((op) => dropDiffOpToDiff(op))
        .filter((entry): entry is Diff => Boolean(entry));
      if (editorDiffs.length > 0) {
        editorApi.addDiffs(editorDiffs);
      }
    });

    channel.start();

    return () => {
      unsubscribe();
      channel.stop();
      channelRef.current = null;
    };
  }, [accountId, authTokenProvider, branchId, clientId, dropId, isOffline, enabled]);

  // Publish local diffs to channel
  const publishDiffs = useCallback(
    (diffs: Diff[], metadata?: DropDiffEventMetadata): Promise<void> => {
      const channel = channelRef.current;
      if (!channel) return Promise.resolve();

      const ops = editorDiffToDropDiffOps(diffs);
      if (ops.length > 0) {
        let trackedPublish: Promise<void>;
        trackedPublish = channel.publish(ops, { metadata }).finally(() => {
          pendingPublishesRef.current.delete(trackedPublish);
        });
        pendingPublishesRef.current.add(trackedPublish);
        void trackedPublish.catch(() => undefined);
        return trackedPublish;
      }

      return Promise.resolve();
    },
    [],
  );

  const flushPendingDiffs = useCallback(async (): Promise<void> => {
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
  };
}
