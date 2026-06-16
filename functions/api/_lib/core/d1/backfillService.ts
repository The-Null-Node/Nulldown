import { isDropIdToken, toShortDropId } from "../../../../../shared/drop/id";
import {
  isDropEnvelopeV1,
  isDropPayload,
} from "../../../../../shared/drop/types";
import { isDropDiffEvent } from "../../../../../shared/drop/diff";
import {
  isDropBranchRecord,
  isDropSnapshotRecord,
} from "../../../../../shared/drop/branch";
import { DROP_RESOLVED_HEAP_KEY_PREFIX } from "../../../../../shared/drop/sidecar";
import { isResolvedNulldownState } from "../../../../../shared/drop/resolved";
import {
  isNullplugUiResponseFact,
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
  NULLPLUG_UI_RESPONSE_FACT_KEY_PREFIX,
  NULLPLUG_UI_STATE_PATCH_FACT_KEY_PREFIX,
  NULLPLUG_UI_STATE_SNAPSHOT_KEY_PREFIX,
} from "../../../../../shared/nullplug/ui";
import {
  ACCOUNT_RECORD_PREFIX,
  isAccountRecord,
  putAccountRecord,
} from "../../accounts/session/auth";
import {
  writeRemoteAliasToD1,
  REMOTE_DROP_ALIAS_PREFIX,
} from "../../drops/identity/id";
import {
  isRemotePublicDropIndexKey,
  readPublicDropIndexEntryByKey,
  removePublicDropIndexEntry,
  upsertPublicDropIndexEntry,
} from "../../drops/index/repository";
import {
  BRANCH_DIFF_EVENT_KEY_PREFIX,
  BRANCH_KEY_PREFIX,
  SNAPSHOT_KEY_PREFIX,
  WRITER_BRANCH_KEY_PREFIX,
} from "../../branches/storage/keys";
import {
  readR2Json,
  writeBranch,
  writeSnapshot,
} from "../../branches/storage/repository";
import { writeBranchDiffEvent } from "../../branches/storage/diffLogRepository";
import {
  DIFF_AUTH_KEY_PREFIX,
  isDiffAuthCredentialRecord,
  putDiffAuthCredential,
} from "../../diffs/credentials/repository";
import {
  syncNullplugUiResponseFactToD1,
  syncNullplugUiStateFactToD1,
} from "../../nullplug/facts/repository";
import { syncResolvedStateToD1 } from "../../resolved/heap/service";
import { verifyBearerToken } from "../auth/bearer";
import { jsonErrorResponse, jsonResponse } from "../http/responses";
import { type RequestLogger, toLogRef } from "../logging/logger";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import { createSearchDatabase } from "../../../../../src/lib/db/searchDatabase";

/** Environment required by D1 metadata backfill. */
export interface MetadataBackfillEnv {
  R2_BUCKET: VoidBlobStore;
  DB?: VoidSqlStore;
  METADATA_BACKFILL_TOKEN?: string;
  DROP_INDEX_BACKFILL_TOKEN?: string;
}

/** Counters returned by the D1 metadata backfill job. */
export interface MetadataBackfillStats {
  scanned: number;
  skipped: number;
  invalid: number;
  failed: number;
  aliasesUpserted: number;
  dropsUpserted: number;
  publicIndexUpserted: number;
  publicIndexRemoved: number;
  accountsUpserted: number;
  branchesUpserted: number;
  writerPointersUpserted: number;
  snapshotsUpserted: number;
  eventsUpserted: number;
  diffCredentialsUpserted: number;
  nullplugFactsUpserted: number;
  resolvedHeapsUpserted: number;
  searchIndexUpserted: number;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

const createStats = (): MetadataBackfillStats => ({
  scanned: 0,
  skipped: 0,
  invalid: 0,
  failed: 0,
  aliasesUpserted: 0,
  dropsUpserted: 0,
  publicIndexUpserted: 0,
  publicIndexRemoved: 0,
  accountsUpserted: 0,
  branchesUpserted: 0,
  writerPointersUpserted: 0,
  snapshotsUpserted: 0,
  eventsUpserted: 0,
  diffCredentialsUpserted: 0,
  nullplugFactsUpserted: 0,
  resolvedHeapsUpserted: 0,
  searchIndexUpserted: 0,
});

const parseLimit = (value: string | null): number => {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_LIMIT, parsed))
    : DEFAULT_LIMIT;
};

const stripSuffix = (value: string, suffix: string): string =>
  value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;

