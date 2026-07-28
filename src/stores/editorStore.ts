import { create, StateCreator } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  DropRuntimeNullplugRenderState,
  DropRuntimeRenderFrame,
} from "../../shared/drop/runtime";
import type { DropBranchRuntimeFact } from "../../shared/drop/diff";
import { applyBranchRuntimeFacts } from "../lib/nullplug/reactRuntime";

export enum EditorMode {
  Preview,
  Edit,
}

/** Structured nullplug runtime state produced by the latest winning render. */
export type EditorNullplugRenderState = DropRuntimeNullplugRenderState;

/** Render-frame provenance for the latest winning editor render. */
export type EditorRenderFrame = DropRuntimeRenderFrame;

const createEmptyNullplugRenderState = (): EditorNullplugRenderState => ({
  uiPrimitives: [],
  uiState: {},
  mutations: [],
  yields: [],
  diagnostics: [],
  callIds: [],
});

export interface EditorState {
  textContent: string;
  setTextContent: (newContent: string) => void;
  clearTextContent: () => void;
  renderedMarkdown: string;
  setRenderedMarkdown: (markdown: string) => void;
  renderStatus: "idle" | "rendering";
  setRenderStatus: (status: "idle" | "rendering") => void;
  renderProgress: number;
  setRenderProgress: (progress: number) => void;
  renderFrame: EditorRenderFrame | null;
  setRenderFrame: (frame: EditorRenderFrame | null) => void;
  nullplugRenderState: EditorNullplugRenderState;
  setNullplugRenderState: (state: EditorNullplugRenderState) => void;
  commitStructuredRender: (
    frame: EditorRenderFrame,
    state: EditorNullplugRenderState,
  ) => void;
  runtimeFacts: DropBranchRuntimeFact[];
  applyRuntimeFacts: (facts: DropBranchRuntimeFact[]) => void;
  clearRuntimeFacts: () => void;
  invalidateStructuredRenderState: () => void;
  clearStructuredRenderState: () => void;
  currentSnapshotId: number | null;
  setCurrentSnapshotId: (snapshotId: number | null) => void;
  baseDropId: string | null;
  setBaseDropId: (dropId: string | null) => void;
  editorMode: EditorMode;
  setEditorMode: (mode: EditorMode) => void;
}

/*
 * If you see a linter error like "Cannot find module 'zustand'..." or "Parameter 'set' implicitly has an 'any' type":
 * 1. Ensure you have run `npm install` (or your package manager's install command).
 * 2. Restart your IDE / TypeScript language server.
 * This usually resolves issues with TypeScript not finding installed module types.
 */
const editorStoreCreator: StateCreator<EditorState> = (set) => ({
  textContent: "", // Initial state for the editor content
  setTextContent: (newContent: string) => set({ textContent: newContent }), // Action to update the content
  clearTextContent: () => set({ textContent: "" }), // Action to clear the content
  renderedMarkdown: "",

  setRenderedMarkdown: (markdown: string) =>
    set({ renderedMarkdown: markdown }),

  renderStatus: "idle",
  setRenderStatus: (status: "idle" | "rendering") =>
    set({ renderStatus: status }),

  renderProgress: 1,
  setRenderProgress: (progress: number) =>
    set({ renderProgress: Math.max(0, Math.min(progress, 1)) }),

  renderFrame: null,
  setRenderFrame: (frame: EditorRenderFrame | null) =>
    set({ renderFrame: frame }),

  nullplugRenderState: createEmptyNullplugRenderState(),
  setNullplugRenderState: (state: EditorNullplugRenderState) =>
    set((current) => ({
      nullplugRenderState: applyBranchRuntimeFacts(
        state,
        current.renderFrame,
        current.runtimeFacts,
      ),
    })),

  commitStructuredRender: (frame, state) =>
    set((current) => ({
      renderFrame: frame,
      nullplugRenderState: applyBranchRuntimeFacts(
        state,
        frame,
        current.runtimeFacts,
      ),
    })),

  runtimeFacts: [],

  applyRuntimeFacts: (facts: DropBranchRuntimeFact[]) =>
    set((state) => {
      const knownFactIds = new Set(
        state.runtimeFacts.map(
          (fact) => `${fact.rootDropId}:${fact.branchId}:${fact.factId}`,
        ),
      );
      const newFacts = facts.filter((fact) => {
        const key = `${fact.rootDropId}:${fact.branchId}:${fact.factId}`;
        if (knownFactIds.has(key)) return false;
        knownFactIds.add(key);
        return true;
      });
      if (!newFacts.length) return {};
      const runtimeFacts = [...state.runtimeFacts, ...newFacts];
      const next = applyBranchRuntimeFacts(
        state.nullplugRenderState,
        state.renderFrame,
        runtimeFacts,
      );
      return next === state.nullplugRenderState
        ? { runtimeFacts }
        : { runtimeFacts, nullplugRenderState: next };
    }),

  clearRuntimeFacts: () => set({ runtimeFacts: [] }),

  invalidateStructuredRenderState: () =>
    set((state) => ({
      renderFrame: state.renderFrame
        ? { ...state.renderFrame, status: "stale" }
        : null,
      nullplugRenderState: createEmptyNullplugRenderState(),
    })),

  clearStructuredRenderState: () =>
    set({
      renderFrame: null,
      nullplugRenderState: createEmptyNullplugRenderState(),
    }),

  currentSnapshotId: null,

  setCurrentSnapshotId: (snapshotId: number | null) =>
    set({ currentSnapshotId: snapshotId }),

  baseDropId: null,

  setBaseDropId: (dropId: string | null) => set({ baseDropId: dropId }),

  editorMode: EditorMode.Edit, // Initial mode set to Edit
  setEditorMode: (mode: EditorMode) => set({ editorMode: mode }),
});

const useEditorStore = create<EditorState>()(
  subscribeWithSelector(editorStoreCreator),
);

export default useEditorStore;
