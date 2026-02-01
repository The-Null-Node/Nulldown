import { useCallback, useMemo } from "react";
import useEditorStore, { EditorMode } from "../../../stores/editorStore";

export function usePreviewToggle() {
  const editorMode = useEditorStore((state) => state.editorMode);
  const setEditorMode = useEditorStore((state) => state.setEditorMode);

  const showPreview = editorMode === EditorMode.Preview;
  const editorHidden = showPreview;
  const isTransitioning = false;

  const resolveEditorMode = (): EditorMode => {
    return EditorMode.Preview;
  };

  const resetView = useCallback(() => {
    setEditorMode(EditorMode.Edit);
  }, [setEditorMode]);

  const setPreviewMode = useCallback(() => {
    setEditorMode(EditorMode.Preview);
  }, [setEditorMode]);

  const setEditMode = useCallback(() => {
    setEditorMode(EditorMode.Edit);
  }, [setEditorMode]);

  return useMemo(
    () => ({
      editorHidden,
      isTransitioning,
      resetView,
      setEditMode,
      setPreviewMode,
      showPreview,
    }),
    [
      editorHidden,
      isTransitioning,
      resetView,
      setEditMode,
      setPreviewMode,
      showPreview,
    ],
  );
}
