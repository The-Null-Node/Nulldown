import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import {
  DROP_LINK_ID_LENGTH,
  isDropIdToken,
  toShortDropId,
} from "../../../../../shared/drop/id";
import { toLogRef, type RequestLogger } from "../../core/logging/logger";

/** R2 key prefix for short-link aliases that point to canonical drop ids. */
export const REMOTE_DROP_ALIAS_PREFIX = "__drop_alias__/";

const ALIAS_CONTENT_TYPE = "text/plain";
const ALIAS_CACHE_TTL_MS = 30_000;

interface AliasCacheEntry {
  fullId: string;
  expiresAt: number;
}

const aliasCache = new Map<string, AliasCacheEntry>();

type DropIdLogger = Pick<RequestLogger, "debug" | "info" | "warn">;

const readAliasCache = (shortId: string): string | null => {
  const cached = aliasCache.get(shortId);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    aliasCache.delete(shortId);
    return null;
  }

  return cached.fullId;
};

const writeAliasCache = (shortId: string, fullId: string): void => {
  aliasCache.set(shortId, {
    fullId,
    expiresAt: Date.now() + ALIAS_CACHE_TTL_MS,
  });
};

const removeAliasCache = (shortId: string): void => {
  aliasCache.delete(shortId);
};

const readObjectText = async (
  object: { text: () => Promise<string> } | null,
): Promise<string | null> => {
  if (!object) {
    return null;
  }

  const value = (await object.text()).trim();
  return value || null;
};

const readRemoteAliasFromD1 = async (
  db: VoidSqlStore | undefined,
  shortId: string,
): Promise<string | null> => {
  if (!db) return null;
  const row = await db
    .prepare("SELECT full_id FROM drop_aliases WHERE short_id = ?")
    .bind(shortId)
    .first<{ full_id: string }>();
  return row?.full_id ?? null;
};

/** Writes a short-link alias row into D1 metadata storage. */
export const writeRemoteAliasToD1 = async (
  db: VoidSqlStore | undefined,
  shortId: string,
  fullId: string,
): Promise<void> => {
  if (!db) return;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO drop_aliases (short_id, full_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(short_id) DO UPDATE SET
         full_id = excluded.full_id,
         updated_at = excluded.updated_at
       WHERE drop_aliases.full_id = excluded.full_id`,
    )
    .bind(shortId, fullId, now, now)
    .run();
};

/** Builds the R2 key for a short-link alias. */
export const createRemoteAliasKey = (shortId: string) =>
  `${REMOTE_DROP_ALIAS_PREFIX}${shortId}`;

/** Reads a short-link alias from memory, D1, or R2 fallback. */
export const readRemoteAlias = async (
  bucket: VoidBlobStore,
  shortId: string,
  db?: VoidSqlStore,
): Promise<string | null> => {
  const cached = readAliasCache(shortId);
  if (cached) {
    return cached;
  }

  const d1Value = await readRemoteAliasFromD1(db, shortId);
  if (d1Value) {
    writeAliasCache(shortId, d1Value);
    return d1Value;
  }

  const object = await bucket.get(createRemoteAliasKey(shortId));
  const value = await readObjectText(object);
  if (value) {
    writeAliasCache(shortId, value);
    await writeRemoteAliasToD1(db, shortId, value);
  }
  return value;
};

/** Reserves the short-link alias for a full drop id if it is still available. */
export const reserveRemoteAlias = async (
  bucket: VoidBlobStore,
  fullId: string,
  logger?: DropIdLogger,
  db?: VoidSqlStore,
): Promise<"reserved" | "already-registered" | "conflict"> => {
  const shortId = toShortDropId(fullId);
  const existing = await readRemoteAlias(bucket, shortId, db);

  if (existing) {
    if (existing === fullId) {
      logger?.debug("drop.alias.reserve_exists", {
        shortIdRef: toLogRef(shortId),
        dropRef: toLogRef(fullId),
      });
      writeAliasCache(shortId, fullId);
      return "already-registered";
    }

    logger?.warn("drop.alias.reserve_conflict", {
      shortIdRef: toLogRef(shortId),
      dropRef: toLogRef(fullId),
      existingDropRef: toLogRef(existing),
    });
    return "conflict";
  }

  const created = await bucket.put(createRemoteAliasKey(shortId), fullId, {
    onlyIf: {
      etagDoesNotMatch: "*",
    },
    httpMetadata: {
      contentType: ALIAS_CONTENT_TYPE,
    },
  });

  if (created) {
    logger?.debug("drop.alias.reserve_success", {
      shortIdRef: toLogRef(shortId),
      dropRef: toLogRef(fullId),
    });
    writeAliasCache(shortId, fullId);
    await writeRemoteAliasToD1(db, shortId, fullId);
    return "reserved";
  }

  const winner = await readRemoteAlias(bucket, shortId, db);
  if (winner === fullId) {
    logger?.debug("drop.alias.reserve_race_won", {
      shortIdRef: toLogRef(shortId),
      dropRef: toLogRef(fullId),
    });
    writeAliasCache(shortId, fullId);
    return "already-registered";
  }

  if (winner) {
    writeAliasCache(shortId, winner);
  }

  logger?.warn("drop.alias.reserve_race_conflict", {
    shortIdRef: toLogRef(shortId),
    dropRef: toLogRef(fullId),
    winnerDropRef: toLogRef(winner),
  });

  return "conflict";
};

/** Removes a short-link alias only when it still points to the expected drop id. */
export const removeRemoteAliasIfMatch = async (
  bucket: VoidBlobStore,
  fullId: string,
  logger?: DropIdLogger,
  db?: VoidSqlStore,
): Promise<void> => {
  const shortId = toShortDropId(fullId);
  const aliasKey = createRemoteAliasKey(shortId);
  const existing = await readRemoteAlias(bucket, shortId, db);

  if (existing === fullId) {
    await bucket.delete(aliasKey);
    if (db) {
      await db
        .prepare("DELETE FROM drop_aliases WHERE short_id = ? AND full_id = ?")
        .bind(shortId, fullId)
        .run();
    }
    removeAliasCache(shortId);
    logger?.debug("drop.alias.remove_success", {
      shortIdRef: toLogRef(shortId),
      dropRef: toLogRef(fullId),
    });
    return;
  }

  logger?.debug("drop.alias.remove_skip", {
    shortIdRef: toLogRef(shortId),
    dropRef: toLogRef(fullId),
    existingDropRef: toLogRef(existing),
  });
};

/** Resolves a user-supplied full or short drop id to a canonical remote drop id. */
export const resolveRemoteDropId = async (
  bucket: VoidBlobStore,
  id: string,
  logger?: DropIdLogger,
  db?: VoidSqlStore,
): Promise<string | null> => {
  const candidate = id.trim();
  if (!candidate || !isDropIdToken(candidate)) {
    logger?.warn("drop.id.resolve_invalid", {
      providedLength: id.length,
    });
    return null;
  }

  if (candidate.length !== DROP_LINK_ID_LENGTH) {
    logger?.debug("drop.id.resolve_full_id", {
      dropRef: toLogRef(candidate),
    });
    return candidate;
  }

  const aliased = await readRemoteAlias(bucket, candidate, db);
  if (aliased) {
    logger?.debug("drop.id.resolve_alias_hit", {
      shortIdRef: toLogRef(candidate),
      dropRef: toLogRef(aliased),
    });
    return aliased;
  }

  logger?.debug("drop.id.resolve_alias_miss", {
    shortIdRef: toLogRef(candidate),
  });
  return candidate;
};
