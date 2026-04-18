import { useCallback, useEffect, useRef } from "react";
import type { DropDiffOp } from "../../../../shared/drop/diff";
import {
  createLocalDiffChannel,
  createRemoteDiffChannel,
  type DiffChannel,
} from "../../../lib/diff/diffChannel";
import { DiffOp, type Diff } from "../../../lib/nulledit/types";
import { encodeText } from "../../../lib/nulledit/textDiff";

type EditorDiffApi = {
  addDiffs: (diffs: Diff[]) => void;
};

const dropDiffOpToEditorDiff = (op: DropDiffOp): Diff => {
  if (op.type === "insert") {
    return {
      op: DiffOp.INSERT,
      data: encodeText(op.text),
      range: { start: op.start, end: op.end },
    };
  }

  return {
    op: DiffOp.DELETE,
    data: encodeText(op.text),
    range: { start: op.start, end: op.end },
  };
};

const editorDiffToDropDiffOps = (diffs: Diff[]): DropDiffOp[] =>
  diffs
    .filter((d) => d.op === DiffOp.INSERT || d.op === DiffOp.DELETE)
    .map((d) => {
      const range = d.range ?? { start: 0, end: 0 };
      const decoder = new TextDecoder();
      return {
        type: d.op === DiffOp.INSERT ? ("insert" as const) : ("delete" as const),
        start: range.start,
        end: range.end,
        text: decoder.decode(d.data),
      };
    });

export interface UseDiffChannelOptions {
  dropId: string | null;
  isOffline: boolean;
  editor: EditorDiffApi | null;
  enabled?: boolean;
}

export function useDiffChannel({
  dropId,
  isOffline,
  editor,
  enabled = true,
}: UseDiffChannelOptions) {
  const channelRef = useRef<DiffChannel | null>(null);
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
      : createRemoteDiffChannel({ dropId });

    channelRef.current = channel;

    const unsubscribe = channel.subscribe((events) => {
      const editorApi = editorRef.current;
      if (!editorApi) return;

      const allOps = events.flatMap((event) => event.ops);
      const editorDiffs = allOps.map(dropDiffOpToEditorDiff);
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
  }, [dropId, isOffline, enabled]);

  // Publish local diffs to channel
  const publishDiffs = useCallback(
    (diffs: Diff[]) => {
      const channel = channelRef.current;
      if (!channel) return;

      const ops = editorDiffToDropDiffOps(diffs);
      if (ops.length > 0) {
        void channel.publish(ops);
      }
    },
    [],
  );

  return {
    publishDiffs,
    clientId: channelRef.current?.clientId ?? null,
  };
}
