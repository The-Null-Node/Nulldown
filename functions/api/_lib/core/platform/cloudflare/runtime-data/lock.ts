import type {
  BlobObjectStore,
  RuntimeDataKey,
  RuntimeDataStore,
} from "../../../../../../../src/server/ports";
import { resolveRuntimeDataLockKey } from "./keys";

const DATA_LOCK_MAX_ATTEMPTS = 120;
const DATA_LOCK_BASE_BACKOFF_MS = 8;
const DATA_LOCK_STALE_MS = 20_000;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseLockPayload = (
  value: string | null,
): { token: string; createdAt: number } | null => {
  if (value === null) return null;
  try {
    const envelope = JSON.parse(value) as unknown;
    if (!isRecord(envelope) || !isRecord(envelope.key)) return null;
    if (
      typeof envelope.key.namespace !== "string" ||
      typeof envelope.key.id !== "string" ||
      !isRecord(envelope.value)
    ) {
      return null;
    }
    return typeof envelope.value.token === "string" &&
      typeof envelope.value.createdAt === "number"
      ? {
          token: envelope.value.token,
          createdAt: envelope.value.createdAt,
        }
      : null;
  } catch {
    return null;
  }
};

/** Runs one runtime-data operation under the existing R2 conditional lock. */
export const withCloudflareRuntimeDataLock = async <T>(
  blobs: BlobObjectStore,
  dataStore: RuntimeDataStore,
  key: RuntimeDataKey,
  work: (data: RuntimeDataStore) => Promise<T>,
): Promise<T> => {
  const lockKey = resolveRuntimeDataLockKey(key);
  const token = crypto.randomUUID();

  for (let attempt = 0; attempt < DATA_LOCK_MAX_ATTEMPTS; attempt += 1) {
    const acquired = await blobs.put(
      lockKey,
      JSON.stringify({
        key,
        value: { token, createdAt: Date.now() },
        updatedAt: Date.now(),
      }),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );

    if (acquired) {
      try {
        return await work(dataStore);
      } finally {
        const existing = await blobs.get(lockKey);
        const payload = parseLockPayload(await readText(existing));
        if (!payload || payload.token === token) {
          await blobs.delete(lockKey);
        }
      }
    }

    const existing = await blobs.get(lockKey);
    const payload = parseLockPayload(await readText(existing));
    if (payload && Date.now() - payload.createdAt > DATA_LOCK_STALE_MS) {
      await blobs.delete(lockKey);
      continue;
    }

    const backoff =
      DATA_LOCK_BASE_BACKOFF_MS + Math.min(attempt, 15) * 3 + randomJitter();
    await sleep(backoff);
  }

  throw new Error("void_data_lock_timeout");
};
