import { useCallback, useState } from "react";
import type { DropDraftPackV1 } from "../../../../shared/drop/types";
import { useTheme } from "../../../theme/themeContext";
import useDropStore, {
  type DropPayload,
} from "../../../stores/dropStore";
import { toUserFacingDropError } from "../../../lib/drop/userErrors";

export function useShareDrop(
  markdown: string,
  clearDraft: () => void | Promise<unknown>,
  snapshotMeta?: {
    baseDropId?: string | null;
    rootDropId?: string | null;
    existingDropId?: string | null;
    snapshotId?: number | null;
    buildDraftPack?: () => DropDraftPackV1 | undefined;
  },
) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successUrl, setSuccessUrl] = useState<string | null>(null);
  const [successOffline, setSuccessOffline] = useState(false);
  const { themeId } = useTheme();
  const createDrop = useDropStore((state) => state.createDrop);
  const hydrateOfflineMode = useDropStore((state) => state.hydrateOfflineMode);
  const hydrateSharePreferences = useDropStore(
    (state) => state.hydrateSharePreferences,
  );
  const allowedUrls = useDropStore((state) => state.allowedUrls);
  const draftDiffPolicy = useDropStore((state) => state.draftDiffPolicy);

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
      await hydrateSharePreferences();

      const payload: DropPayload = {
        content: markdown,
        metadata: {
          themeId,
          baseDropId: snapshotMeta?.baseDropId ?? undefined,
          rootDropId: snapshotMeta?.rootDropId ?? undefined,
          snapshotId: snapshotMeta?.snapshotId ?? undefined,
          allowedUrls,
        },
      };

      const shouldPersistDraftPack =
        draftDiffPolicy === "always" ||
        Boolean(snapshotMeta?.existingDropId ?? snapshotMeta?.baseDropId);
      const draftPack = shouldPersistDraftPack
        ? snapshotMeta?.buildDraftPack?.()
        : undefined;

      if (draftPack) {
        payload.draftPack = draftPack;
      }

      const result = await createDrop(
        payload,
        snapshotMeta?.existingDropId
          ? {
              id: snapshotMeta.existingDropId,
              upsert: true,
            }
          : undefined,
      );
      setSuccessUrl(result.url);
      setSuccessOffline(result.scope === "local");
      await Promise.resolve(clearDraft());
    } catch (err: unknown) {
      console.error("Share error:", err);
      setError(
        toUserFacingDropError(
          err,
          "An unexpected error occurred while sharing.",
        ),
      );
    } finally {
      setSharing(false);
    }
  }, [
    clearDraft,
    createDrop,
    allowedUrls,
    draftDiffPolicy,
    hydrateOfflineMode,
    hydrateSharePreferences,
    snapshotMeta?.existingDropId,
    markdown,
    snapshotMeta?.baseDropId,
    snapshotMeta?.rootDropId,
    snapshotMeta?.buildDraftPack,
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
