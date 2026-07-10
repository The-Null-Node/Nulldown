import {
  staticThemeCatalog,
  type StaticThemeCatalogEntry,
} from "../../themeCatalog";
import { NULLMEM_RECORD_VERSION, type NullMemCapabilityRecord } from "../types";
import { jsonRecordWithDefinedValues } from "./common";

const themeModeLabels = (mode: StaticThemeCatalogEntry["mode"]): string[] =>
  mode ? ["theme-mode", `theme-mode:${mode}`] : [];

/** Converts bundled theme metadata into queryable capability memory. */
export const createThemeCatalogCapabilityRecord = (
  theme: StaticThemeCatalogEntry,
  createdAt = 0,
): NullMemCapabilityRecord => ({
  version: NULLMEM_RECORD_VERSION,
  kind: "capability",
  recordId: `capability:theme:${theme.id}`,
  capabilityKind: "theme",
  capabilityId: theme.id,
  capabilityVersion: theme.version,
  title: `Theme: ${theme.name}`,
  description:
    theme.description ?? `${theme.name} is a bundled Nulldown visual theme.`,
  whenToUse: [
    `Use when a document or workspace should use the ${theme.name} visual theme.`,
    theme.mode
      ? `Use for ${theme.mode} mode reading, preview, or editing contexts.`
      : "Use when the theme metadata matches the desired reading context.",
  ],
  whenNotToUse: [
    "Do not treat a theme capability as executable code or a permission grant.",
    "Do not use as proof of document content; it only describes visual presentation.",
  ],
  labels: [
    "theme",
    "theme-catalog",
    "capability-memory",
    ...themeModeLabels(theme.mode),
    ...(theme.syntax ? [`syntax:${theme.syntax}`] : []),
  ],
  priority: 0.7,
  confidence: 0.9,
  sourceRefs: [{ kind: "theme", themeId: theme.id }],
  createdAt,
  metadata: jsonRecordWithDefinedValues({
    name: theme.name,
    author: theme.author,
    lastModified: theme.lastModified,
    syntax: theme.syntax,
    mode: theme.mode,
  }),
});

/** Returns query-time capability records for all bundled static themes. */
export const createThemeCatalogCapabilityRecords = (
  createdAt = 0,
  themes: readonly StaticThemeCatalogEntry[] = staticThemeCatalog,
): NullMemCapabilityRecord[] =>
  themes.map((theme) => createThemeCatalogCapabilityRecord(theme, createdAt));
