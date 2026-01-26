import React from "react";

interface EditorToolbarProps {
  canShare: boolean;
  editorHidden: boolean;
  isTransitioning: boolean;
  sharing: boolean;
  showPreview: boolean;
  onShare: () => void;
  onToggleEditor: () => void;
  onTogglePreview: () => void;
}

const EditorToolbar: React.FC<EditorToolbarProps> = ({
  canShare,
  editorHidden,
  isTransitioning,
  sharing,
  showPreview,
  onShare,
  onToggleEditor,
  onTogglePreview,
}) => (
  <div className="py-4 px-4 border-b border-border bg-background flex justify-between items-center">
    <div className="text-sm">NULLDOWN</div>
    <div className="flex gap-2">
      <button
        onClick={onTogglePreview}
        disabled={isTransitioning || editorHidden}
        className={`border border-accent text-accent hover:bg-accent/10 rounded-md px-4 py-2 text-sm font-medium ${isTransitioning ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        {showPreview ? "Hide Preview" : "Show Preview"}
      </button>

      <button
        onClick={onToggleEditor}
        disabled={isTransitioning || (!showPreview && editorHidden)}
        className={`border ${editorHidden ? "border-error-light text-error-light hover:bg-error/10" : "border-accent text-accent hover:bg-accent/10"} rounded-md px-4 py-2 text-sm font-medium ${isTransitioning ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        {editorHidden ? "Show Editor" : "Hide Editor"}
      </button>

      <button
        onClick={onShare}
        disabled={sharing || !canShare || isTransitioning}
        className="bg-accent text-black hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {sharing && (
          <span className="inline-block w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin mr-2"></span>
        )}
        {sharing ? "Sharing..." : "Share to the Void"}
      </button>
    </div>
  </div>
);

export default EditorToolbar;
