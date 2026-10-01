/*
Sharing always flows through the drop store so mode, visibility, unlock policy, and
draft-pack behavior are derived from the same settings the rest of the editor uses.
This hook prepares the payload and reports UI state; it does not talk to providers directly.
*/

import { useCallback, useState } from "react";
import type {
  DropDraftPack,
  DropDraftDiffPolicy,
} from "../../../../shared/drop/types";
import { useTheme } from "../../../theme/theme-context";
import useDropStore, { type DropPayload } from "../../../stores/drop-store";
import { toUserFacingDropError } from "../../../lib/drop/user-errors";

export function useShareDrop(
  markdown: string,
  clearDraft: () => void | Promise<unknown>,
  snapshotMeta?: {
    isActive?: () => boolean;
    canShare?: boolean;
    baseDropId?: string | null;
    rootDropId?: string | null;
    existingDropId?: string | null;
    snapshotId?: number | null;
    buildDraftPack?: (policy: DropDraftDiffPolicy) => DropDraftPack | undefined;
    publishBranch?: () => Promise<{ url: string; offline?: boolean }>;
  },
) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successUrl, setSuccessUrl] = useState<string | null>(null);
  const [successOffline, setSuccessOffline] = useState(false);
  const [successKind, setSuccessKind] = useState<"share" | "branch">("share");
  const { themeId } = useTheme();
  const createDrop = useDropStore((state) => state.createDrop);
  const hydrateSharePreferences = useDropStore(
    (state) => state.hydrateSharePreferences,
  );

  const resetShare = useCallback(() => {
    setSuccessUrl(null);
    setSuccessOffline(false);
    setSuccessKind("share");
    setError(null);
  }, []);

  const shareDrop = useCallback(async () => {
    const active = () => snapshotMeta?.isActive?.() ?? true;
    if (!active()) return;
    if (snapshotMeta?.canShare === false) {
      setError("Wait for the editor to finish loading before sharing.");
      return;
    }
    if (!markdown.trim()) {
      setError("Cannot share empty content.");
      return;
    }

    setSharing(true);
    setError(null);
    setSuccessUrl(null);
    setSuccessOffline(false);

    try {
      await hydrateSharePreferences();
      if (!active()) return;
      const { allowedUrls, draftDiffPolicy } = useDropStore.getState();

      if (snapshotMeta?.publishBranch) {
        const result = await snapshotMeta.publishBranch();
        if (!active()) return;
        setSuccessUrl(result.url);
        setSuccessOffline(Boolean(result.offline));
        setSuccessKind("branch");
        await Promise.resolve(clearDraft());
        return;
      }

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
      // Existing drops keep edit lineage by default; brand-new shares only include it when policy says so.
      const draftPack = shouldPersistDraftPack
        ? snapshotMeta?.buildDraftPack?.(draftDiffPolicy)
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
      if (!active()) return;
      setSuccessUrl(result.url);
      setSuccessOffline(result.scope === "local");
      setSuccessKind("share");
      await Promise.resolve(clearDraft());
    } catch (err: unknown) {
      if (!active()) return;
      console.error("Share error:", err);
      setError(
        toUserFacingDropError(
          err,
          "An unexpected error occurred while sharing.",
        ),
      );
    } finally {
      if (active()) setSharing(false);
    }
  }, [
    clearDraft,
    createDrop,
    hydrateSharePreferences,
    snapshotMeta?.existingDropId,
    markdown,
    snapshotMeta?.baseDropId,
    snapshotMeta?.rootDropId,
    snapshotMeta?.buildDraftPack,
    snapshotMeta?.publishBranch,
    snapshotMeta?.snapshotId,
    snapshotMeta?.isActive,
    snapshotMeta?.canShare,
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
    successKind,
  };
}
