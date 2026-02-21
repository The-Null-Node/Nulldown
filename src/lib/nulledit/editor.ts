import useEditorStore, { type EditorState } from "../../stores/editorStore";
import Snapshotter from "./snapshotter";
import { applyDiff, computeDiffOps } from "./textDiff";
import type { Diff, SnapshotDiff, SnapshotId } from "./types";

export interface IEditor {
  state: EditorState;
  addDiff: (diff: Diff) => void;
  addDiffs: (diffs: Diff[]) => void;
  clearDiffs: () => void;
  render: () => Promise<string>;
  seedSnapshot: (content: string) => SnapshotId;
  reset: () => void;
  getSnapshotter: () => Snapshotter;
  getCurrentSnapshotId: () => SnapshotId | null;
}

const snapshotter = new Snapshotter(3);

export default function createEditor(): IEditor {
  let currentSnapshotId: SnapshotId | null = null;
  let lastRenderedSnapshotId: SnapshotId | null = null;
  let renderToken = 0;
  let renderScheduled = false;

  const setCurrentSnapshotId = (snapshotId: SnapshotId | null) => {
    currentSnapshotId = snapshotId;
    useEditorStore.getState().setCurrentSnapshotId(snapshotId);
  };

  const ensureSnapshotId = () => {
    if (currentSnapshotId && currentSnapshotId !== lastRenderedSnapshotId) {
      return currentSnapshotId;
    }
    const baseSnapshotId = lastRenderedSnapshotId ?? undefined;
    const nextId = snapshotter.requestSnapshotId(baseSnapshotId);
    setCurrentSnapshotId(nextId);
    return nextId;
  };

  const queueRender = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(async () => {
      renderScheduled = false;
      await editor.render();
    });
  };

  const addDiffs = (diffs: Diff[]) => {
    if (!diffs.length) return;
    const snapshotId = ensureSnapshotId();
    const prevText = useEditorStore.getState().textContent;
    const nextText = diffs.reduce((text, diff) => applyDiff(text, diff), prevText);
    useEditorStore.getState().setTextContent(nextText);
    snapshotter.updateSnapshot(snapshotId, { content: nextText });

    const editDiff: SnapshotDiff = {
      kind: "edit",
      createdAt: Date.now(),
      fromLength: prevText.length,
      toLength: nextText.length,
      ops: diffs,
    };
    snapshotter.appendDiff(snapshotId, editDiff);
    queueRender();
  };

  const editor: IEditor = {
    state: useEditorStore.getState(),

    addDiff: (diff: Diff) => {
      addDiffs([diff]);
    },

    addDiffs,

    clearDiffs: () => {
      const prevText = useEditorStore.getState().textContent;
      if (!prevText) {
        useEditorStore.getState().setTextContent("");
        useEditorStore.getState().setRenderedMarkdown("");
        return;
      }
      const diffs = computeDiffOps(prevText, "");
      addDiffs(diffs);
    },

    render: async () => {
      if (!currentSnapshotId) {
        return useEditorStore.getState().textContent;
      }
      const snapshotId = currentSnapshotId;
      const content = useEditorStore.getState().textContent;
      const baseSnapshot = lastRenderedSnapshotId
        ? snapshotter.get(lastRenderedSnapshotId)
        : null;
      const baseContent = baseSnapshot?.content ?? "";
      const renderDiff: SnapshotDiff = {
        kind: "render",
        createdAt: Date.now(),
        fromLength: baseContent.length,
        toLength: content.length,
        ops: computeDiffOps(baseContent, content),
      };

      const token = (renderToken += 1);
      const renderedMarkdown = await Promise.resolve(content);

      if (token !== renderToken || snapshotId !== currentSnapshotId) {
        return renderedMarkdown;
      }

      snapshotter.upsertRenderDiff(snapshotId, renderDiff);
      snapshotter.updateSnapshot(snapshotId, {
        content,
        renderedMarkdown,
        status: "rendered",
      });
      snapshotter.registerSnapshot(snapshotId);
      lastRenderedSnapshotId = snapshotId;
      useEditorStore.getState().setRenderedMarkdown(renderedMarkdown);
      return renderedMarkdown;
    },

    seedSnapshot: (content: string) => {
      const snapshotId = snapshotter.requestSnapshotId();
      snapshotter.updateSnapshot(snapshotId, {
        content,
        renderedMarkdown: content,
        status: "rendered",
      });
      snapshotter.registerSnapshot(snapshotId);
      lastRenderedSnapshotId = snapshotId;
      setCurrentSnapshotId(snapshotId);
      useEditorStore.getState().setTextContent(content);
      useEditorStore.getState().setRenderedMarkdown(content);
      return snapshotId;
    },

    reset: () => {
      snapshotter.reset();
      currentSnapshotId = null;
      lastRenderedSnapshotId = null;
      renderToken = 0;
      renderScheduled = false;
      useEditorStore.getState().setTextContent("");
      useEditorStore.getState().setRenderedMarkdown("");
      useEditorStore.getState().setCurrentSnapshotId(null);
    },

    getSnapshotter: () => snapshotter,
    getCurrentSnapshotId: () => currentSnapshotId,
  };

  return editor;
}
