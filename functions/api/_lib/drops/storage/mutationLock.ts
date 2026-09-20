import type { VoidBlobStore } from "../../../../../src/server/ports";

const ROOT_LOCK_PREFIX = "__drop_root_lock__/";
const LOCK_MAX_ATTEMPTS = 120;
const LOCK_BASE_BACKOFF_MS = 8;
const LOCK_STALE_MS = 300_000;
const LOCK_RENEW_MS = 10_000;

interface RootLockPayload {
  token: string;
  createdAt: number;
  releasedAt?: number;
}

interface RootLockState {
  payload: RootLockPayload | null;
  etag: string | null;
}

/** Raised when a root mutation cannot establish a lease before changing storage. */
export class RootMutationLockError extends Error {
  constructor(readonly code: "root_mutation_lock_timeout" | "root_mutation_lock_lost") {
    super(code);
    this.name = "RootMutationLockError";
  }
}

/** Lease used to serialize root replacement and deletion. */
export interface RootMutationLock {
  /** Confirms this caller still owns the lease immediately before storage mutation. */
  beginCommit(): Promise<void>;
  /** Releases the lease without overriding a subsequently acquired lease. */
  release(): Promise<void>;
}

const lockKey = (rootId: string): string =>
  `${ROOT_LOCK_PREFIX}${encodeURIComponent(rootId)}.json`;

const objectEtag = (object: { etag?: string; httpEtag?: string } | null): string | null =>
  object?.etag ?? object?.httpEtag ?? null;

const parseLockPayload = (value: string | null): RootLockPayload | null => {
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
    // Malformed lock payloads are safely eligible for ETag-guarded takeover.
  }
  return null;
};

const lockBody = (token: string, released = false): string =>
  JSON.stringify({
    token,
    createdAt: Date.now(),
    ...(released ? { releasedAt: Date.now() } : {}),
  });

const readLock = async (blobs: VoidBlobStore, key: string): Promise<RootLockState> => {
  const object = await blobs.get(key);
  let value: string | null = null;
  try {
    value = object ? await object.text() : null;
  } catch {
    value = null;
  }
  return { payload: parseLockPayload(value), etag: objectEtag(object) };
};

const sleep = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const jitter = (): number => crypto.getRandomValues(new Uint8Array(1))[0] % 10;

/** Acquires an R2-backed lease shared by protected root writers and deleters. */
export const acquireRootMutationLock = async (
  blobs: VoidBlobStore,
  rootId: string,
): Promise<RootMutationLock> => {
  const key = lockKey(rootId);
  const token = crypto.randomUUID();
  let etag: string | null = null;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    const created = await blobs.put(key, lockBody(token), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (created) {
      etag = objectEtag(created);
      break;
    }

    const existing = await readLock(blobs, key);
    const stale =
      !existing.payload || Date.now() - existing.payload.createdAt > LOCK_STALE_MS;
    if ((existing.payload?.releasedAt !== undefined || stale) && existing.etag) {
      const replaced = await blobs.put(key, lockBody(token), {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagMatches: existing.etag },
      });
      if (replaced) {
        etag = objectEtag(replaced);
        break;
      }
    }

    await sleep(LOCK_BASE_BACKOFF_MS + Math.min(attempt, 15) * 3 + jitter());
  }

  if (!etag) throw new RootMutationLockError("root_mutation_lock_timeout");

  const confirmHeld = async (): Promise<void> => {
    const current = await readLock(blobs, key);
    if (
      current.payload?.token !== token ||
      current.payload.releasedAt !== undefined ||
      !current.etag
    ) {
      throw new RootMutationLockError("root_mutation_lock_lost");
    }
    const renewed = await blobs.put(key, lockBody(token), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: current.etag },
    });
    const renewedEtag = objectEtag(renewed);
    if (!renewedEtag) throw new RootMutationLockError("root_mutation_lock_lost");
    etag = renewedEtag;
  };

  let stopped = false;
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRenewal = Promise.resolve();
  let leaseLost = false;
  const scheduleRenewal = (): void => {
    renewalTimer = setTimeout(() => {
      activeRenewal = confirmHeld()
        .catch(() => {
          leaseLost = true;
        })
        .finally(() => {
          if (!stopped) scheduleRenewal();
        });
    }, LOCK_RENEW_MS);
  };
  scheduleRenewal();

  return {
    beginCommit: async () => {
      if (leaseLost) throw new RootMutationLockError("root_mutation_lock_lost");
      await confirmHeld();
    },
    release: async () => {
      stopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      await activeRenewal;
      try {
        const current = await readLock(blobs, key);
        if (
          current.payload?.token !== token ||
          current.payload.releasedAt !== undefined ||
          !current.etag
        ) {
          return;
        }
        await blobs.put(key, lockBody(token, true), {
          httpMetadata: { contentType: "application/json" },
          onlyIf: { etagMatches: current.etag },
        });
      } catch {
        // A stale lease is recovered by a later ETag-guarded acquisition.
      }
    },
  };
};
