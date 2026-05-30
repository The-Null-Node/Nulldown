import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type {
  VoidBlobStore,
  VoidDataIndexEntry,
  VoidDataIndexFilter,
  VoidDataKey,
  VoidDataListItem,
  VoidDataListQuery,
  VoidDataListResult,
  VoidDataPrimitive,
  VoidDataPutOptions,
  VoidDataQuery,
  VoidDataScope,
  VoidDataStore,
  VoidSqlStore,
} from "../../../../../src/server/ports";

/** Cloudflare bindings used by backend services through portable ports. */
export interface CloudflareStorageBindings {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

interface CloudflareVoidDataEnvelope<T = unknown> {
  key: VoidDataKey;
  value: T;
  indexes?: VoidDataIndexEntry[];
  updatedAt: number;
}

interface VoidDataRecordRow {
  record_json: string;
}

const DATA_LOCK_PREFIX = "void-data-locks";
const DATA_LOCK_MAX_ATTEMPTS = 120;
const DATA_LOCK_BASE_BACKOFF_MS = 8;
const DATA_LOCK_STALE_MS = 20_000;

const encodeKeySegment = (value: string): string => encodeURIComponent(value);

const scopeEntries = (scope: VoidDataScope | undefined) =>
  Object.entries(scope ?? {}).sort(([left], [right]) => left.localeCompare(right));

const scopeSegment = (entry: [string, VoidDataPrimitive]): string => {
  const [key, value] = entry;
  return `${encodeKeySegment(key)}=${encodeKeySegment(JSON.stringify(value))}`;
};

const normalizeCollection = (collection: string | undefined): string =>
  collection ?? "";

const resolveScopeKey = (scope: VoidDataScope | undefined): string =>
  scopeEntries(scope).map(scopeSegment).join("/");

const resolveDataLockKey = (key: VoidDataKey): string =>
  [
    DATA_LOCK_PREFIX,
    encodeKeySegment(key.namespace),
    encodeKeySegment(key.collection ?? "_"),
    ...scopeEntries(key.scope).map(scopeSegment),
    encodeKeySegment(key.id),
  ].join("/");

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseEnvelope = <T>(value: string | null): CloudflareVoidDataEnvelope<T> | null => {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.key) || !("value" in parsed)) {
      return null;
    }
    const key = parsed.key as Partial<VoidDataKey>;
    if (typeof key.namespace !== "string" || typeof key.id !== "string") {
      return null;
    }
    return parsed as CloudflareVoidDataEnvelope<T>;
  } catch {
    return null;
  }
};

const envelopeToListItem = <T>(
  envelope: CloudflareVoidDataEnvelope<T>,
): VoidDataListItem<T> => ({
  key: envelope.key,
  value: envelope.value,
  indexes: envelope.indexes,
  updatedAt: envelope.updatedAt,
});

const parseRecordRow = <T>(
  row: VoidDataRecordRow | null | undefined,
): CloudflareVoidDataEnvelope<T> | null =>
  parseEnvelope<T>(typeof row?.record_json === "string" ? row.record_json : null);

const indexValueMatches = (
  actual: VoidDataIndexEntry["value"],
  expected: VoidDataIndexEntry["value"],
): boolean => {
  const actualValues = Array.isArray(actual) ? actual : [actual];
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  return expectedValues.some((expectedValue) => actualValues.includes(expectedValue));
};

const matchesIndexFilter = (
  indexes: VoidDataIndexEntry[] | undefined,
  filter: VoidDataIndexFilter,
): boolean => {
  const matches = indexes?.filter((entry) => entry.name === filter.name) ?? [];
  if (!matches.length) return false;

  if (filter.value !== undefined) {
    return matches.some((entry) => indexValueMatches(entry.value, filter.value));
  }

  if (filter.values !== undefined) {
    return matches.some((entry) =>
      filter.values?.some((value) => indexValueMatches(entry.value, value)),
    );
  }

  return true;
};

const matchesTextQuery = <T>(
  item: VoidDataListItem<T>,
  text: string | undefined,
): boolean => {
  const query = text?.trim().toLowerCase();
  if (!query) return true;
  const indexedText = item.indexes
    ?.filter((entry) => entry.mode === "fulltext" || entry.name === "text")
    .map((entry) => String(entry.value))
    .join("\n");
  const searchable = indexedText || JSON.stringify(item.value);
  return searchable.toLowerCase().includes(query);
};

const matchesListQuery = <T>(
  item: VoidDataListItem<T>,
  query: VoidDataListQuery,
): boolean => {
  if (item.key.namespace !== query.namespace) return false;
  if (query.collection !== undefined && item.key.collection !== query.collection) {
    return false;
  }
  if (query.idPrefix && !item.key.id.startsWith(query.idPrefix)) return false;

  for (const [key, value] of scopeEntries(query.scope)) {
    if (item.key.scope?.[key] !== value) return false;
  }

  return true;
};

