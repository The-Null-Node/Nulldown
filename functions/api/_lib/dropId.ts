import type { R2Bucket } from "@cloudflare/workers-types";
import {
  DROP_LINK_ID_LENGTH,
  isDropIdToken,
  toShortDropId,
} from "../../../shared/drop/id";
import { toLogRef, type RequestLogger } from "./logger";

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
  object: { body?: ReadableStream | null } | null,
): Promise<string | null> => {
  if (!object || !object.body) {
    return null;
  }

  const value = (await new Response(object.body).text()).trim();
  return value || null;
};

export const createRemoteAliasKey = (shortId: string) =>
  `${REMOTE_DROP_ALIAS_PREFIX}${shortId}`;

export const readRemoteAlias = async (
  bucket: R2Bucket,
  shortId: string,
): Promise<string | null> => {
  const cached = readAliasCache(shortId);
  if (cached) {
    return cached;
  }

  const object = await bucket.get(createRemoteAliasKey(shortId));
  const value = await readObjectText(object);
  if (value) {
    writeAliasCache(shortId, value);
  }
  return value;
};

export const reserveRemoteAlias = async (
  bucket: R2Bucket,
  fullId: string,
  logger?: DropIdLogger,
): Promise<"reserved" | "already-registered" | "conflict"> => {
  const shortId = toShortDropId(fullId);
  const existing = await readRemoteAlias(bucket, shortId);

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
    return "reserved";
  }

  const winner = await readRemoteAlias(bucket, shortId);
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

export const removeRemoteAliasIfMatch = async (
  bucket: R2Bucket,
  fullId: string,
  logger?: DropIdLogger,
): Promise<void> => {
  const shortId = toShortDropId(fullId);
  const aliasKey = createRemoteAliasKey(shortId);
  const existing = await readRemoteAlias(bucket, shortId);

  if (existing === fullId) {
    await bucket.delete(aliasKey);
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

export const resolveRemoteDropId = async (
  bucket: R2Bucket,
  id: string,
  logger?: DropIdLogger,
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

  const aliased = await readRemoteAlias(bucket, candidate);
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
