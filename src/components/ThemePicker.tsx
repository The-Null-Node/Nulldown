import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme, useThemeCatalog } from "../theme/themeContext";

const ThemePicker = () => {
  const { themeId, setThemeId } = useTheme();

  const catalog = useThemeCatalog();
  const options = useMemo(
    () => [
      { id: "system", name: "System" },
      ...catalog.map((theme) => ({ id: theme.id, name: theme.name })),
    ],
    [catalog],
  );

  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        aria-label="Open settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-border text-muted hover:text-foreground hover:bg-card/70 focus:outline-none focus:ring-2 focus:ring-accent/40"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
          <circle cx="5" cy="12" r="2" fill="currentColor" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
          <circle cx="19" cy="12" r="2" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Settings"
          className="absolute right-0 mt-2 w-56 rounded-md border border-border bg-card shadow-lg p-3 z-50"
        >
          <div className="text-xs uppercase tracking-wide text-muted mb-2">
            Theme
          </div>
          <div className="space-y-1">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={themeId === option.id}
                onClick={() => {
                  setThemeId(option.id);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-left transition-colors ${
                  themeId === option.id
                    ? "bg-accent/10 text-accent"
                    : "text-foreground hover:bg-muted/40"
                }`}
              >
                <span>{option.name}</span>
                {themeId === option.id ? (
                  <span className="text-xs uppercase tracking-wide">
                    Active
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ThemePicker;
