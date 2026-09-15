/** Metadata-safe visibility values returned by account-library discovery. */
export type AccountLibraryVisibility = "private" | "unlisted" | "public";

/** A live remote drop discoverable by one of the user's bound accounts. */
export interface AccountLibraryActiveEntry {
  state: "active";
  id: string;
  visibility: AccountLibraryVisibility;
  createdAt: number;
  updatedAt: number;
}

/** A retained deletion marker used to converge remote-library views. */
export interface AccountLibraryDeletedEntry {
  state: "deleted";
  id: string;
  deletedAt: number;
}

/** A metadata-only account-library item. */
export type AccountLibraryEntry =
  | AccountLibraryActiveEntry
  | AccountLibraryDeletedEntry;

/** A stable page of account-library items. */
export interface AccountLibraryPage {
  items: AccountLibraryEntry[];
  cursor: string | null;
}

/** Validates a metadata-only account-library response. */
export const isAccountLibraryPage = (value: unknown): value is AccountLibraryPage => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const page = value as { items?: unknown; cursor?: unknown };
  if (!Array.isArray(page.items)) return false;
  if (page.cursor !== null && typeof page.cursor !== "string") return false;

  return page.items.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string") return false;
    if (item.state === "deleted") {
      return (
        Object.keys(item).every((key) => ["state", "id", "deletedAt"].includes(key)) &&
        typeof item.deletedAt === "number"
      );
    }
    return (
      item.state === "active" &&
      Object.keys(item).every((key) =>
        ["state", "id", "visibility", "createdAt", "updatedAt"].includes(key),
      ) &&
      (item.visibility === "private" ||
        item.visibility === "unlisted" ||
        item.visibility === "public") &&
      typeof item.createdAt === "number" &&
      typeof item.updatedAt === "number"
    );
  });
};
