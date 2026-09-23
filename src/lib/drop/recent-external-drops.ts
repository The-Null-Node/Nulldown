export interface RecentExternalDropRecord {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
}

const RECENT_EXTERNAL_DROPS_KEY = "nulldown_recent_external_drop_index_v1";
const MAX_RECENT_EXTERNAL_DROPS = 24;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isValidRecentExternalDrop = (
  value: unknown,
): value is RecentExternalDropRecord => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.preview === "string" &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
};

const normalizePreview = (value: string) =>
  value.replace(/\s+/g, " ").trim().slice(0, 120);

const readRawIndex = (): RecentExternalDropRecord[] => {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(RECENT_EXTERNAL_DROPS_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry) => isValidRecentExternalDrop(entry));
  } catch {
    return [];
  }
};

const writeRawIndex = (entries: RecentExternalDropRecord[]) => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(RECENT_EXTERNAL_DROPS_KEY, JSON.stringify(entries));
  } catch {
    // noop
  }
};

export const upsertRecentExternalDrop = (
  entry: Omit<RecentExternalDropRecord, "updatedAt"> & { updatedAt?: number },
) => {
  const id = entry.id.trim();
  if (!id) {
    return;
  }

  const normalized: RecentExternalDropRecord = {
    id,
    title: entry.title.trim() || id,
    preview: normalizePreview(entry.preview),
    updatedAt: entry.updatedAt ?? Date.now(),
  };

  const next = readRawIndex().filter((existing) => existing.id !== normalized.id);
  next.push(normalized);
  next.sort((a, b) => b.updatedAt - a.updatedAt);

  writeRawIndex(next.slice(0, MAX_RECENT_EXTERNAL_DROPS));
};

export const listRecentExternalDrops = (): RecentExternalDropRecord[] => {
  return readRawIndex().sort((a, b) => b.updatedAt - a.updatedAt);
};
