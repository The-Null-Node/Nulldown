import type { SyntaxThemeKey } from "./syntaxThemes";

export type ThemeId = string;

export type ThemeMode = "light" | "dark";

export interface NssMetadata {
  id: ThemeId;
  name: string;
  author: string;
  lastModified: string;
  description?: string;
  version?: string;
  syntax?: SyntaxThemeKey;
  mode?: ThemeMode;
}

export interface NssTheme {
  id: ThemeId;
  cssText: string;
  variables: Record<string, string>;
  metadata: NssMetadata;
}

export interface ThemeProvider {
  id: string;
  load: (themeId: ThemeId) => Promise<NssTheme>;
  get: (themeId: ThemeId) => NssTheme | undefined;
  list?: () => Promise<NssMetadata[]>;
}

export class ThemeFetcher {
  private basePath: string;

  constructor(basePath = "/themes") {
    this.basePath = basePath.replace(/\/$/, "");
  }

  async fetch(themeId: ThemeId): Promise<NssTheme> {
    const normalizedId = themeId.replace(/\.css$/i, "");
    const response = await fetch(`${this.basePath}/${normalizedId}.css`);
    if (!response.ok) {
      throw new Error(
        `Theme fetch failed for ${normalizedId}: ${response.status}`,
      );
    }

    const cssText = await response.text();

    return parseNssTheme(cssText, normalizedId);
  }
}

export class ThemeStreamer {
  private provider: ThemeProvider;
  private inflight = new Map<string, Promise<NssTheme>>();

  constructor(provider: ThemeProvider) {
    this.provider = provider;
  }

  setProvider(provider: ThemeProvider) {
    this.provider = provider;
  }

  get(themeId: ThemeId) {
    return this.provider.get(themeId);
  }

  async load(themeId: ThemeId): Promise<NssTheme> {
    const cached = this.provider.get(themeId);
    if (cached) return cached;

    const existing = this.inflight.get(themeId);
    if (existing) return existing;

    const promise = this.provider
      .load(themeId)
      .finally(() => this.inflight.delete(themeId));
    this.inflight.set(themeId, promise);
    return promise;
  }
}

const themeProviders: Record<string, ThemeProvider> = {};

export const registerThemeProvider = (provider: ThemeProvider) => {
  themeProviders[provider.id] = provider;
};

export const getThemeProvider = (id: string) => themeProviders[id];

export const listThemeProviders = () => ({ ...themeProviders });

const metadataKeys = {
  "--nss-id": "id",
  "--nss-name": "name",
  "--nss-author": "author",
  "--nss-updated": "lastModified",
  "--nss-version": "version",
  "--nss-description": "description",
  "--nss-syntax": "syntax",
  "--nss-mode": "mode",
} as const;

const normalizeCssValue = (value: string) =>
  value.trim().replace(/^['"]|['"]$/g, "");

const extractRootBlock = (cssText: string) => {
  const match = cssText.match(/:root\s*{([\s\S]*?)}/);
  if (!match) {
    throw new Error("NSS theme missing :root block.");
  }
  return match[1];
};

const extractColorScheme = (rootBlock: string) => {
  const match = rootBlock.match(/color-scheme\s*:\s*([^;]+);/i);
  if (!match) return undefined;
  const value = normalizeCssValue(match[1]);
  if (value === "light" || value === "dark") return value;
  return undefined;
};

const extractVariables = (rootBlock: string) => {
  const vars: Record<string, string> = {};
  const regex = /(--[A-Za-z0-9-_]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rootBlock))) {
    vars[match[1]] = normalizeCssValue(match[2]);
  }
  return vars;
};

export const parseNssTheme = (
  cssText: string,
  fallbackId: string,
): NssTheme => {
  const rootBlock = extractRootBlock(cssText);
  const variables = extractVariables(rootBlock);

  const metadata: Partial<NssMetadata> = {};
  Object.entries(metadataKeys).forEach(([cssKey, metaKey]) => {
    const value = variables[cssKey];
    if (value) {
      (metadata as Record<string, string>)[metaKey] = value;
    }
  });

  const colorScheme = extractColorScheme(rootBlock);

  const resolvedMetadata: NssMetadata = {
    id: metadata.id || fallbackId,
    name: metadata.name || fallbackId,
    author: metadata.author || "Unknown",
    lastModified: metadata.lastModified || "",
    description: metadata.description,
    version: metadata.version,
    syntax: metadata.syntax as SyntaxThemeKey | undefined,
    mode: (metadata.mode as ThemeMode | undefined) || colorScheme,
  };

  Object.keys(metadataKeys).forEach((key) => {
    delete variables[key];
  });

  return {
    id: resolvedMetadata.id,
    cssText,
    variables,
    metadata: resolvedMetadata,
  };
};
