import React, { useEffect, useState } from "react";
import { create } from "zustand";
import {
  ThemeStreamer,
  getThemeProvider,
  listThemeProviders,
  registerThemeProvider,
  type NssMetadata,
  type NssTheme,
  type ThemeId,
  type ThemeMode,
} from "./themeEngine";
import { createStaticThemeProvider } from "./staticThemeProvider";
import { syntaxThemeStyles, type SyntaxThemeKey } from "./syntaxThemes";
import {
  DEFAULT_TYPEFACE_ID,
  TYPEFACE_STORAGE_KEY,
  getTypefaceById,
  isTypefaceId,
  type TypefaceId,
  typefaceCatalog,
} from "./typefaceCatalog";

const STORAGE_KEY = "nulldown_theme";
const STYLE_TAG_ID = "nss-theme";
const DEFAULT_PROVIDER_ID = "static";

interface ResolvedTheme {
  id: ThemeId;
  mode: ThemeMode;
  syntax: SyntaxThemeKey;
  metadata: NssMetadata;
  variables: Record<string, string>;
}

interface ThemeState {
  themeId: ThemeId;
  typefaceId: TypefaceId;
  systemMode: ThemeMode;
  providerId: string;
  activeTheme: NssTheme | null;
  resolvedTheme: ResolvedTheme;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  loadToken: number;
  hydrated: boolean;
  setThemeId: (id: ThemeId) => Promise<void>;
  setTypefaceId: (id: TypefaceId) => void;
  setSystemMode: (mode: ThemeMode) => void;
  setProviderId: (id: string) => void;
  hydrateTheme: () => void;
}

const getSystemMode = () => {
  if (typeof window === "undefined") return "dark" as ThemeMode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

const getStoredTheme = () => {
  if (typeof window === "undefined") return "system" as ThemeId;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored || "system";
};

const getStoredTypeface = (): TypefaceId => {
  if (typeof window === "undefined") return DEFAULT_TYPEFACE_ID;
  const stored = window.localStorage.getItem(TYPEFACE_STORAGE_KEY);
  if (stored && isTypefaceId(stored)) {
    return stored;
  }
  return DEFAULT_TYPEFACE_ID;
};

const isSyntaxThemeKey = (value?: string): value is SyntaxThemeKey =>
  Boolean(value && value in syntaxThemeStyles);

const createSystemMetadata = (mode: ThemeMode): NssMetadata => ({
  id: "system",
  name: "System",
  author: "System",
  lastModified: "",
  description: `System ${mode} mode`,
  version: "",
  mode,
  syntax: mode === "dark" ? "vscDarkPlus" : "vs",
});

const resolveTheme = (theme: NssTheme | null, systemMode: ThemeMode) => {
  if (!theme) {
    const metadata = createSystemMetadata(systemMode);
    return {
      id: "system",
      mode: systemMode,
      syntax: metadata.syntax ?? "vscDarkPlus",
      metadata,
      variables: {},
    } satisfies ResolvedTheme;
  }

  const metadata = theme.metadata;
  const mode = metadata.mode ?? systemMode;
  const syntax = isSyntaxThemeKey(metadata.syntax)
    ? metadata.syntax
    : mode === "dark"
      ? "vscDarkPlus"
      : "vs";

  return {
    id: metadata.id,
    mode,
    syntax,
    metadata,
    variables: theme.variables,
  } satisfies ResolvedTheme;
};

const staticProvider = createStaticThemeProvider();
registerThemeProvider(staticProvider);
const themeStreamer = new ThemeStreamer(staticProvider);

export const useThemeStore = create<ThemeState>((set, get) => {
  const themeId = getStoredTheme();
  const typefaceId = getStoredTypeface();
  const systemMode = getSystemMode();

  const setThemeId = async (id: ThemeId) => {
    const nextId = id || "system";
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, nextId);
    }

    const token = get().loadToken + 1;
    set({ themeId: nextId, status: "loading", error: null, loadToken: token });

    if (nextId === "system") {
      set({
        activeTheme: null,
        resolvedTheme: resolveTheme(null, get().systemMode),
        status: "ready",
      });
      return;
    }

    try {
      const loaded = await themeStreamer.load(nextId);
      if (get().loadToken !== token) return;
      set({
        activeTheme: loaded,
        resolvedTheme: resolveTheme(loaded, get().systemMode),
        status: "ready",
      });
    } catch (error) {
      if (get().loadToken !== token) return;
      const message =
        error instanceof Error ? error.message : "Failed to load theme.";
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, "system");
      }
      set({
        themeId: "system",
        activeTheme: null,
        resolvedTheme: resolveTheme(null, get().systemMode),
        status: "error",
        error: message,
      });
    }
  };

  return {
    themeId,
    typefaceId,
    systemMode,
    providerId: DEFAULT_PROVIDER_ID,
    activeTheme: null,
    resolvedTheme: resolveTheme(null, systemMode),
    status: "idle",
    error: null,
    loadToken: 0,
    hydrated: false,
    setThemeId,
    setTypefaceId: (id: TypefaceId) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(TYPEFACE_STORAGE_KEY, id);
      }
      set({ typefaceId: id });
    },
    setSystemMode: (mode: ThemeMode) =>
      set((state) => ({
        systemMode: mode,
        resolvedTheme: resolveTheme(state.activeTheme, mode),
      })),
    setProviderId: (id: string) => {
      const provider = getThemeProvider(id);
      if (!provider) return;
      themeStreamer.setProvider(provider);
      set({ providerId: id });
    },
    hydrateTheme: () => {
      if (get().hydrated) return;
      set({ hydrated: true });
      void setThemeId(get().themeId);
    },
  };
});

