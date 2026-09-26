import useStorageStore from "../../stores/storage-store";
import { nanoid } from "nanoid";
import { upsertDraftLibraryEntry } from "../../lib/draft/library";

/** Saves the departing route before navigating to a distinct, empty draft lifetime. */
export function startNewDraft(options: {
  draftKey: string;
  content: string;
  dropId: string | null;
  navigate: (url: string) => void;
}): void {
  const saved = useStorageStore
    .getState()
    .setItem(options.draftKey, options.content);
  if (!saved.success)
    throw new Error(saved.error ?? "Unable to save the current draft.");
  upsertDraftLibraryEntry(options.draftKey, options.content, {
    dropId: options.dropId,
  });
  options.navigate(`/?draft=${encodeURIComponent(nanoid())}`);
}
