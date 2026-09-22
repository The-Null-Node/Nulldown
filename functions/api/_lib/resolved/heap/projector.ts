import { listNullplugRuntimeFacts } from "../../nullplug/facts/repository";
import { createBranchRuntimeFactLogRepository } from "../../branches/storage/runtime-fact-log";
import { withBranchMutationLock } from "../../branches/storage/mutation-lock";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_VERSION,
} from "../../../../../shared/drop/resolved/constants";
import { heapifyResolvedDocument } from "../../../../../shared/drop/resolved/heapify/document";
import { heapifyResolvedRuntimeRefs } from "../../../../../shared/drop/resolved/heapify/runtime-refs";
import type { ResolvedNulldownState } from "../../../../../shared/drop/resolved/types";
import {
  isCurrentResolvedDocumentProjection,
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
  const runtimeFactRepository = createBranchRuntimeFactLogRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const headBeforeRead = await runtimeFactRepository.readBranchHeadRuntimeFactSeq(
    source.rootDropId,
    source.branchId,
  );
  const runtimeFacts = await listNullplugRuntimeFacts(
    env.R2_BUCKET,
    source.rootDropId,
    source.branchId,
    env.DB,
  );
  const headAfterRead = await runtimeFactRepository.readBranchHeadRuntimeFactSeq(
    source.rootDropId,
    source.branchId,
  );
  // A concurrent append may be present in the fact list, but an older cursor is safe:
  // the next query will observe the newer head and regenerate instead of missing data.
  const runtimeFactHeadSeq =
    headBeforeRead === headAfterRead ? headAfterRead : headBeforeRead;
  const state = await heapifyResolvedRuntimeRefs({
    rootDropId: source.rootDropId,
    branchId: source.branchId,
    snapshotId: source.snapshotId,
    sourceSeqRange: sourceSeqRangeForHead(runtimeFactHeadSeq),
    content: source.content,
    uiPrimitives: update.uiPrimitives,
    uiResponseFacts: runtimeFacts.uiResponseFacts,
    uiStatePatchFacts: runtimeFacts.uiStatePatchFacts,
    uiStateSnapshots: runtimeFacts.uiStateSnapshots,
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
    return withBranchMutationLock(
      env.R2_BUCKET,
      source.rootDropId,
      source.branchId,
      async (lock) => {
        await lock.beginCommit();
        return await projectResolvedRuntimeRefsHeap(env, source, update);
      },
    );
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
    sourceContentHash,
  );
  let heapGenerated = false;
  let stale = Boolean(state && state.sourceContentHash !== sourceContentHash);
  if (resolverId === RESOLVED_DOCUMENT_RESOLVER_ID) {
    stale ||= Boolean(
      state && !isCurrentResolvedDocumentProjection(
        state, source.rootDropId, source.branchId, source.snapshotId, sourceContentHash,
      ),
    );
  }
  if (resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID) {
    const runtimeFactHeadSeq = await createBranchRuntimeFactLogRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    }).readBranchHeadRuntimeFactSeq(source.rootDropId, source.branchId);
    stale ||= Boolean(
      state && (state.sourceSeqRange?.to ?? -1) !== runtimeFactHeadSeq,
    );
    stale ||= Boolean(
      state && state.resolverVersion !== RESOLVED_RUNTIME_REFS_RESOLVER_VERSION,
    );
  }

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
