import React from "react";
import { Globe, Link2, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EditorToolbarProps {
  canShare: boolean;
  isTransitioning: boolean;
  offlineMode: boolean;
  shareVisibility: "unlisted" | "public";
  sharing: boolean;
  onToggleShareVisibility: () => void;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
  onShare: () => void;
}

const EditorToolbar: React.FC<EditorToolbarProps> = ({
  canShare,
  isTransitioning,
  offlineMode,
  shareVisibility,
  sharing,
  onToggleShareVisibility,
  onOpenLibrary,
  onOpenSettings,
  onShare,
}) => {
  const isPublic = shareVisibility === "public";

  return (
    <div className="py-4 px-4 border-b border-border bg-background flex justify-between items-center">
      <div className="text-sm">NULLDOWN</div>
      <div className="flex gap-2 items-center">
        <Button
          type="button"
          onClick={onToggleShareVisibility}
          disabled={offlineMode}
          variant={isPublic ? "default" : "outline"}
          size="sm"
          className={
            isPublic
              ? "bg-accent text-accent-foreground hover:bg-accent-hover"
              : "border-border text-muted hover:text-foreground"
          }
          aria-label="Toggle link visibility"
          title={
            offlineMode
              ? "Link visibility is available in online mode only"
              : isPublic
                ? "Public visibility enabled"
                : "Unlisted visibility enabled"
          }
        >
          {isPublic ? (
            <Globe className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Link2 className="h-4 w-4" aria-hidden="true" />
          )}
          {isPublic ? "Public" : "Unlisted"}
        </Button>
        <Button
          type="button"
          onClick={onOpenLibrary}
          variant="outline"
          size="sm"
          className="border-border text-muted hover:text-foreground"
          aria-label="Open search"
        >
          <Search className="h-4 w-4" aria-hidden="true" />
          Search
        </Button>
        <Button
          type="button"
          onClick={onOpenSettings}
          variant="outline"
          size="icon"
          className="border-border text-muted hover:text-foreground"
          aria-label="Open settings"
        >
          <Settings className="h-5 w-5" aria-hidden="true" />
        </Button>
        <Button
          onClick={onShare}
          disabled={sharing || !canShare || isTransitioning}
          size="lg"
          variant="default"
          className="bg-accent text-accent-foreground hover:bg-accent-hover"
        >
          {sharing && (
            <span className="inline-block w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin mr-2"></span>
          )}
          {sharing ? "Sharing..." : "Share to the Void"}
        </Button>
      </div>
    </div>
  );
};

export default EditorToolbar;
