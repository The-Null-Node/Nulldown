import type { VoidBlobStore } from "../../../../../src/server/ports";
import { createBranchLockKey } from "./keys";

const BRANCH_LOCK_MAX_ATTEMPTS = 120;
const BRANCH_LOCK_BASE_BACKOFF_MS = 8;
const BRANCH_LOCK_STALE_MS = 300_000;
const BRANCH_LOCK_RENEW_MS = 10_000;

interface BranchLockPayload {
  token: string;
  createdAt: number;
  releasedAt?: number;
}

interface BranchLockLease {
  key: string;
  token: string;
  etag?: string;
}

interface ReadBranchLock {
  payload: BranchLockPayload | null;
  etag?: string;
}

type BranchLockReleaseOutcome = "released" | "not_held" | "unknown";
type BranchLockOwnershipOutcome = "held" | "not_held" | "unknown";

/** Public outcome carried by branch mutation lock failures. */
export type BranchMutationLockOutcome = "not_committed" | "unknown";

/** Structured warning emitted when a completed mutation cannot confirm lease cleanup. */
export interface BranchMutationLockCleanupWarning {
  code: "branch_mutation_lock_cleanup_unconfirmed";
  outcome: "committed_with_cleanup_warning";
  rootDropId: string;
  branchId: string;
  releaseOutcome: Exclude<BranchLockReleaseOutcome, "released">;
}

/** Structured error raised when a branch mutation cannot safely report success. */
export class BranchMutationLockError extends Error {
  readonly code:
    | "branch_lock_timeout"
    | "branch_lock_lost_before_commit"
    | "branch_mutation_outcome_unknown";
  readonly outcome: BranchMutationLockOutcome;

  constructor(input: {
    code:
      | "branch_lock_timeout"
      | "branch_lock_lost_before_commit"
      | "branch_mutation_outcome_unknown";
    outcome: BranchMutationLockOutcome;
  }) {
    super(input.code);
    this.name = "BranchMutationLockError";
    this.code = input.code;
    this.outcome = input.outcome;
  }
}

/** Lease controls exposed to mutation callbacks. */
export interface BranchMutationLockContext {
  /** Proves current ownership immediately before the caller's authoritative write. */
  beginCommit(): Promise<void>;
}

const objectEtag = (object: {
  etag?: string;
  httpEtag?: string;
} | null): string | undefined => object?.etag ?? object?.httpEtag;

const readText = async (
  object: { text: () => Promise<string> } | null,
): Promise<string | null> => {
  if (!object) return null;
  try {
    return await object.text();
  } catch {
    return null;
  }
};

const sleep = async (durationMs: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
};

const randomJitter = (): number => {
  const bytes = crypto.getRandomValues(new Uint8Array(1));
  return bytes[0] % 10;
};

const parseBranchLockPayload = (
  value: string | null,
): BranchLockPayload | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { token?: unknown }).token === "string" &&
      typeof (parsed as { createdAt?: unknown }).createdAt === "number"
    ) {
      return {
        token: (parsed as { token: string }).token,
        createdAt: (parsed as { createdAt: number }).createdAt,
        ...(typeof (parsed as { releasedAt?: unknown }).releasedAt === "number"
          ? { releasedAt: (parsed as { releasedAt: number }).releasedAt }
          : {}),
      };
    }
  } catch {
    // Malformed payloads are eligible for ETag-guarded stale takeover.
  }
  return null;
};

const lockBody = (token: string, released = false): string =>
  JSON.stringify({
    token,
    createdAt: Date.now(),
    ...(released ? { releasedAt: Date.now() } : {}),
  });

const readBranchLock = async (
  bucket: VoidBlobStore,
  key: string,
): Promise<ReadBranchLock> => {
  const object = await bucket.get(key);
  return {
    payload: parseBranchLockPayload(await readText(object)),
    etag: objectEtag(object),
  };
};

const recoverOwnedLease = async (
  bucket: VoidBlobStore,
  lock: BranchLockLease,
): Promise<BranchLockOwnershipOutcome> => {
  try {
    const current = await readBranchLock(bucket, lock.key);
    if (
      current.payload?.token !== lock.token ||
      current.payload.releasedAt !== undefined ||
      !current.etag
    ) {
      return "not_held";
    }
    lock.etag = current.etag;
    return "held";
  } catch {
    return "unknown";
  }
};

