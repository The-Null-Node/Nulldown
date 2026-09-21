import type { D1Database } from "@cloudflare/workers-types";
import type {
  RuntimeDataIndexEntry,
  RuntimeDataKey,
  RuntimeDataListItem,
  RuntimeDataListQuery,
  RuntimeDataListResult,
  RuntimeDataPrimitive,
  RuntimeDataPutOptions,
  RuntimeDataPutRecord,
} from "../../../../../../../src/server/ports";
import {
  normalizeRuntimeDataCollection,
  resolveRuntimeDataScopeKey,
  runtimeDataScopeEntries,
} from "./keys";

interface CloudflareRuntimeDataEnvelope<T = unknown> {
  key: RuntimeDataKey;
  value: T;
  indexes?: RuntimeDataIndexEntry[];
  updatedAt: number;
}

interface RuntimeDataRecordRow {
  record_json: string;
}

type CloudflareSqlStatement = ReturnType<D1Database["prepare"]>;

/** D1 persistence operations used by the Cloudflare runtime-data store. */
export interface CloudflareRuntimeDataRepository {
  get<T = unknown>(key: RuntimeDataKey): Promise<T | null>;
  putMany(records: RuntimeDataPutRecord[]): Promise<void>;
  delete(key: RuntimeDataKey): Promise<void>;
  list<T = unknown>(
    query: RuntimeDataListQuery,
  ): Promise<RuntimeDataListResult<T>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseEnvelope = <T>(
  value: string | null,
): CloudflareRuntimeDataEnvelope<T> | null => {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.key) || !("value" in parsed)) {
      return null;
    }
    const key = parsed.key as Partial<RuntimeDataKey>;
    if (typeof key.namespace !== "string" || typeof key.id !== "string") {
      return null;
    }
    return parsed as unknown as CloudflareRuntimeDataEnvelope<T>;
  } catch {
    return null;
  }
};

const parseRecordRow = <T>(
  row: RuntimeDataRecordRow | null | undefined,
): CloudflareRuntimeDataEnvelope<T> | null =>
  parseEnvelope<T>(
    typeof row?.record_json === "string" ? row.record_json : null,
  );

const envelopeToListItem = <T>(
  envelope: CloudflareRuntimeDataEnvelope<T>,
): RuntimeDataListItem<T> => ({
  key: envelope.key,
  value: envelope.value,
  indexes: envelope.indexes,
  updatedAt: envelope.updatedAt,
});

const matchesListQuery = <T>(
  item: RuntimeDataListItem<T>,
  query: RuntimeDataListQuery,
): boolean => {
  if (item.key.namespace !== query.namespace) return false;
  if (
    query.collection !== undefined &&
    item.key.collection !== query.collection
  ) {
    return false;
  }
  if (query.idPrefix && !item.key.id.startsWith(query.idPrefix)) return false;

  for (const [key, value] of runtimeDataScopeEntries(query.scope)) {
    if (item.key.scope?.[key] !== value) return false;
  }

  return true;
};

const d1ScalarValues = (
  entry: RuntimeDataIndexEntry,
): RuntimeDataPrimitive[] =>
  Array.isArray(entry.value) ? entry.value : [entry.value];

const d1IndexValueParams = (value: RuntimeDataPrimitive) => ({
  valueText: value === null ? null : String(value),
  valueNumber: typeof value === "number" ? value : null,
  valueBool: typeof value === "boolean" ? (value ? 1 : 0) : null,
});

const requireRuntimeDataD1 = (db: D1Database | undefined): D1Database => {
  if (!db) {
    throw new Error("void_data_store_db_required");
  }
  return db;
};

const executeD1Statements = async (
  db: D1Database,
  statements: CloudflareSqlStatement[],
): Promise<void> => {
  if (!statements.length) return;
  if (typeof db.batch === "function") {
    await db.batch(statements);
    return;
  }

  for (const statement of statements) {
    await statement.run();
  }
};

