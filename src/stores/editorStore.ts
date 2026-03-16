import { create, StateCreator } from "zustand";

/**
 * Editor modes to switch the UI state between editing and previewing.
 */
export enum EditorMode {
  Preview,
  Edit,
}

/**
 * The editor state is the state of the editor.
 * It contains the text content of the editor and the diffs of the editor.
 * The diffs are the changes to the text content of the editor.
 * The diffs are resolved to the text content of the editor.
 * The diffs are resolved to the text content of the editor.
 **/
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

  currentSnapshotId: null,

  setCurrentSnapshotId: (snapshotId: number | null) =>
    set({ currentSnapshotId: snapshotId }),

  baseDropId: null,

  setBaseDropId: (dropId: string | null) => set({ baseDropId: dropId }),

  editorMode: EditorMode.Edit, // Initial mode set to Edit
  setEditorMode: (mode: EditorMode) => set({ editorMode: mode }),
});

const useEditorStore = create<EditorState>(editorStoreCreator);

export default useEditorStore;
