import React from "react";
import {
  GitBranch,
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
  canOpenBranches?: boolean;
  canShare: boolean;
  isTransitioning: boolean;
  offlineMode: boolean;
  shareVisibility: "private" | "unlisted" | "public";
  syncLabel?: string | null;
  syncTitle?: string | null;
  canTakeOverBranch?: boolean;
  shareLabel?: string;
  sharingLabel?: string;
  sharing: boolean;
  modeSwitching: boolean;
  onToggleMode: () => void;
  onToggleShareVisibility: () => void;
  onOpenLibrary: () => void;
  onOpenBranches?: () => void;
  onOpenSettings: () => void;
  onTakeOverBranch?: () => void;
  onShare: () => void;
}

const EditorToolbar: React.FC<EditorToolbarProps> = ({
  canShare,
  canOpenBranches = false,
  isTransitioning,
  offlineMode,
  shareVisibility,
  syncLabel,
  syncTitle,
  canTakeOverBranch = false,
  shareLabel = "Share to the Void",
  sharingLabel = "Sharing...",
  sharing,
  modeSwitching,
  onToggleMode,
  onToggleShareVisibility,
  onOpenLibrary,
  onOpenBranches,
  onOpenSettings,
  onTakeOverBranch,
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
        {syncLabel ? (
          <span
            className="hidden rounded-full border border-border px-2 py-1 text-xs text-muted sm:inline-flex"
            title={syncTitle ?? undefined}
            aria-label={syncTitle ?? syncLabel}
          >
            {syncLabel}
          </span>
        ) : null}
        {canTakeOverBranch && onTakeOverBranch ? (
          <Button type="button" size="sm" variant="outline" onClick={onTakeOverBranch}>
            Take over
          </Button>
        ) : null}

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
        {canOpenBranches && onOpenBranches ? (
          <Button
            type="button"
            onClick={onOpenBranches}
            variant="outline"
            size="sm"
            className="border-border text-muted hover:text-foreground"
            aria-label="Open branch activity"
          >
            <GitBranch className="h-4 w-4" aria-hidden="true" />
            Branches
          </Button>
        ) : null}
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
          {sharing ? sharingLabel : shareLabel}
        </Button>
      </div>
    </div>
  );
};

export default EditorToolbar;