const readObjectText = async (
  object: { text: () => Promise<string> } | null,
): Promise<string | null> => {
  if (!object) return null;
  const value = (await object.text()).trim();
  return value || null;
};

const readObjectJson = async <T>(
  object: { json: <U = unknown>() => Promise<U> } | null,
  guard: (value: unknown) => value is T,
): Promise<T | null> => {
  if (!object) return null;
  try {
    const parsed = await object.json<unknown>();
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const upsertDropMetadataFromObject = async (
  db: VoidSqlStore,
  id: string,
  object: {
    etag?: string;
    uploaded?: Date;
    httpMetadata?: { contentType?: string };
    json: <T = unknown>() => Promise<T>;
  },
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

    if (isDropEnvelopeV1(parsed)) {
      ownerAccountId = parsed.accountId;
      visibility = parsed.visibility ?? "unlisted";
      metadataJson = JSON.stringify(parsed.metadata);
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

const upsertWriterPointer = async (
  db: VoidSqlStore,
  key: string,
  branchId: string,
): Promise<boolean> => {
  const rest = key.slice(WRITER_BRANCH_KEY_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex <= 0) return false;

  const rootDropId = rest.slice(0, slashIndex);
  const writerKey = stripSuffix(rest.slice(slashIndex + 1), ".txt");
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO branch_writers (root_drop_id, writer_key, branch_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(root_drop_id, writer_key) DO UPDATE SET
         branch_id = excluded.branch_id,
         updated_at = excluded.updated_at`,
    )
    .bind(rootDropId, writerKey, branchId, now, now)
    .run();
  return true;
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

const handleBackfillObject = async (
  env: Required<Pick<MetadataBackfillEnv, "R2_BUCKET" | "DB">>,
  key: string,
  stats: MetadataBackfillStats,
): Promise<void> => {
  if (key.startsWith(REMOTE_DROP_ALIAS_PREFIX)) {
    const fullId = await readObjectText(await env.R2_BUCKET.get(key));
    if (!fullId) {
      stats.invalid += 1;
      return;
    }
    await writeRemoteAliasToD1(
      env.DB,
      key.slice(REMOTE_DROP_ALIAS_PREFIX.length),
      fullId,
    );
    stats.aliasesUpserted += 1;
    return;
  }

  if (isRemotePublicDropIndexKey(key)) {
    const entry = await readPublicDropIndexEntryByKey(env.R2_BUCKET, key);
    if (!entry) {
      stats.invalid += 1;
      return;
    }
    await upsertPublicDropIndexEntry(
      env.R2_BUCKET,
      entry.id,
      entry.updatedAt,
      env.DB,
    );
    stats.publicIndexUpserted += 1;
    return;
  }

  if (key.startsWith(ACCOUNT_RECORD_PREFIX)) {
    const record = await readObjectJson(
      await env.R2_BUCKET.get(key),
      isAccountRecord,
    );
    if (!record) {
      stats.invalid += 1;
      return;
    }
    await putAccountRecord(env.R2_BUCKET, record, env.DB);
    stats.accountsUpserted += 1;
    return;
  }

  if (key.startsWith(BRANCH_KEY_PREFIX)) {
    const branch = await readR2Json(env.R2_BUCKET, key, isDropBranchRecord);
    if (!branch) {
      stats.invalid += 1;
      return;
    }
    await writeBranch(env.R2_BUCKET, branch, env.DB);
    stats.branchesUpserted += 1;
    return;
  }

  if (key.startsWith(WRITER_BRANCH_KEY_PREFIX)) {
    const branchId = await readObjectText(await env.R2_BUCKET.get(key));
    if (!branchId || !(await upsertWriterPointer(env.DB, key, branchId))) {
      stats.invalid += 1;
      return;
    }
    stats.writerPointersUpserted += 1;
    return;
  }

  if (key.startsWith(SNAPSHOT_KEY_PREFIX)) {
    const snapshot = await readR2Json(env.R2_BUCKET, key, isDropSnapshotRecord);
    if (!snapshot) {
      stats.invalid += 1;
      return;
    }
    await writeSnapshot(env.R2_BUCKET, snapshot, env.DB);
    stats.snapshotsUpserted += 1;
    return;
  }

  if (key.startsWith(BRANCH_DIFF_EVENT_KEY_PREFIX)) {
    const event = await readR2Json(env.R2_BUCKET, key, isDropDiffEvent);
    if (!event) {
      stats.invalid += 1;
      return;
    }
    await writeBranchDiffEvent(
      env.R2_BUCKET,
      event.dropId,
      key.slice(BRANCH_DIFF_EVENT_KEY_PREFIX.length).split("/")[1] ?? "",
      event,
      env.DB,
    );
    stats.eventsUpserted += 1;
    return;
  }

  if (key.startsWith(DIFF_AUTH_KEY_PREFIX)) {
    const credential = await readR2Json(
      env.R2_BUCKET,
      key,
      isDiffAuthCredentialRecord,
    );
    if (!credential) {
      stats.invalid += 1;
      return;
    }
    await putDiffAuthCredential(env.R2_BUCKET, credential, env.DB);
    stats.diffCredentialsUpserted += 1;
    return;
  }

  if (key.startsWith(NULLPLUG_UI_RESPONSE_FACT_KEY_PREFIX)) {
    const fact = await readObjectJson(
      await env.R2_BUCKET.get(key),
      isNullplugUiResponseFact,
    );
    if (!fact) {
      stats.invalid += 1;
      return;
    }
    await syncNullplugUiResponseFactToD1(env.DB, fact);
    stats.nullplugFactsUpserted += 1;
    return;
  }

  if (key.startsWith(NULLPLUG_UI_STATE_PATCH_FACT_KEY_PREFIX)) {
    const fact = await readObjectJson(
      await env.R2_BUCKET.get(key),
      isNullplugUiStatePatchFact,
    );
    if (!fact) {
      stats.invalid += 1;
      return;
    }
    await syncNullplugUiStateFactToD1(env.DB, fact);
    stats.nullplugFactsUpserted += 1;
    return;
  }

  if (key.startsWith(NULLPLUG_UI_STATE_SNAPSHOT_KEY_PREFIX)) {
    const fact = await readObjectJson(
      await env.R2_BUCKET.get(key),
      isNullplugUiStateSnapshot,
    );
    if (!fact) {
      stats.invalid += 1;
      return;
    }
    await syncNullplugUiStateFactToD1(env.DB, fact);
    stats.nullplugFactsUpserted += 1;
    return;
  }

  if (key.startsWith(DROP_RESOLVED_HEAP_KEY_PREFIX)) {
    const state = await readObjectJson(
      await env.R2_BUCKET.get(key),
      isResolvedNulldownState,
    );
    if (!state) {
      stats.invalid += 1;
      return;
    }
    await syncResolvedStateToD1(env.DB, state);
    stats.resolvedHeapsUpserted += 1;
    return;
  }

  if (key.startsWith("__")) {
    stats.skipped += 1;
    return;
  }

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
  await writeRemoteAliasToD1(env.DB, toShortDropId(key), key);
  stats.aliasesUpserted += 1;

  if (visibility === "invalid-json") {
    stats.invalid += 1;
    await removePublicDropIndexEntry(env.R2_BUCKET, key, env.DB);
    stats.publicIndexRemoved += 1;
    return;
  }

  stats.dropsUpserted += 1;

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
      if (rawContent) {
        indexContent = rawContent;
      }
    } else {
      try {
        const parsed = await object.json<unknown>();
        if (isDropPayload(parsed) && typeof parsed.content === "string" && parsed.content.trim()) {
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

/** Scans R2 metadata objects and mirrors queryable records into D1. */
export const backfillD1Metadata = async (
  env: MetadataBackfillEnv,
  request: Request,
  logger?: RequestLogger,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return jsonErrorResponse(
      500,
      "bucket_missing",
      "R2 bucket binding is required.",
    );
  }
  if (!env.DB) {
    return jsonErrorResponse(503, "db_missing", "DB D1 binding is required.");
  }

  const token = env.METADATA_BACKFILL_TOKEN ?? env.DROP_INDEX_BACKFILL_TOKEN;
  if (!token) {
    return jsonErrorResponse(
      503,
      "token_missing",
      "METADATA_BACKFILL_TOKEN is required.",
    );
  }
  if (!verifyBearerToken(request, token)) {
    return jsonErrorResponse(401, "unauthorized", "Unauthorized");
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = parseLimit(url.searchParams.get("limit"));
  const listed = await env.R2_BUCKET.list({ limit, cursor });
  const stats = createStats();

  for (const entry of listed.objects) {
    stats.scanned += 1;
    try {
      await handleBackfillObject(
        { R2_BUCKET: env.R2_BUCKET, DB: env.DB },
        entry.key,
        stats,
      );
    } catch (error) {
      stats.failed += 1;
      logger?.warn("metadata.backfill.object_failed", {
        keyRef: toLogRef(entry.key),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return jsonResponse({
    stats,
    cursor: listed.truncated ? listed.cursor : null,
    truncated: listed.truncated,
  });
};
