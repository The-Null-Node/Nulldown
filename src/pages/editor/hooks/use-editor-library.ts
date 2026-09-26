import { useCallback, useEffect, useRef, useState } from "react";
import useDropStore from "../../../stores/drop-store";
import { listDraftLibraryEntries } from "../../../lib/draft/library";
import { listRecentExternalDrops } from "../../../lib/drop/recent-external-drops";
import { fetchAccountLibrary } from "../../../lib/auth/account-library-client";
import type { AccountLibraryEntry } from "../../../../shared/auth/account-library";
import type { EditorLibrarySnapshot } from "../library-items";

/** Owns library reads for one mounted route; only the latest refresh may commit. */
export function useEditorLibrary(open: boolean) {
  const listOwnedDrops = useDropStore((state) => state.listOwnedDrops);
  const [library, setLibrary] = useState<EditorLibrarySnapshot>({
    drafts: [],
    drops: [],
    externalDrops: [],
    remoteEntries: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const token = ++generation.current;
    const current = () => mounted.current && token === generation.current;
    setLoading(true);
    let localError: string | null = null;
    try {
      const [drops, drafts, externalDrops] = await Promise.all([
        listOwnedDrops(),
        Promise.resolve(listDraftLibraryEntries()),
        Promise.resolve(listRecentExternalDrops()),
      ]);
      if (!current()) return;
      setLibrary((previous) => ({ ...previous, drops, drafts, externalDrops }));
    } catch (error) {
      if (!current()) return;
      console.error("Failed to load library:", error);
      localError =
        "Unable to refresh local library entries. Existing results are still available.";
    }
    try {
      const remote = await fetchAccountLibrary();
      if (!current()) return;
      const active = new Map<string, AccountLibraryEntry>();
      for (const entry of remote.items) {
        if (entry.state === "deleted") active.delete(entry.id);
        else active.set(entry.id, entry);
      }
      setLibrary((previous) => ({
        ...previous,
        remoteEntries: [...active.values()],
      }));
      setError(localError);
    } catch (error) {
      if (!current()) return;
      console.error("Failed to load remote library:", error);
      setError(
        localError ??
          "Unable to refresh Remote Library. Existing results are still available.",
      );
    } finally {
      if (current()) setLoading(false);
    }
  }, [listOwnedDrops]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  return { library, loading, error, refresh };
}
