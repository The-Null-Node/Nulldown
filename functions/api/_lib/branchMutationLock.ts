import type { R2Bucket } from "@cloudflare/workers-types";
import { createBranchLockKey } from "./branchKeys";

const BRANCH_LOCK_MAX_ATTEMPTS = 120;
const BRANCH_LOCK_BASE_BACKOFF_MS = 8;
const BRANCH_LOCK_STALE_MS = 20_000;

interface BranchLockPayload {
  token: string;
  createdAt: number;
}

const readText = async (
  object: { text: () => Promise<string> } | null,
): Promise<string | null> => {
  if (!object) {
    return null;
  }

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
  if (!value) {
    return null;
  }

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
      };
    }
  } catch {
    return null;
  }

  return null;
};

const acquireBranchMutationLock = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<{ key: string; token: string }> => {
  const key = createBranchLockKey(rootDropId, branchId);
  const token = crypto.randomUUID();

  for (let attempt = 0; attempt < BRANCH_LOCK_MAX_ATTEMPTS; attempt += 1) {
    const acquired = await bucket.put(
      key,
      JSON.stringify({ token, createdAt: Date.now() }),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );

    if (acquired) {
      return { key, token };
    }

    const existing = await bucket.get(key);
    const existingPayload = parseBranchLockPayload(await readText(existing));
    const isStale =
      existingPayload &&
      Date.now() - existingPayload.createdAt > BRANCH_LOCK_STALE_MS;
    if (isStale) {
      // Locks are best-effort R2 objects, so stale holders are reaped instead of blocking the branch forever.
      await bucket.delete(key);
      continue;
    }

    const backoff =
      BRANCH_LOCK_BASE_BACKOFF_MS + Math.min(attempt, 15) * 3 + randomJitter();
    await sleep(backoff);
  }

  throw new Error("branch_lock_timeout");
};

const releaseBranchMutationLock = async (
  bucket: R2Bucket,
  lock: { key: string; token: string },
): Promise<void> => {
  const existing = await bucket.get(lock.key);
  const payload = parseBranchLockPayload(await readText(existing));
  if (payload && payload.token !== lock.token) {
    return;
  }
  await bucket.delete(lock.key);
};

/** Runs a branch mutation under the coarse R2 branch lock. */
export const withBranchMutationLock = async <T>(
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  work: () => Promise<T>,
): Promise<T> => {
  const lock = await acquireBranchMutationLock(bucket, rootDropId, branchId);
  try {
    return await work();
  } finally {
    await releaseBranchMutationLock(bucket, lock);
  }
};
