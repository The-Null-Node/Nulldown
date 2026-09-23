export type TypefaceId = "jetbrains-mono" | "geist-sans" | "editorial-serif";

export interface TypefaceDefinition {
  id: TypefaceId;
  name: string;
  description: string;
  uiStack: string;
  proseStack: string;
  monoStack: string;
}

export const TYPEFACE_STORAGE_KEY = "nulldown_typeface";
export const DEFAULT_TYPEFACE_ID: TypefaceId = "jetbrains-mono";

export const typefaceCatalog: readonly TypefaceDefinition[] = [
  {
    id: "jetbrains-mono",
    name: "JetBrains Mono",
    description: "Monospaced UI and prose for terminal-style writing.",
    uiStack: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    proseStack:
      '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    monoStack: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  {
    id: "geist-sans",
    name: "Geist Sans",
    description: "Balanced sans UI while keeping code blocks monospace.",
    uiStack:
      '"Geist Variable", Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
    proseStack:
      '"Geist Variable", Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
    monoStack: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  {
    id: "editorial-serif",
    name: "Editorial Serif",
    description: "Readable serif prose with modern sans controls.",
    uiStack:
      '"Geist Variable", Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
    proseStack: 'Iowan Old Style, Charter, Georgia, "Times New Roman", serif',
    monoStack: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
];

const typefaceMap = new Map(typefaceCatalog.map((typeface) => [typeface.id, typeface]));

export const isTypefaceId = (value: string): value is TypefaceId =>
  typefaceMap.has(value as TypefaceId);

export const getTypefaceById = (id: string | null | undefined): TypefaceDefinition => {
  if (id && isTypefaceId(id)) {
    return typefaceMap.get(id)!;
  }

  return typefaceMap.get(DEFAULT_TYPEFACE_ID)!;
};
