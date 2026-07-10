import { dropResolvedHeapKey } from "../sidecar";
import type { ResolvedHeapJsonStore, ResolvedNulldownState } from "./types";
import { isResolvedNulldownState } from "./validators";

export const readResolvedNulldownState = async (
  store: ResolvedHeapJsonStore,
  rootDropId: string,
  branchId: string,
  resolverId: string,
  snapshotId: number,
): Promise<ResolvedNulldownState | null> => {
  const object = await store.get(
    dropResolvedHeapKey(rootDropId, branchId, resolverId, snapshotId),
  );
  if (!object) return null;
  try {
    const parsed = await object.json();
    return isResolvedNulldownState(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeResolvedNulldownState = async (
  store: ResolvedHeapJsonStore,
  state: ResolvedNulldownState,
): Promise<string> => {
  if (!isResolvedNulldownState(state)) {
    throw new Error("Invalid resolved Nulldown state.");
  }
  if (!state.branchId || state.snapshotId === undefined) {
    throw new Error("Resolved heap storage requires branchId and snapshotId.");
  }

  const key = dropResolvedHeapKey(
    state.rootDropId,
    state.branchId,
    state.resolverId,
    state.snapshotId,
  );
  await store.put(key, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  });
  return key;
};
