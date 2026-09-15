import {
  isAccountLibraryPage,
  type AccountLibraryPage,
} from "../../../shared/auth/accountLibrary";
import { getAccountAuthHeaders } from "./accountSession";

/** Fetches account-library metadata without reading remote encrypted payloads. */
export const fetchAccountLibrary = async (): Promise<AccountLibraryPage> => {
  const headers = await getAccountAuthHeaders();
  const items: AccountLibraryPage["items"] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const response: Response = await fetch(`/api/account/library${query}`, { headers });
    if (!response.ok) {
      throw new Error("Failed to load the remote library.");
    }
    const page: unknown = await response.json();
    if (!isAccountLibraryPage(page)) {
      throw new Error("The remote library returned an invalid response.");
    }
    items.push(...page.items);
    cursor = page.cursor;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error("The remote library returned an unstable cursor.");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  return { items, cursor: null };
};
