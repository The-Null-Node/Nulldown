import React from "react";
import { Settings } from "lucide-react";

interface EditorToolbarProps {
  canShare: boolean;
  isTransitioning: boolean;
  sharing: boolean;
  onOpenSettings: () => void;
  onShare: () => void;
}

const EditorToolbar: React.FC<EditorToolbarProps> = ({
  canShare,
  isTransitioning,
  sharing,
  onOpenSettings,
  onShare,
}) => {
  return (
    <div className="py-4 px-4 border-b border-border bg-background flex justify-between items-center">
      <div className="text-sm">NULLDOWN</div>
      <div className="flex gap-2 items-center">
        <button
          type="button"
          onClick={onOpenSettings}
          className="h-10 w-10 inline-flex items-center justify-center rounded-md border border-border text-muted hover:text-foreground hover:bg-card/70 focus:outline-none focus:ring-2 focus:ring-accent/40"
          aria-label="Open settings"
        >
          <Settings className="h-5 w-5" aria-hidden="true" />
        </button>
        <button
          onClick={onShare}
          disabled={sharing || !canShare || isTransitioning}
          className="bg-accent text-accent-foreground hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {sharing && (
            <span className="inline-block w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin mr-2"></span>
          )}
          {sharing ? "Sharing..." : "Share to the Void"}
        </button>
      </div>
    </div>
  );
};

export default EditorToolbar;
