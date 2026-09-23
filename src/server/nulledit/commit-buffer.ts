import type {
  BranchAcceptedCommit,
  BranchCommitBuffer,
  BranchCommitBufferDecision,
  BranchCommitFlushReason,
  BranchCommitFlushResult,
  InMemoryBranchCommitBufferOptions,
} from "./types";

interface InMemoryBranchCommitState {
  acceptedEventCount: number;
  bufferedEventCount: number;
  bufferedByteCount: number;
  firstBufferedAt: number | null;
  commits: BranchAcceptedCommit[];
}

const branchCommitBufferKey = (
  input: Pick<BranchAcceptedCommit, "rootDropId" | "branchId">,
): string =>
  `${encodeURIComponent(input.rootDropId)}/${encodeURIComponent(input.branchId)}`;

const positiveIntegerOrDefault = (
  value: number | undefined,
  fallback: number,
): number => {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
};

const positiveIntegerOrInfinity = (value: number | undefined): number => {
  if (!Number.isFinite(value) || value === undefined)
    return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(value));
};

const nonNegativeIntegerOrDefault = (
  value: number | undefined,
  fallback: number,
): number => {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(0, Math.floor(value));
};

const estimateBranchCommitBytes = (commit: BranchAcceptedCommit): number =>
  commit.content.length + JSON.stringify(commit.acceptedEvents).length;

/** Creates an in-memory commit buffer with threshold-based hot-branch policy. */
export const createInMemoryBranchCommitBuffer = ({
  thresholds = {},
  now = () => Date.now(),
  estimateCommitBytes = estimateBranchCommitBytes,
}: InMemoryBranchCommitBufferOptions = {}): BranchCommitBuffer => {
  const states = new Map<string, InMemoryBranchCommitState>();
  const hotBranchEventCount = positiveIntegerOrDefault(
    thresholds.hotBranchEventCount,
    2,
  );
  const maxBufferedEventCount = positiveIntegerOrInfinity(
    thresholds.maxBufferedEventCount,
  );
  const maxBufferedBytes = positiveIntegerOrInfinity(
    thresholds.maxBufferedBytes,
  );
  const maxBufferedAgeMs = positiveIntegerOrInfinity(
    thresholds.maxBufferedAgeMs,
  );
  const flushAfterMs = nonNegativeIntegerOrDefault(
    thresholds.flushAfterMs,
    250,
  );
  const branchIdleMs = nonNegativeIntegerOrDefault(
    thresholds.branchIdleMs,
    flushAfterMs,
  );

  const ensureState = (key: string): InMemoryBranchCommitState => {
    const existing = states.get(key);
    if (existing) return existing;
    const next: InMemoryBranchCommitState = {
      acceptedEventCount: 0,
      bufferedEventCount: 0,
      bufferedByteCount: 0,
      firstBufferedAt: null,
      commits: [],
    };
    states.set(key, next);
    return next;
  };

  const flushState = (
    rootDropId: string,
    branchId: string,
    reason: BranchCommitFlushReason,
  ): BranchCommitFlushResult => {
    const key = branchCommitBufferKey({ rootDropId, branchId });
    const state = states.get(key);
    if (!state || !state.commits.length) {
      return {
        rootDropId,
        branchId,
        reason,
        commits: [],
        bufferedEventCount: 0,
        bufferedByteCount: 0,
        latestSnapshotId: null,
      };
    }

    const commits = [...state.commits];
    const result: BranchCommitFlushResult = {
      rootDropId,
      branchId,
      reason,
      commits,
      bufferedEventCount: state.bufferedEventCount,
      bufferedByteCount: state.bufferedByteCount,
      latestSnapshotId: commits[commits.length - 1]?.snapshotId ?? null,
    };
    states.set(key, {
      acceptedEventCount: state.acceptedEventCount,
      bufferedEventCount: 0,
      bufferedByteCount: 0,
      firstBufferedAt: null,
      commits: [],
    });
    return result;
  };

  return {
    appendAcceptedCommit: (commit): BranchCommitBufferDecision => {
      const key = branchCommitBufferKey(commit);
      const state = ensureState(key);
      state.acceptedEventCount += commit.acceptedEvents.length;
      if (
        state.acceptedEventCount < hotBranchEventCount &&
        state.bufferedEventCount === 0
      ) {
        return { mode: "write-through", reason: "cold-branch" };
      }

      const timestamp = now();
      if (state.firstBufferedAt === null) state.firstBufferedAt = timestamp;
      state.commits.push(commit);
      state.bufferedEventCount += commit.acceptedEvents.length;
      state.bufferedByteCount += Math.max(0, estimateCommitBytes(commit));

      const ageMs = timestamp - state.firstBufferedAt;
      const flushReason = flushReasonFromThresholds(
        state,
        ageMs,
        maxBufferedEventCount,
        maxBufferedBytes,
        maxBufferedAgeMs,
      );

      const remainingAgeMs =
        maxBufferedAgeMs === Number.POSITIVE_INFINITY
          ? flushAfterMs
          : Math.max(0, maxBufferedAgeMs - ageMs);

      return {
        mode: "buffer",
        reason: "hot-branch",
        flushAfterMs: flushReason ? 0 : Math.min(branchIdleMs, remainingAgeMs),
        bufferedEventCount: state.bufferedEventCount,
        bufferedByteCount: state.bufferedByteCount,
        flushReason,
      };
    },
    flush: ({ rootDropId, branchId, reason }) =>
      flushState(rootDropId, branchId, reason),
    invalidate: ({ rootDropId, branchId }) => {
      states.delete(branchCommitBufferKey({ rootDropId, branchId }));
    },
  };
};

const flushReasonFromThresholds = (
  state: InMemoryBranchCommitState,
  ageMs: number,
  maxBufferedEventCount: number,
  maxBufferedBytes: number,
  maxBufferedAgeMs: number,
): BranchCommitFlushReason | undefined =>
  state.bufferedEventCount >= maxBufferedEventCount
    ? "event-threshold"
    : state.bufferedByteCount >= maxBufferedBytes
      ? "byte-threshold"
      : ageMs >= maxBufferedAgeMs
        ? "age-threshold"
        : undefined;
