import { toShortDropId } from "../../../../shared/drop/id";

export const OFFLINE_DROP_PREFIX = "offline_";

/** Builds a share URL for a canonical drop id. */
export const buildDropUrl = (id: string) => {
  const linkId = toShortDropId(id);

  if (typeof window === "undefined") {
    return `/d/${linkId}`;
  }

  return `${window.location.origin}/d/${linkId}`;
};

/** Returns true for local-only offline drop ids. */
export const isOfflineDropId = (id: string) =>
  id.startsWith(OFFLINE_DROP_PREFIX);
