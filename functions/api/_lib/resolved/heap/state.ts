import {
  readResolvedNulldownState,
  writeResolvedNulldownState,
} from "../../../../../shared/drop/resolved/storage";
import type { ResolvedNulldownState } from "../../../../../shared/drop/resolved/types";
import { createResolvedHeapRepository } from "./repository";
import type { ResolvedHeapEnv } from "./types";
import { createResolvedHeapDataKey } from "../../../../../src/server/nulledit/dataKeys/resolved";
import { isResolvedNulldownState } from "../../../../../shared/drop/resolved/validators";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_DOCUMENT_RESOLVER_VERSION,
} from "../../../../../shared/drop/resolved/constants";

/** Checks a document projection against independently established snapshot identity. */
export const isCurrentResolvedDocumentProjection = (
  state: unknown,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  sourceContentHash: string,
): state is ResolvedNulldownState =>
  isResolvedNulldownState(state) &&
  state.rootDropId === rootDropId &&
  state.branchId === branchId &&
  state.snapshotId === snapshotId &&
  state.resolverId === RESOLVED_DOCUMENT_RESOLVER_ID &&
  state.resolverVersion === RESOLVED_DOCUMENT_RESOLVER_VERSION &&
  state.sourceContentHash === sourceContentHash &&
  Array.isArray(state.documentNodes);

/** Returns the source event sequence range represented by the branch head. */
export const sourceSeqRangeForHead = (
  headEventSeq: number | null | undefined,
): { from: number; to: number } | undefined =>
  typeof headEventSeq === "number" && headEventSeq >= 0
    ? { from: 0, to: headEventSeq }
    : undefined;

/** Reuses a source-validated document snapshotter heap, then falls back to SQL/R2. */
export const readResolvedHeapState = async (
  env: ResolvedHeapEnv,
  rootDropId: string,
  branchId: string,
  resolverId: string,
  snapshotId: number,
  sourceContentHash?: string,
): Promise<ResolvedNulldownState | null> => {
  if (
    env.resolvedDocumentData &&
    sourceContentHash &&
    resolverId === RESOLVED_DOCUMENT_RESOLVER_ID
  ) {
    // This optional derived store must not prevent legacy reads or query repair.
    const state = await env.resolvedDocumentData
      .get(createResolvedHeapDataKey({ rootDropId, branchId, resolverId, snapshotId }))
      .catch(() => null);
    if (
      isCurrentResolvedDocumentProjection(state, rootDropId, branchId, snapshotId, sourceContentHash)
    ) {
      return state;
    }
  }
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
