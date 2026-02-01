import { staticThemeIds } from "./staticThemeCatalog";
import {
  ThemeFetcher,
  type NssMetadata,
  type NssTheme,
  type ThemeProvider,
} from "./themeEngine";

export const createStaticThemeProvider = () => {
  const fetcher = new ThemeFetcher("/themes");
  const cache = new Map<string, NssTheme>();
  let manifestCache: NssMetadata[] | null = null;

  const loadManifest = async (): Promise<NssMetadata[]> => {
    if (manifestCache) return manifestCache;
    const response = await fetch("/themes/themes.json");
    if (!response.ok) {
      throw new Error(`Theme manifest fetch failed: ${response.status}`);
    }
    const payload = (await response.json()) as NssMetadata[];
    if (!Array.isArray(payload)) {
      throw new Error("Theme manifest is not an array.");
    }
    manifestCache = payload;
    return payload;
  };

  const load = async (themeId: string) => {
    const normalizedId = themeId.replace(/\.css$/i, "");
    const cached = cache.get(normalizedId);
    if (cached) return cached;
    const theme = await fetcher.fetch(normalizedId);
    cache.set(normalizedId, theme);
    return theme;
  };

  const list = async (): Promise<NssMetadata[]> => {
    try {
      return await loadManifest();
    } catch (error) {
      const themes = await Promise.all(staticThemeIds.map((id) => load(id)));
      return themes.map((theme) => theme.metadata);
    }
  };

  const provider: ThemeProvider = {
    id: "static",
    load,
    get: (themeId: string) => cache.get(themeId.replace(/\.css$/i, "")),
    list,
  };

  return provider;
};
