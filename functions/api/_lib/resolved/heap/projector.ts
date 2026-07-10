import { listNullplugRuntimeFacts } from "../../nullplug/facts/repository";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../../../../../shared/drop/resolved/constants";
import { heapifyResolvedDocument } from "../../../../../shared/drop/resolved/heapify/document";
import { heapifyResolvedRuntimeRefs } from "../../../../../shared/drop/resolved/heapify/runtimeRefs";
import type { ResolvedNulldownState } from "../../../../../shared/drop/resolved/types";
import {
  readResolvedHeapState,
  sourceSeqRangeForHead,
  writeResolvedHeapState,
} from "./state";
import type { ResolvedHeapEnv, ResolvedUpdateRequest } from "./types";

/** Resolver ids that the branch-scoped resolved heap projector can build. */
export type ResolvedProjectableResolverId =
  | typeof RESOLVED_DOCUMENT_RESOLVER_ID
  | typeof RESOLVED_RUNTIME_REFS_RESOLVER_ID;

/** Source inputs used to project a resolved heap for one branch snapshot. */
export interface ResolvedHeapProjectionSource {
  /** Canonical root drop id for the branch. */
  rootDropId: string;
  /** Branch id being projected. */
  branchId: string;
  /** Snapshot id being projected. */
  snapshotId: number;
  /** Branch head event sequence used to derive source sequence range metadata. */
  headEventSeq?: number | null;
  /** Snapshot content to heapify. */
  content: string;
}

/** Result of writing one projected resolved heap. */
export interface ResolvedHeapProjectionWrite {
  /** Projected resolved heap state. */
  state: ResolvedNulldownState;
  /** R2 key where the full resolved state was written. */
  key: string;
}

/** Result of reading or regenerating one resolved heap projection. */
export interface ResolvedHeapProjectionRead {
  /** Existing or regenerated resolved heap state. */
  state: ResolvedNulldownState | null;
  /** Whether the state was regenerated during the read. */
  heapGenerated: boolean;
  /** Whether the returned state is stale against the supplied source hash. */
  stale: boolean;
}

/** Builds and stores a document resolved heap projection. */
export const projectResolvedDocumentHeap = async (
  env: ResolvedHeapEnv,
  source: ResolvedHeapProjectionSource,
): Promise<ResolvedHeapProjectionWrite> => {
  const state = await heapifyResolvedDocument({
    rootDropId: source.rootDropId,
    branchId: source.branchId,
    snapshotId: source.snapshotId,
    sourceSeqRange: sourceSeqRangeForHead(source.headEventSeq),
    content: source.content,
  });
  const key = await writeResolvedHeapState(env, state);
  return { state, key };
};

/** Builds and stores a runtime refs resolved heap projection. */
export const projectResolvedRuntimeRefsHeap = async (
  env: ResolvedHeapEnv,
  source: ResolvedHeapProjectionSource,
  update: ResolvedUpdateRequest = {},
): Promise<ResolvedHeapProjectionWrite> => {
  const runtimeFacts = await listNullplugRuntimeFacts(
    env.R2_BUCKET,
    source.rootDropId,
    source.branchId,
    env.DB,
  );
  const state = await heapifyResolvedRuntimeRefs({
    rootDropId: source.rootDropId,
    branchId: source.branchId,
    snapshotId: source.snapshotId,
    sourceSeqRange: sourceSeqRangeForHead(source.headEventSeq),
    content: source.content,
    uiPrimitives: update.uiPrimitives,
    uiResponseFacts: [
      ...runtimeFacts.uiResponseFacts,
      ...(update.uiResponseFacts ?? []),
    ],
    uiStatePatchFacts: [
      ...runtimeFacts.uiStatePatchFacts,
      ...(update.uiStatePatchFacts ?? []),
    ],
    uiStateSnapshots: [
      ...runtimeFacts.uiStateSnapshots,
      ...(update.uiStateSnapshots ?? []),
    ],
  });
  const key = await writeResolvedHeapState(env, state);
  return { state, key };
};

/** Builds and stores one supported resolved heap projection. */
export const projectResolvedHeap = async (
  env: ResolvedHeapEnv,
  resolverId: ResolvedProjectableResolverId,
  source: ResolvedHeapProjectionSource,
  update?: ResolvedUpdateRequest,
): Promise<ResolvedHeapProjectionWrite> => {
  if (resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID) {
    return projectResolvedRuntimeRefsHeap(env, source, update);
  }

  return projectResolvedDocumentHeap(env, source);
};

/** Reads a projection and regenerates supported stale or missing projections. */
export const ensureResolvedHeapProjection = async (
  env: ResolvedHeapEnv,
  resolverId: string,
  source: ResolvedHeapProjectionSource,
  sourceContentHash: string,
): Promise<ResolvedHeapProjectionRead> => {
  let state = await readResolvedHeapState(
    env,
    source.rootDropId,
    source.branchId,
    resolverId,
    source.snapshotId,
  );
  let heapGenerated = false;
  let stale = Boolean(state && state.sourceContentHash !== sourceContentHash);

  if (
    (!state || stale) &&
    (resolverId === RESOLVED_DOCUMENT_RESOLVER_ID ||
      resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID)
  ) {
    state = (await projectResolvedHeap(env, resolverId, source)).state;
    heapGenerated = true;
    stale = false;
  }

  return { state, heapGenerated, stale };
};