const acquireBranchMutationLock = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
): Promise<BranchLockLease> => {
  const key = createBranchLockKey(rootDropId, branchId);
  const token = crypto.randomUUID();
  const lock = { key, token } satisfies BranchLockLease;

  for (let attempt = 0; attempt < BRANCH_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const acquired = await bucket.put(key, lockBody(token), {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (acquired) {
        return { ...lock, etag: objectEtag(acquired) };
      }
    } catch {
      if ((await recoverOwnedLease(bucket, lock)) === "held") return lock;
    }

    const existing = await readBranchLock(bucket, key);
    const isReleased = existing.payload?.releasedAt !== undefined;
    const isStale =
      !existing.payload || Date.now() - existing.payload.createdAt > BRANCH_LOCK_STALE_MS;
    if ((isReleased || isStale) && existing.etag) {
      try {
        const replaced = await bucket.put(key, lockBody(token), {
          httpMetadata: { contentType: "application/json" },
          onlyIf: { etagMatches: existing.etag },
        });
        if (replaced) {
          return { ...lock, etag: objectEtag(replaced) };
        }
      } catch {
        if ((await recoverOwnedLease(bucket, lock)) === "held") return lock;
      }
      continue;
    }

    const backoff =
      BRANCH_LOCK_BASE_BACKOFF_MS + Math.min(attempt, 15) * 3 + randomJitter();
    await sleep(backoff);
  }

  throw new BranchMutationLockError({
    code: "branch_lock_timeout",
    outcome: "not_committed",
  });
};

const renewBranchMutationLock = async (
  bucket: VoidBlobStore,
  lock: BranchLockLease,
): Promise<BranchLockOwnershipOutcome> => {
  try {
    const current = await readBranchLock(bucket, lock.key);
    if (
      current.payload?.token !== lock.token ||
      current.payload.releasedAt !== undefined ||
      !current.etag
    ) {
      return "not_held";
    }
    const renewed = await bucket.put(lock.key, lockBody(lock.token), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: current.etag },
    });
    if (!renewed) return await recoverOwnedLease(bucket, lock);
    lock.etag = objectEtag(renewed) ?? current.etag;
    return "held";
  } catch {
    return await recoverOwnedLease(bucket, lock);
  }
};

const releaseBranchMutationLock = async (
  bucket: VoidBlobStore,
  lock: BranchLockLease,
): Promise<BranchLockReleaseOutcome> => {
  const renewal = await renewBranchMutationLock(bucket, lock);
  if (renewal === "not_held") return "not_held";
  if (renewal === "unknown") return "unknown";
  try {
    const released = await bucket.put(lock.key, lockBody(lock.token, true), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: lock.etag },
    });
    if (!released) return "not_held";
    lock.etag = objectEtag(released) ?? lock.etag;
    return "released";
  } catch {
    return "unknown";
  }
};

const warnUnconfirmedCleanup = (
  rootDropId: string,
  branchId: string,
  releaseOutcome: Exclude<BranchLockReleaseOutcome, "released">,
): void => {
  console.warn({
    code: "branch_mutation_lock_cleanup_unconfirmed",
    outcome: "committed_with_cleanup_warning",
    rootDropId,
    branchId,
    releaseOutcome,
  } satisfies BranchMutationLockCleanupWarning);
};

/** Runs a branch mutation under a lease with explicit pre-commit ownership proof. */
export const withBranchMutationLock = async <T>(
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  work: (context: BranchMutationLockContext) => Promise<T>,
): Promise<T> => {
  const lock = await acquireBranchMutationLock(bucket, rootDropId, branchId);
  let stopped = false;
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRenewal = Promise.resolve();

  let commitLost = false;
  const scheduleRenewal = (): void => {
    renewalTimer = setTimeout(() => {
      activeRenewal = (async () => {
        if ((await renewBranchMutationLock(bucket, lock)) !== "held") {
          commitLost = true;
        }
      })().finally(() => {
        if (!stopped) scheduleRenewal();
      });
    }, BRANCH_LOCK_RENEW_MS);
  };
  scheduleRenewal();

  let commitStarted = false;
  let result: T | undefined;
  let workError: unknown;
  try {
    result = await work({
      beginCommit: async () => {
        if (commitLost) {
          throw new BranchMutationLockError({
            code: "branch_lock_lost_before_commit",
            outcome: "not_committed",
          });
        }
        if ((await renewBranchMutationLock(bucket, lock)) !== "held") {
          throw new BranchMutationLockError({
            code: "branch_lock_lost_before_commit",
            outcome: "not_committed",
          });
        }
        commitStarted = true;
      },
    });
  } catch (error) {
    workError = error;
  } finally {
    stopped = true;
    if (renewalTimer) clearTimeout(renewalTimer);
    await activeRenewal;
  }

  const ownershipAfterWork = await renewBranchMutationLock(bucket, lock);
  const releaseOutcome = ownershipAfterWork === "held"
    ? await releaseBranchMutationLock(bucket, lock)
    : ownershipAfterWork === "not_held"
      ? "not_held"
      : "unknown";

  if (workError) {
    if (commitStarted) {
      throw new BranchMutationLockError({
        code: "branch_mutation_outcome_unknown",
        outcome: "unknown",
      });
    }
    if (workError instanceof BranchMutationLockError) throw workError;
    throw workError;
  }
  if (commitStarted) {
    if (ownershipAfterWork !== "held" || commitLost) {
      throw new BranchMutationLockError({
        code: "branch_mutation_outcome_unknown",
        outcome: "unknown",
      });
    }
    if (releaseOutcome !== "released") {
      warnUnconfirmedCleanup(rootDropId, branchId, releaseOutcome);
    }
    return result as T;
  }
  if (ownershipAfterWork !== "held") {
    throw new BranchMutationLockError({
      code: "branch_mutation_outcome_unknown",
      outcome: "unknown",
    });
  }
  if (releaseOutcome === "unknown") {
    console.warn("branch mutation lock release outcome could not be confirmed");
  }
  return result as T;
};