const d1ScalarValues = (entry: VoidDataIndexEntry): VoidDataPrimitive[] =>
  Array.isArray(entry.value) ? entry.value : [entry.value];

const d1IndexValueParams = (value: VoidDataPrimitive) => ({
  valueText: value === null ? null : String(value),
  valueNumber: typeof value === "number" ? value : null,
  valueBool: typeof value === "boolean" ? (value ? 1 : 0) : null,
});

const sleep = async (durationMs: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
};

const randomJitter = (): number => {
  const bytes = crypto.getRandomValues(new Uint8Array(1));
  return bytes[0] % 10;
};

const parseLockPayload = (value: string | null): { token: string; createdAt: number } | null => {
  const parsed = parseEnvelope<{ token: string; createdAt: number }>(value)?.value;
  return parsed && typeof parsed.token === "string" && typeof parsed.createdAt === "number"
    ? parsed
    : null;
};

/** Exposes a Cloudflare R2 bucket through the portable blob-store port. */
export const createCloudflareBlobStore = (bucket: R2Bucket): VoidBlobStore =>
  bucket as unknown as VoidBlobStore;

/** Exposes a Cloudflare D1 database through the portable SQL-store port. */
export const createCloudflareSqlStore = (
  db: D1Database | undefined,
): VoidSqlStore | undefined => db as unknown as VoidSqlStore | undefined;

const readEnvelopeFromD1 = async <T>(
  db: D1Database,
  key: VoidDataKey,
): Promise<CloudflareVoidDataEnvelope<T> | null> => {
  const row = await db
    .prepare(
      `SELECT record_json
       FROM void_data_records
       WHERE namespace = ? AND collection = ? AND scope_key = ? AND id = ?`,
    )
    .bind(
      key.namespace,
      normalizeCollection(key.collection),
      resolveScopeKey(key.scope),
      key.id,
    )
    .first<VoidDataRecordRow>();
  return parseRecordRow<T>(row);
};

