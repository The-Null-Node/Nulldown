import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { themeOptionIds, themeOptions, themePresetById, type ThemeId, type ThemeMode } from "./themes";
import type { SyntaxThemeKey } from "./syntaxThemes";

const STORAGE_KEY = "nulldown_theme";

interface ResolvedTheme {
  id: ThemeId;
  label: string;
  mode: ThemeMode;
  syntax: SyntaxThemeKey;
}

interface ThemeContextValue {
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
  theme: ResolvedTheme;
  options: typeof themeOptions;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const getSystemMode = () => {
  if (typeof window === "undefined") return "dark" as ThemeMode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const getStoredTheme = () => {
  if (typeof window === "undefined") return "system" as ThemeId;
  const stored = window.localStorage.getItem(STORAGE_KEY) as ThemeId | null;
  return stored && themeOptionIds.has(stored) ? stored : ("system" as ThemeId);
};

export const ThemeProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [themeId, setThemeId] = useState<ThemeId>(() => getStoredTheme());
  const [systemMode, setSystemMode] = useState<ThemeMode>(() => getSystemMode());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      setSystemMode(media.matches ? "dark" : "light");
    };

    if (media.addEventListener) {
      media.addEventListener("change", handleChange);
    } else {
      media.addListener(handleChange);
    }

    return () => {
      if (media.removeEventListener) {
        media.removeEventListener("change", handleChange);
      } else {
        media.removeListener(handleChange);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, themeId);
  }, [themeId]);

  const resolvedTheme = useMemo<ResolvedTheme>(() => {
    if (themeId === "system") {
      return {
        id: "system",
        label: "System",
        mode: systemMode,
        syntax: systemMode === "dark" ? "vscDarkPlus" : "vs",
      };
    }

    return themePresetById[themeId];
  }, [themeId, systemMode]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;

    if (themeId === "system") {
      root.removeAttribute("data-theme");
      root.style.colorScheme = systemMode;
      return;
    }

    root.setAttribute("data-theme", themeId);
    root.style.colorScheme = resolvedTheme.mode;
  }, [resolvedTheme.mode, systemMode, themeId]);

  const handleThemeChange = useCallback((id: ThemeId) => {
    setThemeId(id);
  }, []);

  const value = useMemo(
    () => ({
      themeId,
      setThemeId: handleThemeChange,
      theme: resolvedTheme,
      options: themeOptions,
    }),
    [handleThemeChange, resolvedTheme, themeId],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
};
