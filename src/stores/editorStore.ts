import { create, StateCreator } from "zustand";

/**
 * The operation to be performed on the text content of the editor.
 * The operation can be INSERT, DELETE, or RETAIN.
 * The INSERT operation inserts the data at the range.
 * The DELETE operation deletes the data at the range.
 * The RETAIN operation retains the data at the range.
 **/
export enum DiffOp {
  INSERT = 0,
  DELETE = 1,
  RETAIN = 2,
}

/**
 * The diff is the change to the text content of the editor.
 * It contains the operation to be performed, the data to be performed, the attributes of the operation, and the range of the operation.
 * The operation is the operation to be performed on the text content of the editor.
 * The data is the data to be performed on the text content of the editor.
 * The attributes are the attributes of the operation.
 * The range is the range of the operation.
 **/
export interface Diff {
  op: DiffOp;
  data: ArrayBuffer;
  attributes?: Record<string, any>;
  range?: {
    start: number;
    end: number;
  };
}

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
  editorMode: EditorMode.Edit, // Initial mode set to Edit
  setEditorMode: (mode: EditorMode) => set({ editorMode: mode }),
});

const useEditorStore = create<EditorState>(editorStoreCreator);

export default useEditorStore;
