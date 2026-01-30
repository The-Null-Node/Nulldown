import React, { useRef } from "react";
import { useTheme } from "../../../theme/themeContext";
import { themeOptions, type ThemeId } from "../../../theme/themes";

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
}) => {
  const { themeId, setThemeId } = useTheme();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const currentLabel =
    themeOptions.find((option) => option.id === themeId)?.label ?? "System";

  const handleThemeSelect = (id: ThemeId) => {
    setThemeId(id);
    detailsRef.current?.removeAttribute("open");
  };

  return (
    <div className="py-4 px-4 border-b border-border bg-background flex justify-between items-center">
      <div className="text-sm">NULLDOWN</div>
      <div className="flex gap-2 items-center">
        <details ref={detailsRef} className="relative theme-picker">
          <summary className="list-none cursor-pointer border border-border bg-card text-foreground rounded-md px-2 py-2 text-xs font-medium hover:border-accent focus:outline-none focus:border-accent">
            <span className="sr-only">Theme</span>
            <span className="inline-flex items-center gap-2">
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-4 w-4 text-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
              </svg>
              {themeId !== "system" && <span>{currentLabel}</span>}
            </span>
          </summary>
          <div className="absolute right-0 mt-2 w-48 border border-border bg-card shadow-lg rounded-md p-1 z-20">
            {themeOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => handleThemeSelect(option.id)}
                className={`w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-accent/10 ${
                  option.id === themeId ? "bg-accent/10 text-accent" : ""
                }`}
              >
                <span>{option.label}</span>
                {option.id === themeId && <span>•</span>}
              </button>
            ))}
          </div>
        </details>

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
