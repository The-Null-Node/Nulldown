import { getMarkdownTitle } from "../markdownText";

export const DRAFT_LIBRARY_INDEX_KEY = "nulldown_draft_index_v1";
export const DRAFT_STORAGE_PREFIX = "nulldown_draft_";
const LEGACY_DRAFT_KEY = "nulldown_draft";

export interface DraftLibraryEntry {
  draftKey: string;
  draftId: string;
  dropId: string | null;
  title: string;
  preview: string;
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isValidEntry = (value: unknown): value is DraftLibraryEntry => {
  if (!isRecord(value)) return false;

  return (
    typeof value.draftKey === "string" &&
    typeof value.draftId === "string" &&
    (typeof value.dropId === "string" || value.dropId === null) &&
    typeof value.title === "string" &&
    typeof value.preview === "string" &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
};

const readRawIndex = (): DraftLibraryEntry[] => {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(DRAFT_LIBRARY_INDEX_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry) => isValidEntry(entry));
  } catch {
    return [];
  }
};

const writeRawIndex = (entries: DraftLibraryEntry[]) => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      DRAFT_LIBRARY_INDEX_KEY,
      JSON.stringify(entries),
    );
  } catch {
    // noop
  }
};

export const createDraftStorageKey = (draftId: string) =>
  `${DRAFT_STORAGE_PREFIX}${draftId}`;

export const getDraftIdFromKey = (draftKey: string): string => {
  if (draftKey.startsWith(DRAFT_STORAGE_PREFIX)) {
    return draftKey.slice(DRAFT_STORAGE_PREFIX.length);
  }

  return draftKey;
};

export const readDraftContent = (draftKey: string): string | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(draftKey);
  } catch {
    return null;
  }
};

export const removeDraftLibraryEntry = (draftKey: string) => {
  const remaining = readRawIndex().filter(
    (entry) => entry.draftKey !== draftKey,
  );
  writeRawIndex(remaining);
};

export const upsertDraftLibraryEntry = (
  draftKey: string,
  content: string,
  options: { dropId?: string | null; updatedAt?: number } = {},
) => {
  const normalizedContent = content.trim();
  if (!normalizedContent) {
    removeDraftLibraryEntry(draftKey);
    return;
  }

  const draftId = getDraftIdFromKey(draftKey);
  const title = getMarkdownTitle(normalizedContent) || "Untitled draft";
  const preview = normalizedContent.replace(/\s+/g, " ").slice(0, 120);
  const updatedAt = options.updatedAt ?? Date.now();

  const nextEntry: DraftLibraryEntry = {
    draftKey,
    draftId,
    dropId: options.dropId ?? null,
    title,
    preview,
    updatedAt,
  };

  const existing = readRawIndex().filter(
    (entry) => entry.draftKey !== draftKey,
  );
  existing.push(nextEntry);
  existing.sort((a, b) => b.updatedAt - a.updatedAt);
  writeRawIndex(existing);
};

export const listDraftLibraryEntries = (): DraftLibraryEntry[] => {
  const indexEntries = readRawIndex();

  const legacyContent = readDraftContent(LEGACY_DRAFT_KEY);
  if (legacyContent && legacyContent.trim()) {
    const hasLegacy = indexEntries.some(
      (entry) => entry.draftKey === LEGACY_DRAFT_KEY,
    );
    if (!hasLegacy) {
      indexEntries.push({
        draftKey: LEGACY_DRAFT_KEY,
        draftId: "scratch",
        dropId: null,
        title: "Scratch draft",
        preview: legacyContent.replace(/\s+/g, " ").slice(0, 120),
        updatedAt: Date.now(),
      });
    }
  }

  const hydrated = indexEntries
    .map((entry) => {
      const content = readDraftContent(entry.draftKey);
      if (!content || !content.trim()) {
        return null;
      }

      const normalizedContent = content.trim();

      return {
        ...entry,
        title: getMarkdownTitle(normalizedContent) || entry.title,
        preview: normalizedContent.replace(/\s+/g, " ").slice(0, 120),
      } satisfies DraftLibraryEntry;
    })
    .filter((entry): entry is DraftLibraryEntry => Boolean(entry))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (hydrated.length !== indexEntries.length) {
    writeRawIndex(hydrated);
  }

  return hydrated;
};
