import React, { useEffect, useMemo } from "react";
import { useTheme, useThemeCatalog } from "../../../theme/themeContext";
import useDropStore from "../../../stores/dropStore";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const { themeId, setThemeId } = useTheme();
  const catalog = useThemeCatalog();
  const offlineMode = useDropStore((state) => state.offlineMode);
  const setOfflineMode = useDropStore((state) => state.setOfflineMode);
  const hydrateOfflineMode = useDropStore((state) => state.hydrateOfflineMode);
  const options = useMemo(
    () => [
      { id: "system", name: "System" },
      ...catalog.map((theme) => ({ id: theme.id, name: theme.name })),
    ],
    [catalog],
  );

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    void hydrateOfflineMode();
  }, [open, hydrateOfflineMode]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative z-10 w-full max-w-lg rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="settings-title" className="text-base font-semibold">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border text-muted hover:text-foreground hover:bg-muted/40"
            aria-label="Close settings"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6l-12 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-6">
          <section className="space-y-3">
            <div className="text-xs uppercase tracking-wide text-muted">
              Theme
            </div>
            <div className="space-y-2">
              <label
                htmlFor="theme-select"
                className="text-sm text-foreground"
              >
                UI theme
              </label>
              <select
                id="theme-select"
                value={themeId}
                onChange={(event) => {
                  void setThemeId(event.target.value);
                }}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section className="space-y-2 border-t border-border pt-4">
            <div className="text-xs uppercase tracking-wide text-muted">
              Shortcuts
            </div>
            <div className="text-sm text-foreground">
              <div className="flex items-center justify-between">
                <span>Share drop</span>
                <span className="text-xs text-muted">Cmd/Ctrl + Enter</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Focus preview</span>
                <span className="text-xs text-muted">Esc</span>
              </div>
            </div>
          </section>

          <section className="space-y-2 border-t border-border pt-4">
            <div className="text-xs uppercase tracking-wide text-muted">
              Storage
            </div>
            <p className="text-sm text-foreground">
              Drafts are saved locally in your browser while you type.
            </p>
            <div className="rounded-md border border-border bg-background px-3 py-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm text-foreground">Offline mode</div>
                  <div className="text-xs text-muted">
                    {offlineMode
                      ? "Drops are encrypted and saved locally to IndexedDB on this browser profile."
                      : "Drops are end-to-end encrypted, uploaded online, and unlocked with your passkey vault."}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={offlineMode}
                  onClick={() => void setOfflineMode(!offlineMode)}
                  className={`relative inline-flex h-7 w-12 items-center rounded-full border border-border transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40 ${
                    offlineMode ? "bg-accent/80" : "bg-muted/60"
                  }`}
                >
                  <span
                    className={`absolute left-1 inline-block h-5 w-5 transform rounded-full bg-background shadow-sm transition-transform ${
                      offlineMode ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                  <span className="sr-only">Toggle offline mode</span>
                </button>
              </div>

              <div className="text-xs text-muted">
                Current mode: {offlineMode ? "Offline" : "Online"}
              </div>

              {offlineMode ? (
                <div className="text-xs text-muted">
                  Offline links are local-only and work in this browser profile.
                </div>
              ) : (
                <div className="text-xs text-muted">
                  Online links require your account vault unlock to decrypt.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
