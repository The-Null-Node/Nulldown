import { create, StateCreator } from 'zustand';

// Define the state shape and actions with TypeScript
export interface EditorState {
  textContent: string;
  setTextContent: (newContent: string) => void;
  clearTextContent: () => void;
}

/*
 * If you see a linter error like "Cannot find module 'zustand'..." or "Parameter 'set' implicitly has an 'any' type":
 * 1. Ensure you have run `npm install` (or your package manager's install command).
 * 2. Restart your IDE / TypeScript language server.
 * This usually resolves issues with TypeScript not finding installed module types.
 */
const editorStoreCreator: StateCreator<EditorState> = (set) => ({
  textContent: '', // Initial state for the editor content
  setTextContent: (newContent: string) => set({ textContent: newContent }), // Action to update the content
  clearTextContent: () => set({ textContent: '' }), // Action to clear the content
});

const useEditorStore = create<EditorState>(editorStoreCreator);

export default useEditorStore; 