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

  const toggleEditorVisibility = useCallback(() => {
    if (editorMode !== EditorMode.Edit) {
      setEditorMode(EditorMode.Edit);
    }
  }, [editorMode, setEditorMode]);

  const togglePreviewVisibility = useCallback(() => {
    setEditorMode(
      editorMode === EditorMode.Preview ? EditorMode.Edit : EditorMode.Preview,
    );
  }, [editorMode, setEditorMode]);

  return useMemo(
    () => ({
      editorHidden,
      isTransitioning,
      resetView,
      setEditMode,
      setPreviewMode,
      showPreview,
      toggleEditorVisibility,
      togglePreviewVisibility,
    }),
    [
      editorHidden,
      isTransitioning,
      resetView,
      setEditMode,
      setPreviewMode,
      showPreview,
      toggleEditorVisibility,
      togglePreviewVisibility,
    ],
  );
}
