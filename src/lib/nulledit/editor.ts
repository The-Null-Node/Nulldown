import { Diff } from "./types";
import useEditorStore from "../../stores/editorStore";
interface EditorState {
  textContent: string;
  setTextContent: (newContent: string) => void;
  clearTextContent: () => void;
}

export interface IEditor {
  state: EditorState;
  addDiff: (diff: Diff) => void;
  clearDiffs: () => void;
  render: () => Promise<string>;
}

export default function createEditor(): IEditor {
  return {
    state: useEditorStore.getState(),

    addDiff: (diff: Diff) => {
      useEditorStore.setState((state) => {
        return {
          ...state,
          textContent: state.textContent + diff.data.toString(),
        };
      });
    },

    clearDiffs: () => {
      useEditorStore.setState((state) => {
        return {
          ...state,
          textContent: "",
        };
      });
    },
    render: async () => {
      return useEditorStore.getState().textContent;
    },
  };
}
