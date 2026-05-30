import type {
  VoidBlobObject,
  VoidBlobStore,
  VoidSqlStore,
} from "../../../../../src/server/ports";
import {
  isDropEnvelopeV1,
  type DropEnvelopeV1,
} from "../../../../../shared/drop/types";

/** R2 key prefix for public drop index entries. */
export const REMOTE_PUBLIC_DROP_INDEX_PREFIX = "__drop_public_index__/";

const INDEX_CONTENT_TYPE = "application/json";

/** Public search/list index entry for a remotely stored drop. */
export interface DropPublicIndexEntry {
  version: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isDropPublicIndexEntry = (
  value: unknown,
): value is DropPublicIndexEntry => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
};

const mapPublicDropRow = (row: {
  id: string;
  created_at: number;
  updated_at: number;
}): DropPublicIndexEntry => ({
  version: 1,
  id: row.id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const readPublicDropIndexEntryFromD1 = async (
  db: VoidSqlStore | undefined,
  id: string,
): Promise<DropPublicIndexEntry | null> => {
  if (!db) return null;
  const row = await db
    .prepare("SELECT id, created_at, updated_at FROM public_drops WHERE id = ?")
    .bind(id)
    .first<{ id: string; created_at: number; updated_at: number }>();
  return row ? mapPublicDropRow(row) : null;
};

/** Builds the R2 key for a public drop index entry. */
export const createRemotePublicDropIndexKey = (id: string): string =>
  `${REMOTE_PUBLIC_DROP_INDEX_PREFIX}${id}.json`;

/** Returns true when a key belongs to the public drop index namespace. */
export const isRemotePublicDropIndexKey = (key: string): boolean =>
  key.startsWith(REMOTE_PUBLIC_DROP_INDEX_PREFIX);

const parsePublicIndexEntryFromObject = async (
  object: VoidBlobObject | null,
): Promise<DropPublicIndexEntry | null> => {
  if (!object?.body) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await object.json<unknown>();
  } catch {
    return null;
  }

  return isDropPublicIndexEntry(parsed) ? parsed : null;
};

/** Reads the public index entry for a canonical drop id. */
export const readPublicDropIndexEntry = async (
  bucket: VoidBlobStore,
  id: string,
  db?: VoidSqlStore,
): Promise<DropPublicIndexEntry | null> => {
  const d1Entry = await readPublicDropIndexEntryFromD1(db, id);
  if (d1Entry) return d1Entry;

  const key = createRemotePublicDropIndexKey(id);
  const object = await bucket.get(key);
  const entry = await parsePublicIndexEntryFromObject(object);
  if (entry && db) {
    await upsertPublicDropIndexEntry(bucket, entry.id, entry.updatedAt, db);
  }
  return entry;
};

/** Reads a public index entry by its full R2 key. */
export const readPublicDropIndexEntryByKey = async (
  bucket: VoidBlobStore,
  key: string,
): Promise<DropPublicIndexEntry | null> => {
  const object = await bucket.get(key);
  return parsePublicIndexEntryFromObject(object);
};

/** Creates or updates the public index entry for a drop. */
export const upsertPublicDropIndexEntry = async (
  bucket: VoidBlobStore,
  id: string,
  updatedAt = Date.now(),
  db?: VoidSqlStore,
): Promise<DropPublicIndexEntry> => {
  const existing = await readPublicDropIndexEntry(bucket, id, db);
  const entry: DropPublicIndexEntry = {
    version: 1,
    id,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
  };

  await bucket.put(createRemotePublicDropIndexKey(id), JSON.stringify(entry), {
    httpMetadata: { contentType: INDEX_CONTENT_TYPE },
  });

  if (db) {
    await db
      .prepare(
        `INSERT INTO public_drops (id, created_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .bind(id, entry.createdAt, entry.updatedAt)
      .run();
  }

  return entry;
};

/** Removes the public index entry for a drop. */
export const removePublicDropIndexEntry = async (
  bucket: VoidBlobStore,
  id: string,
  db?: VoidSqlStore,
): Promise<void> => {
  await bucket.delete(createRemotePublicDropIndexKey(id));
  if (db) {
    await db.prepare("DELETE FROM public_drops WHERE id = ?").bind(id).run();
  }
};

/** Synchronizes public index state from a stored drop envelope. */
export const syncPublicDropIndexForEnvelope = async (
  bucket: VoidBlobStore,
  id: string,
  envelope: DropEnvelopeV1 | null,
  updatedAt = Date.now(),
  db?: VoidSqlStore,
): Promise<void> => {
  if (envelope && (envelope.visibility ?? "unlisted") === "public") {
    await upsertPublicDropIndexEntry(bucket, id, updatedAt, db);
    return;
  }

  await removePublicDropIndexEntry(bucket, id, db);
};

/** Synchronizes public index state from any stored drop payload. */
export const syncPublicDropIndexForPayload = async (
  bucket: VoidBlobStore,
  id: string,
  payload: unknown,
  updatedAt = Date.now(),
  db?: VoidSqlStore,
): Promise<void> => {
  if (isDropEnvelopeV1(payload)) {
    await syncPublicDropIndexForEnvelope(bucket, id, payload, updatedAt, db);
    return;
  }

  await removePublicDropIndexEntry(bucket, id, db);
};

/** Lists public drop index entries from D1 in updated-at order. */
export const listPublicDropIndexEntries = async (
  db: VoidSqlStore,
  limit: number,
  cursor?: string,
): Promise<{ items: DropPublicIndexEntry[]; cursor: string | null }> => {
  const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const rows = await db
    .prepare(
      `SELECT id, created_at, updated_at
       FROM public_drops
       ORDER BY updated_at DESC, id ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(safeLimit + 1, offset)
    .all<{ id: string; created_at: number; updated_at: number }>();
  const allRows = rows.results ?? [];
  const page = allRows.slice(0, safeLimit).map(mapPublicDropRow);
  return {
    items: page,
    cursor: allRows.length > safeLimit ? String(offset + safeLimit) : null,
  };
};
