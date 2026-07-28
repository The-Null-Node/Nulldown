/*
This is the browser-side editor runtime that bridges text diffs, snapshot history, and
progressive markdown rendering. The key invariant is that renders are always tied to a
snapshot id so stale async flushes cannot overwrite newer typing.
*/

import useEditorStore, { type EditorState } from "../../stores/editorStore";
import useDropStore from "../../stores/dropStore";
import {
  RenderCancelledError,
  renderMarkdownWithNullplugState,
  type RenderPipelineResult,
} from "../nullplug";
import { hashMarkdownSource } from "../../../shared/drop/resolved/hash";
import Snapshotter from "../../../shared/nulledit/snapshotter";
import { applyDiff, computeDiffOps } from "../../../shared/nulledit/textDiff";
import type {
  Diff,
  SnapshotDiff,
  SnapshotId,
} from "../../../shared/nulledit/types";
import type { NullplugCaller } from "../../../shared/nullplug/types";
import type { VoidNullplugRuntime } from "../../../shared/nullplug/runtime";
import type { RootRuntimePolicy } from "../../../shared/nullplug/policy";

export interface IEditor {
  state: EditorState;
  addDiff: (diff: Diff) => void;
  addDiffs: (diffs: Diff[]) => void;
  clearDiffs: () => void;
  render: () => Promise<string>;
  seedSnapshot: (content: string) => SnapshotId;
  reset: () => void;
  setRuntimeCaller: (caller: NullplugCaller | null) => void;
  setRuntimePolicy: (policy: RootRuntimePolicy | null) => void;
  getSnapshotter: () => Snapshotter;
  getCurrentSnapshotId: () => SnapshotId | null;
}

const snapshotter = new Snapshotter(3);

const uniqueStrings = (values: Iterable<string | undefined>): string[] => [
  ...new Set([...values].filter((value): value is string => Boolean(value))),
];

const collectNullplugCallIds = (result: RenderPipelineResult): string[] =>
  uniqueStrings(result.nullplugCalls.flatMap((call) => call.callIds));

/** Runtime dependencies used by the browser Nulledit editor. */
export interface CreateEditorOptions {
  /** Optional provider runtime used after trusted local nullplug resolution. */
  nullplugRuntime?: VoidNullplugRuntime;
}

