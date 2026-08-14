export interface BranchPromotionIntent {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  idempotencyKey: string;
}

const storageKey = (rootDropId: string, branchId: string): string =>
  `nulldown.branch-promotion:${rootDropId}:${branchId}`;

const isIntent = (value: unknown): value is BranchPromotionIntent => {
  if (!value || typeof value !== "object") return false;
  const intent = value as Record<string, unknown>;
  return (
    typeof intent.rootDropId === "string" &&
    typeof intent.branchId === "string" &&
    Number.isInteger(intent.snapshotId) &&
    (intent.snapshotId as number) >= 0 &&
    typeof intent.idempotencyKey === "string"
  );
};

/** Reads a pending promotion request pair retained across a browser reload. */
export const readBranchPromotionIntent = (
  rootDropId: string,
  branchId: string,
): BranchPromotionIntent | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(rootDropId, branchId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isIntent(parsed) &&
      parsed.rootDropId === rootDropId &&
      parsed.branchId === branchId
      ? parsed
      : null;
  } catch {
    return null;
  }
};

/** Persists a promotion request pair before its first network submission. */
export const writeBranchPromotionIntent = (intent: BranchPromotionIntent): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(intent.rootDropId, intent.branchId),
      JSON.stringify(intent),
    );
  } catch {
    // The server-side receipt remains authoritative if browser storage is unavailable.
  }
};

/** Removes a request pair only after a confirmed response or stale-head conflict. */
export const clearBranchPromotionIntent = (
  rootDropId: string,
  branchId: string,
): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(rootDropId, branchId));
  } catch {
    // A later retry safely reuses the server-side receipt when cleanup cannot persist.
  }
};