const applyThemeCss = (theme: NssTheme | null) => {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(STYLE_TAG_ID) as
    | HTMLStyleElement
    | null;

  if (!theme) {
    if (existing) existing.remove();
    return;
  }

  const styleTag = existing ?? document.createElement("style");
  styleTag.id = STYLE_TAG_ID;
  styleTag.textContent = theme.cssText;
  if (!existing) {
    document.head.appendChild(styleTag);
  }
};

export const ThemeProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const themeId = useThemeStore((state) => state.themeId);
  const typefaceId = useThemeStore((state) => state.typefaceId);
  const systemMode = useThemeStore((state) => state.systemMode);
  const activeTheme = useThemeStore((state) => state.activeTheme);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const setSystemMode = useThemeStore((state) => state.setSystemMode);
  const hydrateTheme = useThemeStore((state) => state.hydrateTheme);

  useEffect(() => {
    hydrateTheme();
  }, [hydrateTheme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      setSystemMode(media.matches ? "dark" : "light");
    };

    handleChange();

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
  }, [setSystemMode]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.removeAttribute("data-theme");

    if (themeId === "system") {
      applyThemeCss(null);
      root.style.colorScheme = systemMode;
      return;
    }

    applyThemeCss(activeTheme);
    root.style.colorScheme = resolvedTheme.mode;
  }, [activeTheme, resolvedTheme.mode, systemMode, themeId]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const typeface = getTypefaceById(typefaceId);

    root.style.setProperty("--font-ui-stack", typeface.uiStack);
    root.style.setProperty("--font-prose-stack", typeface.proseStack);
    root.style.setProperty("--font-mono-stack", typeface.monoStack);
  }, [typefaceId]);

  return <>{children}</>;
};

export const useTheme = () =>
  useThemeStore((state) => ({
    themeId: state.themeId,
    typefaceId: state.typefaceId,
    setThemeId: state.setThemeId,
    setTypefaceId: state.setTypefaceId,
    theme: state.resolvedTheme,
    status: state.status,
    error: state.error,
  }));

export const useTypefaceCatalog = () => typefaceCatalog;

export const useThemeCatalog = () => {
  const providerId = useThemeStore((state) => state.providerId);
  const provider = listThemeProviders()[providerId];
  const [themes, setThemes] = useState<NssMetadata[]>([]);

  useEffect(() => {
    let active = true;
    if (!provider?.list) {
      setThemes([]);
      return () => {
        active = false;
      };
    }
    provider
      .list()
      .then((result) => {
        if (active) setThemes(result);
      })
      .catch(() => {
        if (active) setThemes([]);
      });
    return () => {
      active = false;
    };
  }, [provider]);

  return themes;
};
