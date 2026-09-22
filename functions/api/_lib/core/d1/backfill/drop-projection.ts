import { isDropPayload } from "../../../../../../shared/drop/codecs/draft-pack-v1";
import { decodeDropEnvelope } from "../../../../../../shared/drop/codecs/envelope-v1";
import { isDropIdToken, toShortDropId } from "../../../../../../shared/drop/id";
import type { DropEnvelope } from "../../../../../../shared/drop/types";
import type { SqlMetadataStore } from "../../../../../../src/server/ports";
import { createSearchDatabase } from "../../../search/repository";
import { verifyAccountLibraryEnvelopeOwnership } from "../../../accounts/library/service";
import { upsertAccountLibraryEntry } from "../../../accounts/library/repository";
import { createDropIdentityRepository } from "../../../drops/identity/id";
import {
  removePublicDropIndexEntry,
  upsertPublicDropIndexEntry,
} from "../../../drops/index/repository";
import {
  skipAccountLibraryEntry,
  type MetadataBackfillEnv,
  type MetadataBackfillStats,
} from "./contracts";

interface BackfillDropObject {
  etag?: string;
  uploaded?: Date;
  httpMetadata?: { contentType?: string };
  json: <T = unknown>() => Promise<T>;
  text: () => Promise<string>;
}

const readDropEnvelope = async (
  object: { json: <U = unknown>() => Promise<U> } | null,
): Promise<DropEnvelope | null> => {
  if (!object) return null;
  try {
    return decodeDropEnvelope(await object.json<unknown>());
  } catch {
    return null;
  }
};

const upsertDropMetadataFromObject = async (
  db: SqlMetadataStore,
  id: string,
  object: BackfillDropObject,
): Promise<"public" | "unlisted" | "invalid-json" | "non-json"> => {
  const contentType = object.httpMetadata?.contentType || "text/plain";
  const updatedAt = object.uploaded?.getTime() ?? Date.now();
  let ownerAccountId: string | null = null;
  let visibility = "unlisted";
  let metadataJson: string | null = null;

  if (contentType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = await object.json<unknown>();
    } catch {
      return "invalid-json";
    }

    const envelope = decodeDropEnvelope(parsed);
    if (envelope) {
      visibility = envelope.visibility ?? "unlisted";
      metadataJson = JSON.stringify(envelope.metadata);
    } else if (isDropPayload(parsed)) {
      ownerAccountId =
        typeof parsed.metadata?.ownerAccountId === "string"
          ? parsed.metadata.ownerAccountId
          : null;
      metadataJson = JSON.stringify(parsed.metadata);
    }
  }

  await db
    .prepare(
      `INSERT INTO drops (
         id, content_type, etag, short_id, owner_account_id, visibility,
         created_at, updated_at, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content_type = excluded.content_type,
         etag = excluded.etag,
         short_id = excluded.short_id,
         owner_account_id = excluded.owner_account_id,
         visibility = excluded.visibility,
         updated_at = excluded.updated_at,
         metadata_json = excluded.metadata_json`,
    )
    .bind(
      id,
      contentType,
      object.etag ?? null,
      toShortDropId(id),
      ownerAccountId,
      visibility,
      updatedAt,
      updatedAt,
      metadataJson,
    )
    .run();

  return contentType.includes("application/json")
    ? visibility === "public"
      ? "public"
      : "unlisted"
    : "non-json";
};

const extractTitleFromContent = (content: string): string | null => {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim() || null;
    }
  }
  return null;
};

/** Projects one root drop object into metadata, ownership, index, and search rows. */
export const projectDropObject = async (
  env: Required<Pick<MetadataBackfillEnv, "R2_BUCKET" | "DB">>,
  key: string,
  stats: MetadataBackfillStats,
): Promise<void> => {
  if (!isDropIdToken(key)) {
    stats.skipped += 1;
    return;
  }

  const object = await env.R2_BUCKET.get(key);
  if (!object) {
    stats.invalid += 1;
    return;
  }

  const visibility = await upsertDropMetadataFromObject(env.DB, key, object);
  const dropIdentityRepository = createDropIdentityRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  await dropIdentityRepository.writeRemoteAliasToD1(toShortDropId(key), key);
  stats.aliasesUpserted += 1;

  if (visibility === "invalid-json") {
    stats.invalid += 1;
    await removePublicDropIndexEntry(env.R2_BUCKET, key, env.DB);
    stats.publicIndexRemoved += 1;
    return;
  }

  stats.dropsUpserted += 1;

  // Project only envelopes that pass the same direct/delegated ownership verification.
  const envelope = await readDropEnvelope(await env.R2_BUCKET.get(key));
  if (envelope) {
    const verified = await verifyAccountLibraryEnvelopeOwnership(
      env,
      envelope,
      null,
      null,
    );
    if (verified.accountId) {
      await env.DB.prepare("UPDATE drops SET owner_account_id = ? WHERE id = ?")
        .bind(verified.accountId, key)
        .run();
      await upsertAccountLibraryEntry(env.DB, {
        dropId: key,
        accountId: verified.accountId,
        visibility: envelope.visibility ?? "unlisted",
        createdAt: envelope.createdAt,
        updatedAt: object.uploaded?.getTime() ?? Date.now(),
      });
      stats.accountLibraryUpserted += 1;
    } else {
      skipAccountLibraryEntry(stats, "expired_or_untrusted");
    }
  }

  if (visibility === "public") {
    await upsertPublicDropIndexEntry(
      env.R2_BUCKET,
      key,
      object.uploaded?.getTime() ?? Date.now(),
      env.DB,
    );
    stats.publicIndexUpserted += 1;
  } else {
    await removePublicDropIndexEntry(env.R2_BUCKET, key, env.DB);
    stats.publicIndexRemoved += 1;
  }

  try {
    const contentType = object.httpMetadata?.contentType || "";
    let indexContent: string | null = null;

    if (!contentType.includes("application/json")) {
      const rawContent = (await object.text()).trim();
      if (rawContent) indexContent = rawContent;
    } else {
      try {
        const parsed = await object.json<unknown>();
        if (
          isDropPayload(parsed) &&
          typeof parsed.content === "string" &&
          parsed.content.trim()
        ) {
          indexContent = parsed.content;
        }
      } catch {
        // Non-JSON or malformed: skip indexing
      }
    }

    if (indexContent) {
      const title = extractTitleFromContent(indexContent);
      const contentPreview = indexContent.slice(0, 1000);
      const searchDb = createSearchDatabase(env.DB);
      await searchDb.index({
        id: key,
        dropId: key,
        title,
        contentPreview,
        contentHash: null,
        ownerAccountId: null,
        visibility: visibility === "public" ? "public" : "unlisted",
        createdAt: object.uploaded?.getTime() ?? Date.now(),
        updatedAt: object.uploaded?.getTime() ?? Date.now(),
        metadata: null,
      });
      stats.searchIndexUpserted += 1;
    }
  } catch {
    // Search indexing failure is non-fatal for backfill.
  }
};
