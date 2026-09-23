import { isDropPayload } from "../../../../../../shared/drop/codecs/draft-pack-v1";
import { decodeDropEnvelope } from "../../../../../../shared/drop/codecs/envelope-v1";
import { isDropIdToken } from "../../../../../../shared/drop/id";
import { verifyAccountLibraryEnvelopeOwnership } from "../../../accounts/library/service";
import { upsertAccountLibraryEntry } from "../../../accounts/library/repository";
import { jsonErrorResponse, jsonResponse } from "../../http/responses";
import { type RequestLogger, toLogRef } from "../../logging/logger";
import {
  createMetadataBackfillStats,
  skipAccountLibraryEntry,
  type MetadataBackfillEnv,
  type MetadataBackfillStats,
} from "./contracts";

interface AccountOwnedDropRow {
  id: string;
}

const backfillAccountLibraryObject = async (
  env: Pick<MetadataBackfillEnv, "R2_BUCKET" | "DB">,
  id: string,
  stats: MetadataBackfillStats,
): Promise<void> => {
  const object = await env.R2_BUCKET.get(id);
  if (!object || !env.DB) {
    skipAccountLibraryEntry(stats, "malformed");
    return;
  }
  let parsed: unknown;
  try {
    parsed = await object.json<unknown>();
  } catch {
    skipAccountLibraryEntry(stats, "malformed");
    return;
  }
  if (isDropPayload(parsed)) {
    skipAccountLibraryEntry(stats, "plaintext");
    return;
  }
  const envelope = decodeDropEnvelope(parsed);
  if (!envelope) {
    skipAccountLibraryEntry(stats, "malformed");
    return;
  }
  const verified = await verifyAccountLibraryEnvelopeOwnership(
    env,
    envelope,
    null,
    null,
  );
  if (!verified.accountId) {
    skipAccountLibraryEntry(
      stats,
      verified.reason === "account_mismatch"
        ? "foreign"
        : "expired_or_untrusted",
    );
    return;
  }

  await upsertAccountLibraryEntry(env.DB, {
    dropId: id,
    accountId: verified.accountId,
    visibility: envelope.visibility ?? "unlisted",
    createdAt: envelope.createdAt,
    updatedAt: object.uploaded?.getTime() ?? Date.now(),
  });
  stats.accountLibraryUpserted += 1;
};

/** Backfills the account-library projection from account-owned drop rows. */
export const backfillAccountLibrary = async (
  env: MetadataBackfillEnv,
  cursor: string | undefined,
  limit: number,
  logger?: RequestLogger,
): Promise<Response> => {
  if (cursor && !isDropIdToken(cursor)) {
    return jsonErrorResponse(
      400,
      "invalid_cursor",
      "Invalid account-library cursor.",
    );
  }

  const statement = cursor
    ? env
        .DB!.prepare(
          `SELECT id FROM drops
         WHERE owner_account_id IS NOT NULL AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
        )
        .bind(cursor, limit)
    : env
        .DB!.prepare(
          `SELECT id FROM drops
         WHERE owner_account_id IS NOT NULL
         ORDER BY id ASC
         LIMIT ?`,
        )
        .bind(limit);
  const rows = (await statement.all<AccountOwnedDropRow>()).results ?? [];
  const stats = createMetadataBackfillStats();

  for (const row of rows) {
    stats.scanned += 1;
    try {
      await backfillAccountLibraryObject(env, row.id, stats);
    } catch (error) {
      stats.failed += 1;
      logger?.warn("metadata.account_library_backfill.object_failed", {
        keyRef: toLogRef(row.id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const nextCursor = rows.length === limit ? (rows.at(-1)?.id ?? null) : null;
  return jsonResponse({
    mode: "account-library",
    stats,
    cursor: nextCursor,
    truncated: nextCursor !== null,
  });
};
