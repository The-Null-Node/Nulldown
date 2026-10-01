import type { OwnedDropRecord } from "../../stores/drop-store";
import type { DraftLibraryEntry } from "../../lib/draft/library";
import type { RecentExternalDropRecord } from "../../lib/drop/recent-external-drops";
import type { AccountLibraryEntry } from "../../../shared/auth/account-library";
import type { Searchable, SearchableGroup } from "../../lib/search/searchable";
import { toShortDropId } from "../../../shared/drop/id";

/** Data-only palette intent; the active editor route owns execution. */
export type PaletteAction =
  | { kind: "open-drop"; id: string; source: "owned" | "external" | "remote" }
  | { kind: "open-draft"; entry: DraftLibraryEntry }
  | {
      kind: "insert-block";
      snippet: string;
      selectionStartOffset: number;
      selectionEndOffset: number;
    }
  | { kind: "new-drop" }
  | { kind: "refresh-search" };

/** Read-model snapshot retained by one mounted editor library. */
export interface EditorLibrarySnapshot {
  drafts: DraftLibraryEntry[];
  drops: OwnedDropRecord[];
  externalDrops: RecentExternalDropRecord[];
  remoteEntries: AccountLibraryEntry[];
}

const formatTimestamp = (timestamp: number) => {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "Unknown";
  }
};

/** Derives palette groups without loading data or executing session commands. */
export function deriveLibraryGroups(
  library: EditorLibrarySnapshot,
): SearchableGroup<PaletteAction>[] {
  const drafts: Searchable<PaletteAction>[] = library.drafts.map((entry) => ({
    id: `draft-${entry.draftKey}`,
    type: "draft",
    title: entry.title,
    description: `${entry.preview} • Updated ${formatTimestamp(entry.updatedAt)}`,
    keywords: [entry.draftId, entry.dropId ?? ""],
    value: { kind: "open-draft", entry },
  }));
  const ownedIds = new Set(library.drops.map((entry) => entry.id));
  const owned: Searchable<PaletteAction>[] = library.drops.map((entry) => {
    const shortId = toShortDropId(entry.id);
    return {
      id: `drop-owned-${entry.id}`,
      type: "drop",
      title: `Nulldown ${shortId}`,
      description: `Owned • ${entry.visibility} • Updated ${formatTimestamp(entry.updatedAt)}`,
      keywords: [entry.id, shortId, "owned", "edit", entry.visibility],
      value: { kind: "open-drop", id: entry.id, source: "owned" },
    };
  });
  const external: Searchable<PaletteAction>[] = library.externalDrops
    .filter((entry) => !ownedIds.has(entry.id))
    .map((entry) => ({
      id: `drop-external-${entry.id}`,
      type: "drop",
      title: entry.title,
      description: entry.preview
        ? `${entry.preview} • External • Viewed ${formatTimestamp(entry.updatedAt)}`
        : `External • Viewed ${formatTimestamp(entry.updatedAt)}`,
      keywords: [entry.id, toShortDropId(entry.id), "external", "view"],
      value: { kind: "open-drop", id: entry.id, source: "external" },
    }));
  const remote: Searchable<PaletteAction>[] = library.remoteEntries
    .filter((entry) => entry.state === "active")
    .map((entry) => {
      const shortId = toShortDropId(entry.id);
      return {
        id: `drop-remote-${entry.id}`,
        type: "drop",
        title: `Nulldown ${shortId}`,
        description: `Remote library • ${entry.visibility} • Updated ${formatTimestamp(entry.updatedAt)}`,
        keywords: [entry.id, shortId, "remote", "library", entry.visibility],
        value: { kind: "open-drop", id: entry.id, source: "remote" },
      };
    });
  return [
    { id: "drafts", label: "Drafts", entities: drafts },
    { id: "drops", label: "Drops", entities: [...owned, ...external] },
    { id: "remote-library", label: "Remote Library", entities: remote },
  ].filter((group) => group.entities.length > 0);
}
