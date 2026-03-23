import React from "react";
import {
  Cloud,
  Globe,
  HardDrive,
  Link2,
  Lock,
  Search,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface EditorToolbarProps {
  canShare: boolean;
  isTransitioning: boolean;
  offlineMode: boolean;
  shareVisibility: "private" | "unlisted" | "public";
  sharing: boolean;
  modeSwitching: boolean;
  onToggleMode: () => void;
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
  modeSwitching,
  onToggleMode,
  onToggleShareVisibility,
  onOpenLibrary,
  onOpenSettings,
  onShare,
}) => {
  const visibilityLabel =
    shareVisibility === "private"
      ? "Private"
      : shareVisibility === "public"
        ? "Public"
        : "Unlisted";

  const VisibilityIcon =
    shareVisibility === "private"
      ? Lock
      : shareVisibility === "public"
        ? Globe
        : Link2;

  const visibilityButtonClass =
    shareVisibility === "public"
      ? "bg-accent text-accent-foreground hover:bg-accent-hover"
      : "border-border text-muted hover:text-foreground";

  return (
    <div className="py-4 px-4 border-b border-border bg-background flex justify-between items-center">
      <div className="text-sm">NULLDOWN</div>
      <div className="flex gap-2 items-center">
        <Button
          type="button"
          onClick={onToggleMode}
          disabled={modeSwitching}
          variant={offlineMode ? "outline" : "default"}
          size="sm"
          className={
            offlineMode
              ? "border-border text-muted hover:text-foreground"
              : "bg-accent text-accent-foreground hover:bg-accent-hover"
          }
          aria-label="Toggle online mode"
          title={
            offlineMode
              ? "Offline mode enabled"
              : "Online mode enabled"
          }
        >
          {offlineMode ? (
            <HardDrive className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Cloud className="h-4 w-4" aria-hidden="true" />
          )}
          {modeSwitching ? "Switching..." : offlineMode ? "Offline" : "Online"}
        </Button>

        <Button
          type="button"
          onClick={onToggleShareVisibility}
          variant={shareVisibility === "public" ? "default" : "outline"}
          size="sm"
          className={visibilityButtonClass}
          aria-label="Toggle link visibility"
          title={
            offlineMode
              ? `Next online share: ${visibilityLabel}`
              : shareVisibility === "private"
                ? "Private link (account-only unlock)"
                : shareVisibility === "public"
                  ? "Public visibility enabled"
                  : "Unlisted visibility enabled"
          }
        >
          <VisibilityIcon className="h-4 w-4" aria-hidden="true" />
          {visibilityLabel}
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