export default function createEditor(
  options: CreateEditorOptions = {},
): IEditor {
  let currentSnapshotId: SnapshotId | null = null;
  let lastRenderedSnapshotId: SnapshotId | null = null;
  let renderToken = 0;
  let renderScheduled = false;
  let runtimeCaller: NullplugCaller | null = null;
  let runtimePolicy: RootRuntimePolicy | null = null;

  const setCurrentSnapshotId = (snapshotId: SnapshotId | null) => {
    currentSnapshotId = snapshotId;
    useEditorStore.getState().setCurrentSnapshotId(snapshotId);
  };

  const ensureSnapshotId = () => {
    // Reuse the current pending snapshot until it has been rendered and registered.
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
    // Batch rapid keystrokes into a single render turn without delaying the store update itself.
    queueMicrotask(async () => {
      renderScheduled = false;
      await editor.render();
    });
  };

  const addDiffs = (diffs: Diff[]) => {
    if (!diffs.length) return;
    const snapshotId = ensureSnapshotId();
    const prevText = useEditorStore.getState().textContent;
    const nextText = diffs.reduce(
      (text, diff) => applyDiff(text, diff),
      prevText,
    );

    const state = useEditorStore.getState();
    state.setTextContent(nextText);
    state.invalidateStructuredRenderState();
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
        useEditorStore.getState().clearStructuredRenderState();
        useEditorStore.getState().setRenderProgress(1);
        useEditorStore.getState().setRenderStatus("idle");
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
      const rootDropId =
        runtimeCaller?.dropId ??
        useEditorStore.getState().baseDropId ??
        undefined;
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
      const initialState = useEditorStore.getState();
      initialState.invalidateStructuredRenderState();
      initialState.setRenderStatus("rendering");
      initialState.setRenderProgress(0);

      let renderedMarkdown = content;
      let renderResult: RenderPipelineResult | null = null;

      try {
        const allowedUrls = useDropStore.getState().allowedUrls;
        const resolveDrop = useDropStore.getState().getDrop;
        renderResult = await renderMarkdownWithNullplugState(content, {
          allowedUrls,
          caller: {
            ...runtimeCaller,
            dropId: rootDropId,
            snapshotId: runtimeCaller?.branchId
              ? runtimeCaller.snapshotId
              : snapshotId,
          },
          resolveDrop,
          runtimePolicy,
          nullplugRuntime: options.nullplugRuntime,
          onFlush: (buffered, status) => {
            // Flushes are advisory; only the latest render token is allowed to touch UI state.
            if (token !== renderToken || snapshotId !== currentSnapshotId) {
              return;
            }

            const state = useEditorStore.getState();
            state.setRenderedMarkdown(buffered);
            state.setRenderProgress(status.progress);
          },
          shouldCancel: () =>
            token !== renderToken || snapshotId !== currentSnapshotId,
        });
        renderedMarkdown = renderResult.markdown;
      } catch (error) {
        if (error instanceof RenderCancelledError) {
          return useEditorStore.getState().renderedMarkdown;
        }

        if (token === renderToken && snapshotId === currentSnapshotId) {
          const state = useEditorStore.getState();
          if (state.renderFrame) {
            state.setRenderFrame({ ...state.renderFrame, status: "error" });
          }
          state.setRenderStatus("idle");
          state.setRenderProgress(1);
        }

        throw error;
      }

      if (token !== renderToken || snapshotId !== currentSnapshotId) {
        return renderedMarkdown;
      }

      if (!renderResult) {
        return renderedMarkdown;
      }

      const [sourceContentHash, renderedContentHash] = await Promise.all([
        hashMarkdownSource(content),
        hashMarkdownSource(renderedMarkdown),
      ]);

      if (token !== renderToken || snapshotId !== currentSnapshotId) {
        return renderedMarkdown;
      }

      const nullplugCallIds = collectNullplugCallIds(renderResult);

      // The render diff is recorded after the final winning render so draft packs reflect visible output.
      snapshotter.upsertRenderDiff(snapshotId, renderDiff);
      snapshotter.updateSnapshot(snapshotId, {
        content,
        renderedMarkdown,
        status: "rendered",
      });
      snapshotter.registerSnapshot(snapshotId);
      lastRenderedSnapshotId = snapshotId;
      const state = useEditorStore.getState();
      state.setRenderedMarkdown(renderedMarkdown);
      state.commitStructuredRender(
        {
          frameId: `render:${snapshotId}:${token}`,
        rootDropId,
        branchId: runtimeCaller?.branchId,
        versionId: snapshotId,
        sourceMarkdown: content,
        renderedMarkdown,
        sourceContentHash,
        renderedContentHash,
        acceptedDiffRefs: [],
        resolverRefs: [],
        nullplugCalls: renderResult.nullplugCalls,
        nullplugCallIds,
          diagnostics: renderResult.diagnostics,
          status: "final",
        },
        {
         uiPrimitives: renderResult.uiPrimitives,
         uiState: renderResult.uiState,
         mutations: renderResult.mutations,
         yields: renderResult.yields,
         diagnostics: renderResult.diagnostics,
          callIds: nullplugCallIds,
        },
      );
      state.setRenderProgress(1);
      state.setRenderStatus("idle");
      return renderedMarkdown;
    },

    seedSnapshot: (content: string) => {
      const snapshotId = snapshotter.requestSnapshotId();
      snapshotter.updateSnapshot(snapshotId, {
        content,
        renderedMarkdown: "",
        status: "pending",
      });
      setCurrentSnapshotId(snapshotId);
      useEditorStore.getState().setTextContent(content);
      useEditorStore.getState().setRenderedMarkdown("");
      useEditorStore.getState().clearStructuredRenderState();
      useEditorStore.getState().setRenderStatus("rendering");
      useEditorStore.getState().setRenderProgress(0);
      queueRender();
      return snapshotId;
    },

    reset: () => {
      snapshotter.reset();
      currentSnapshotId = null;
      lastRenderedSnapshotId = null;
      renderToken = 0;
      renderScheduled = false;
      runtimeCaller = null;
      runtimePolicy = null;
      useEditorStore.getState().clearRuntimeFacts();
      useEditorStore.getState().setTextContent("");
      useEditorStore.getState().setRenderedMarkdown("");
      useEditorStore.getState().clearStructuredRenderState();
      useEditorStore.getState().setRenderStatus("idle");
      useEditorStore.getState().setRenderProgress(1);
      useEditorStore.getState().setCurrentSnapshotId(null);
    },

    setRuntimeCaller: (caller) => {
      runtimeCaller = caller ? { ...caller } : null;
    },

    setRuntimePolicy: (policy) => {
      runtimePolicy = policy;
    },

    getSnapshotter: () => snapshotter,
    getCurrentSnapshotId: () => currentSnapshotId,
  };

  return editor;
}