const createPutStatements = <T>(
  db: D1Database,
  key: RuntimeDataKey,
  value: T,
  options: RuntimeDataPutOptions | undefined,
  updatedAt: number,
): CloudflareSqlStatement[] => {
  const envelope: CloudflareRuntimeDataEnvelope<T> = {
    key,
    value,
    indexes: options?.indexes,
    updatedAt,
  };
  const scopeKey = resolveRuntimeDataScopeKey(key.scope);
  const collection = normalizeRuntimeDataCollection(key.collection);
  const statements: CloudflareSqlStatement[] = [
    db
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
      ),
    db
      .prepare(
        `DELETE FROM void_data_indexes
         WHERE namespace = ? AND collection = ? AND scope_key = ? AND id = ?`,
      )
      .bind(key.namespace, collection, scopeKey, key.id),
    db
      .prepare(
        `DELETE FROM void_data_fts
         WHERE namespace = ? AND collection = ? AND scope_key = ? AND id = ?`,
      )
      .bind(key.namespace, collection, scopeKey, key.id),
  ];

  for (const index of options?.indexes ?? []) {
    const mode = index.mode ?? "exact";
    for (const value of d1ScalarValues(index)) {
      const { valueText, valueNumber, valueBool } = d1IndexValueParams(value);
      statements.push(
        db
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
          ),
      );
    }

    if (mode === "fulltext" || index.name === "text") {
      statements.push(
        db
          .prepare(
            `INSERT INTO void_data_fts (text, namespace, collection, scope_key, id)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            d1ScalarValues(index)
              .map((value) => String(value ?? ""))
              .join("\n"),
            key.namespace,
            collection,
            scopeKey,
            key.id,
          ),
      );
    }
  }

  return statements;
};

/** Creates a request-scoped D1 repository for generic runtime data. */
export const createCloudflareRuntimeDataRepository = (
  configuredDb: D1Database | undefined,
): CloudflareRuntimeDataRepository => {
  const readEnvelope = async <T>(
    key: RuntimeDataKey,
  ): Promise<CloudflareRuntimeDataEnvelope<T> | null> => {
    const db = requireRuntimeDataD1(configuredDb);
    const row = await db
      .prepare(
        `SELECT record_json
         FROM void_data_records
         WHERE namespace = ? AND collection = ? AND scope_key = ? AND id = ?`,
      )
      .bind(
        key.namespace,
        normalizeRuntimeDataCollection(key.collection),
        resolveRuntimeDataScopeKey(key.scope),
        key.id,
      )
      .first<RuntimeDataRecordRow>();
    return parseRecordRow<T>(row);
  };

  return {
    async get<T = unknown>(key: RuntimeDataKey): Promise<T | null> {
      const envelope = await readEnvelope<T>(key);
      return envelope?.value ?? null;
    },

    async putMany(records: RuntimeDataPutRecord[]): Promise<void> {
      if (!records.length) return;
      const db = requireRuntimeDataD1(configuredDb);
      const statements: CloudflareSqlStatement[] = [];

      for (const record of records) {
        if (record.options?.ifAbsent) {
          const existing = await readEnvelope(record.key);
          if (existing) throw new Error("void_data_put_conflict");
        }
        statements.push(
          ...createPutStatements(
            db,
            record.key,
            record.value,
            record.options,
            Date.now(),
          ),
        );
      }

      await executeD1Statements(db, statements);
    },

    async delete(key: RuntimeDataKey): Promise<void> {
      const db = requireRuntimeDataD1(configuredDb);
      const collection = normalizeRuntimeDataCollection(key.collection);
      const scopeKey = resolveRuntimeDataScopeKey(key.scope);
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
    },

    async list<T = unknown>(
      query: RuntimeDataListQuery,
    ): Promise<RuntimeDataListResult<T>> {
      const db = requireRuntimeDataD1(configuredDb);
      const filters = ["namespace = ?"];
      const params: Array<string | number> = [query.namespace];
      if (query.collection !== undefined) {
        filters.push("collection = ?");
        params.push(normalizeRuntimeDataCollection(query.collection));
      }
      if (query.idPrefix) {
        filters.push("id LIKE ?");
        params.push(`${query.idPrefix}%`);
      }

      const normalizedLimit = Math.max(1, Math.min(1000, query.limit ?? 1000));
      const offset = query.cursor
        ? Math.max(0, Number.parseInt(query.cursor, 10) || 0)
        : 0;
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
        .all<RuntimeDataRecordRow>();

      const parsed = (rows.results ?? [])
        .map((row) => parseRecordRow<T>(row))
        .filter((entry): entry is CloudflareRuntimeDataEnvelope<T> =>
          Boolean(entry),
        )
        .map(envelopeToListItem)
        .filter((item) => matchesListQuery(item, query));

      return {
        items: parsed.slice(0, normalizedLimit),
        cursor:
          parsed.length > normalizedLimit ||
          (rows.results ?? []).length > normalizedLimit
            ? String(offset + normalizedLimit)
            : null,
        truncated:
          parsed.length > normalizedLimit ||
          (rows.results ?? []).length > normalizedLimit,
      };
    },
  };
};
