import {
  readResolvedNulldownState,
  writeResolvedNulldownState,
} from "../../../../../shared/drop/resolved/storage";
import type { ResolvedNulldownState } from "../../../../../shared/drop/resolved/types";
import { createResolvedHeapRepository } from "./repository";
import type { ResolvedHeapEnv } from "./types";

/** Returns the source event sequence range represented by the branch head. */
export const sourceSeqRangeForHead = (
  headEventSeq: number | null | undefined,
): { from: number; to: number } | undefined =>
  typeof headEventSeq === "number" && headEventSeq >= 0
    ? { from: 0, to: headEventSeq }
    : undefined;

/** Reads resolved heap state from compact SQL projection first, then R2 fallback. */
export const readResolvedHeapState = async (
  env: ResolvedHeapEnv,
  rootDropId: string,
  branchId: string,
  resolverId: string,
  snapshotId: number,
): Promise<ResolvedNulldownState | null> => {
  if (env.DB) {
    const state = await createResolvedHeapRepository({
      sql: env.DB,
    }).readState(rootDropId, branchId, resolverId, snapshotId);
    if (state) return state;
  }

  return readResolvedNulldownState(
    env.R2_BUCKET,
    rootDropId,
    branchId,
    resolverId,
    snapshotId,
  );
};

/** Writes resolved heap state to R2 and synchronizes compact SQL projections. */
export const writeResolvedHeapState = async (
  env: ResolvedHeapEnv,
  state: ResolvedNulldownState,
): Promise<string> => {
  const key = await writeResolvedNulldownState(env.R2_BUCKET, state);
  await createResolvedHeapRepository({ sql: env.DB }).syncState(state);
  return key;
};
