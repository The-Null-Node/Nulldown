import { useCallback, useState } from "react";
import { useTheme } from "../../../theme/themeContext";
import useDropStore, {
  type DropPayload,
} from "../../../stores/dropStore";

export function useShareDrop(
  markdown: string,
  clearDraft: () => void | Promise<unknown>,
  snapshotMeta?: { baseDropId?: string | null; snapshotId?: number | null },
) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successUrl, setSuccessUrl] = useState<string | null>(null);
  const [successOffline, setSuccessOffline] = useState(false);
  const { themeId } = useTheme();
  const createDrop = useDropStore((state) => state.createDrop);
  const hydrateOfflineMode = useDropStore((state) => state.hydrateOfflineMode);

  const resetShare = useCallback(() => {
    setSuccessUrl(null);
    setSuccessOffline(false);
    setError(null);
  }, []);

  const shareDrop = useCallback(async () => {
    if (!markdown.trim()) {
      setError("Cannot share empty content.");
      return;
    }

    setSharing(true);
    setError(null);
    setSuccessUrl(null);
    setSuccessOffline(false);

    try {
      await hydrateOfflineMode();

      const payload: DropPayload = {
        content: markdown,
        metadata: {
          themeId,
          baseDropId: snapshotMeta?.baseDropId ?? undefined,
          snapshotId: snapshotMeta?.snapshotId ?? undefined,
        },
      };

      const result = await createDrop(payload);
      setSuccessUrl(result.url);
      setSuccessOffline(result.scope === "local");
      await Promise.resolve(clearDraft());
    } catch (err: any) {
      console.error("Share error:", err);
      setError(err.message || "An unexpected error occurred while sharing.");
    } finally {
      setSharing(false);
    }
  }, [
    clearDraft,
    createDrop,
    hydrateOfflineMode,
    markdown,
    snapshotMeta?.baseDropId,
    snapshotMeta?.snapshotId,
    themeId,
  ]);

  return {
    error,
    resetShare,
    setError,
    shareDrop,
    sharing,
    successUrl,
    successOffline,
  };
}
