import type { SyntaxThemeKey } from "./syntaxThemes";

export type ThemeMode = "light" | "dark";

export type ThemeId =
  | "system"
  | "monokai"
  | "dracula"
  | "nord"
  | "tokyo-night"
  | "one-dark"
  | "one-light"
  | "gruvbox-dark"
  | "gruvbox-light"
  | "solarized-dark"
  | "solarized-light"
  | "github-dark"
  | "github-light"
  | "catppuccin-mocha";

export interface ThemePreset {
  id: Exclude<ThemeId, "system">;
  label: string;
  mode: ThemeMode;
  syntax: SyntaxThemeKey;
}

export interface ThemeOption {
  id: ThemeId;
  label: string;
  mode: ThemeMode;
  syntax: SyntaxThemeKey;
}

export const themePresets: ThemePreset[] = [
  { id: "monokai", label: "Monokai", mode: "dark", syntax: "xonokai" },
  { id: "dracula", label: "Dracula", mode: "dark", syntax: "dracula" },
  { id: "nord", label: "Nord", mode: "dark", syntax: "nord" },
  { id: "tokyo-night", label: "Tokyo Night", mode: "dark", syntax: "nightOwl" },
  { id: "one-dark", label: "One Dark", mode: "dark", syntax: "oneDark" },
  { id: "one-light", label: "One Light", mode: "light", syntax: "oneLight" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", mode: "dark", syntax: "gruvboxDark" },
  { id: "gruvbox-light", label: "Gruvbox Light", mode: "light", syntax: "gruvboxLight" },
  { id: "solarized-dark", label: "Solarized Dark", mode: "dark", syntax: "solarizedDarkAtom" },
  { id: "solarized-light", label: "Solarized Light", mode: "light", syntax: "solarizedlight" },
  { id: "github-dark", label: "GitHub Dark", mode: "dark", syntax: "vscDarkPlus" },
  { id: "github-light", label: "GitHub Light", mode: "light", syntax: "ghcolors" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", mode: "dark", syntax: "materialOceanic" },
];

export const themeOptions: ThemeOption[] = [
  { id: "system", label: "System", mode: "dark", syntax: "vscDarkPlus" },
  ...themePresets,
];

export const themePresetById = Object.fromEntries(
  themePresets.map((theme) => [theme.id, theme]),
) as Record<ThemePreset["id"], ThemePreset>;

export const themeOptionIds = new Set<ThemeId>(themeOptions.map((theme) => theme.id));