const listEnvelopesFromD1 = async <T>(
  db: D1Database,
  query: VoidDataListQuery,
): Promise<VoidDataListResult<T>> => {
  const filters = ["namespace = ?"];
  const params: Array<string | number> = [query.namespace];
  if (query.collection !== undefined) {
    filters.push("collection = ?");
    params.push(normalizeCollection(query.collection));
  }
  if (query.idPrefix) {
    filters.push("id LIKE ?");
    params.push(`${query.idPrefix}%`);
  }

  const normalizedLimit = Math.max(1, Math.min(1000, query.limit ?? 1000));
  const offset = query.cursor ? Math.max(0, Number.parseInt(query.cursor, 10) || 0) : 0;
  params.push(normalizedLimit + 1, offset);

  const rows = await db
    .prepare(
      `SELECT record_json
       FROM void_data_records
       WHERE ${filters.join(" AND ")}
       ORDER BY namespace ASC, collection ASC, scope_key ASC, id ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(...params)
    .all<VoidDataRecordRow>();

  const parsed = (rows.results ?? [])
    .map((row) => parseRecordRow<T>(row))
    .filter((entry): entry is CloudflareVoidDataEnvelope<T> => Boolean(entry))
    .map(envelopeToListItem)
    .filter((item) => matchesListQuery(item, query));

  return {
    items: parsed.slice(0, normalizedLimit),
    cursor:
      parsed.length > normalizedLimit || (rows.results ?? []).length > normalizedLimit
        ? String(offset + normalizedLimit)
        : null,
    truncated: parsed.length > normalizedLimit || (rows.results ?? []).length > normalizedLimit,
  };
};

const requireVoidDataD1 = (db: D1Database | undefined): D1Database => {
  if (!db) {
    throw new Error("void_data_store_db_required");
  }
  return db;
};

/** Creates the Cloudflare implementation of the generic Nulldown data-store port. */
export const createCloudflareVoidDataStore = ({
  R2_BUCKET,
  DB,
}: CloudflareStorageBindings): VoidDataStore => {
  const blobs = createCloudflareBlobStore(R2_BUCKET);

  const get = async <T = unknown>(key: VoidDataKey): Promise<T | null> => {
    const envelope = await readEnvelopeFromD1<T>(requireVoidDataD1(DB), key);
    return envelope?.value ?? null;
  };

  const put = async <T = unknown>(
    key: VoidDataKey,
    value: T,
    options?: VoidDataPutOptions,
  ): Promise<void> => {
    const envelope: CloudflareVoidDataEnvelope<T> = {
      key,
      value,
      indexes: options?.indexes,
      updatedAt: Date.now(),
    };
    const db = requireVoidDataD1(DB);
    const scopeKey = resolveScopeKey(key.scope);
    const collection = normalizeCollection(key.collection);

    if (options?.ifAbsent) {
      const existing = await readEnvelopeFromD1(db, key);
      if (existing) throw new Error("void_data_put_conflict");
    }

    await db
      .prepare(
        `INSERT INTO void_data_records (
           namespace, collection, scope_key, id, key_json, record_json,
           content_type, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, collection, scope_key, id) DO UPDATE SET
           key_json = excluded.key_json,
           record_json = excluded.record_json,
           content_type = excluded.content_type,
           updated_at = excluded.updated_at`,
      )
      .bind(
        key.namespace,
        collection,
        scopeKey,
        key.id,
        JSON.stringify(key),
        JSON.stringify(envelope),
        options?.contentType ?? "application/json",
        envelope.updatedAt,
      )
      .run();

    await db
      .prepare(
        `DELETE FROM void_data_indexes
         WHERE namespace = ? AND collection = ? AND scope_key = ? AND id = ?`,
      )
      .bind(key.namespace, collection, scopeKey, key.id)
      .run();
    await db
      .prepare(
        `DELETE FROM void_data_fts
         WHERE namespace = ? AND collection = ? AND scope_key = ? AND id = ?`,
      )
      .bind(key.namespace, collection, scopeKey, key.id)
      .run();

    for (const index of options?.indexes ?? []) {
      const mode = index.mode ?? "exact";
      for (const value of d1ScalarValues(index)) {
        const { valueText, valueNumber, valueBool } = d1IndexValueParams(value);
        await db
          .prepare(
            `INSERT INTO void_data_indexes (
               namespace, collection, scope_key, id, name, mode,
               value_text, value_number, value_bool, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            key.namespace,
            collection,
            scopeKey,
            key.id,
            index.name,
            mode,
            valueText,
            valueNumber,
            valueBool,
            envelope.updatedAt,
          )
          .run();
      }

      if (mode === "fulltext" || index.name === "text") {
        await db
          .prepare(
            `INSERT INTO void_data_fts (text, namespace, collection, scope_key, id)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            d1ScalarValues(index).map((value) => String(value ?? "")).join("\n"),
            key.namespace,
            collection,
            scopeKey,
            key.id,
          )
          .run();
      }
    }
  };

  const deleteValue = async (key: VoidDataKey): Promise<void> => {
    const db = requireVoidDataD1(DB);
    const collection = normalizeCollection(key.collection);
    const scopeKey = resolveScopeKey(key.scope);
    await db
      .prepare(
        `DELETE FROM void_data_indexes
         WHERE namespace = ? AND collection = ? AND scope_key = ? AND id = ?`,
      )
      .bind(key.namespace, collection, scopeKey, key.id)
      .run();
    await db
      .prepare(
        `DELETE FROM void_data_fts
         WHERE namespace = ? AND collection = ? AND scope_key = ? AND id = ?`,
      )
      .bind(key.namespace, collection, scopeKey, key.id)
      .run();
    await db
      .prepare(
        `DELETE FROM void_data_records
         WHERE namespace = ? AND collection = ? AND scope_key = ? AND id = ?`,
      )
      .bind(key.namespace, collection, scopeKey, key.id)
      .run();
  };

  const list = async <T = unknown>(
    query: VoidDataListQuery,
  ): Promise<VoidDataListResult<T>> => {
    return listEnvelopesFromD1<T>(requireVoidDataD1(DB), query);
  };

  const dataStore: VoidDataStore = {
    get,
    put,
    delete: deleteValue,
    list,
    query: async <T = unknown>(query: VoidDataQuery): Promise<T[]> => {
      const listed = await list<T>(query);
      return listed.items
        .filter((item) =>
          (query.indexes ?? []).every((filter) =>
            matchesIndexFilter(item.indexes, filter),
          ),
        )
        .filter((item) => matchesTextQuery(item, query.text))
        .map((item) => item.value);
    },
    tx: async <T>(work: (data: VoidDataStore) => Promise<T>): Promise<T> =>
      work(dataStore),
    lock: async <T>(
      key: VoidDataKey,
      work: (data: VoidDataStore) => Promise<T>,
    ): Promise<T> => {
      const lockKey = resolveDataLockKey(key);
      const token = crypto.randomUUID();

      for (let attempt = 0; attempt < DATA_LOCK_MAX_ATTEMPTS; attempt += 1) {
        const acquired = await blobs.put(
          lockKey,
          JSON.stringify({
            key,
            value: { token, createdAt: Date.now() },
            updatedAt: Date.now(),
          } satisfies CloudflareVoidDataEnvelope<{ token: string; createdAt: number }>),
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
    },
  };

  return dataStore;
};
