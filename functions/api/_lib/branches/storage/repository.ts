import {
  type DropBranchRecord,
  type DropSnapshotRecord,
  isDropBranchRecord,
  isDropSnapshotRecord,
} from "../../../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../../../shared/drop/diff";
import type {
  VoidBlobStore,
  VoidSqlStore,
} from "../../../../../src/server/ports";
import { booleanToSqlite, parseJsonColumn } from "../../core/d1/metadata";
import {
  BRANCH_KEY_PREFIX,
  SNAPSHOT_KEY_PREFIX,
  createBranchDiffLogKey,
  createBranchKey,
  createCheckpointKey,
  createSnapshotKey,
} from "./keys";

/** Reads a blob object body as text, returning null for missing or unreadable bodies. */
export const readR2Text = async (
  object: { text: () => Promise<string> } | null,
): Promise<string | null> => {
  if (!object) {
    return null;
  }

  try {
    return await object.text();
  } catch {
    return null;
  }
};

/** Reads and validates a JSON blob object. */
export const readR2Json = async <T>(
  bucket: VoidBlobStore,
  key: string,
  guard: (value: unknown) => value is T,
): Promise<T | null> => {
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await object.json();
  } catch {
    return null;
  }

  return guard(parsed) ? parsed : null;
};

/** Writes a JSON value to blob storage. */
export const writeR2Json = async (
  bucket: VoidBlobStore,
  key: string,
  value: unknown,
): Promise<void> => {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
};

/** Writes a JSON value only when the target blob key is absent. */
export const writeR2JsonIfAbsent = async (
  bucket: VoidBlobStore,
  key: string,
  value: unknown,
): Promise<boolean> => {
  const written = await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return Boolean(written);
};

/** Reads a branch record by root and branch id. */
export const readBranch = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  db?: VoidSqlStore,
): Promise<DropBranchRecord | null> =>
  db
    ? (parseJsonColumn(
        (
          await db
            .prepare(
              `SELECT record_json FROM branches WHERE root_drop_id = ? AND branch_id = ?`,
            )
            .bind(rootDropId, branchId)
            .first<{ record_json: string }>()
        )?.record_json,
        isDropBranchRecord,
      ) ??
      (await readR2Json(
        bucket,
        createBranchKey(rootDropId, branchId),
        isDropBranchRecord,
      )))
    : readR2Json(
        bucket,
        createBranchKey(rootDropId, branchId),
        isDropBranchRecord,
      );

/** Writes a branch record to D1 and its canonical R2 fallback key. */
export const writeBranch = async (
  bucket: VoidBlobStore,
  branch: DropBranchRecord,
  db?: VoidSqlStore,
): Promise<void> => {
  if (db) {
    await db
      .prepare(
        `INSERT INTO branches (
           root_drop_id, branch_id, base_drop_id, mode, status, owner_account_id,
           writer_account_id, writer_client_id, head_snapshot_id, snapshot_heap_version,
           head_event_seq, checkpoint_interval, created_at, updated_at, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_drop_id, branch_id) DO UPDATE SET
           base_drop_id = excluded.base_drop_id,
           mode = excluded.mode,
           status = excluded.status,
           owner_account_id = excluded.owner_account_id,
           writer_account_id = excluded.writer_account_id,
           writer_client_id = excluded.writer_client_id,
           head_snapshot_id = excluded.head_snapshot_id,
           snapshot_heap_version = excluded.snapshot_heap_version,
           head_event_seq = excluded.head_event_seq,
           checkpoint_interval = excluded.checkpoint_interval,
           updated_at = excluded.updated_at,
           record_json = excluded.record_json`,
      )
      .bind(
        branch.rootDropId,
        branch.branchId,
        branch.baseDropId,
        branch.mode,
        branch.status,
        branch.ownerAccountId,
        branch.writerAccountId,
        branch.writerClientId,
        branch.headSnapshotId,
        branch.snapshotHeapVersion ?? null,
        branch.headEventSeq ?? null,
        branch.checkpointInterval ?? null,
        branch.createdAt,
        branch.updatedAt,
        JSON.stringify(branch),
      )
      .run();
  }
  await writeR2Json(
    bucket,
    createBranchKey(branch.rootDropId, branch.branchId),
    branch,
  );
};

/** Reads a snapshot record by root, branch, and snapshot id. */
export const readSnapshot = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  db?: VoidSqlStore,
): Promise<DropSnapshotRecord | null> =>
  db
    ? (parseJsonColumn(
        (
          await db
            .prepare(
              `SELECT record_json
               FROM branch_snapshots
               WHERE root_drop_id = ? AND branch_id = ? AND snapshot_id = ?`,
            )
            .bind(rootDropId, branchId, snapshotId)
            .first<{ record_json: string }>()
        )?.record_json,
        isDropSnapshotRecord,
      ) ??
      (await readR2Json(
        bucket,
        createSnapshotKey(rootDropId, branchId, snapshotId),
        isDropSnapshotRecord,
      )))
    : readR2Json(
        bucket,
        createSnapshotKey(rootDropId, branchId, snapshotId),
        isDropSnapshotRecord,
      );

/** Writes a snapshot record to D1 and its canonical R2 fallback key. */
export const writeSnapshot = async (
  bucket: VoidBlobStore,
  snapshot: DropSnapshotRecord,
  db?: VoidSqlStore,
): Promise<void> => {
  if (db) {
    await db
      .prepare(
        `INSERT INTO branch_snapshots (
           root_drop_id, branch_id, snapshot_id, parent_snapshot_id, seq,
           checkpointed, patch_start_seq, patch_end_seq, checkpoint_key,
           text_length, created_at, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_drop_id, branch_id, snapshot_id) DO UPDATE SET
           parent_snapshot_id = excluded.parent_snapshot_id,
           seq = excluded.seq,
           checkpointed = excluded.checkpointed,
           patch_start_seq = excluded.patch_start_seq,
           patch_end_seq = excluded.patch_end_seq,
           checkpoint_key = excluded.checkpoint_key,
           text_length = excluded.text_length,
           record_json = excluded.record_json`,
      )
      .bind(
        snapshot.rootDropId,
        snapshot.branchId,
        snapshot.snapshotId,
        snapshot.parentSnapshotId,
        snapshot.seq,
        booleanToSqlite(snapshot.checkpointed),
        snapshot.patchStartSeq ?? null,
        snapshot.patchEndSeq ?? null,
        snapshot.checkpointKey ?? null,
        snapshot.textLength,
        snapshot.createdAt,
        JSON.stringify(snapshot),
      )
      .run();
  }
  await writeR2Json(
    bucket,
    createSnapshotKey(
      snapshot.rootDropId,
      snapshot.branchId,
      snapshot.snapshotId,
    ),
    snapshot,
  );
};

/** Resolves a snapshot checkpoint key, honoring explicit historical keys. */
export const resolveSnapshotCheckpointKey = (
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  explicitKey?: string,
): string =>
  explicitKey && explicitKey.trim().length > 0
    ? explicitKey
    : createCheckpointKey(rootDropId, branchId, snapshotId);

/** Reads a branch snapshot checkpoint body. */
export const readSnapshotCheckpoint = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  explicitKey?: string,
): Promise<string | null> => {
  const object = await bucket.get(
    resolveSnapshotCheckpointKey(rootDropId, branchId, snapshotId, explicitKey),
  );
  return readR2Text(object);
};

/** Writes a branch snapshot checkpoint body. */
export const writeSnapshotCheckpoint = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  content: string,
  explicitKey?: string,
): Promise<void> => {
  await bucket.put(
    resolveSnapshotCheckpointKey(rootDropId, branchId, snapshotId, explicitKey),
    content,
    {
      httpMetadata: { contentType: "text/plain" },
    },
  );
};

/** Writes the legacy full branch diff log. */
export const writeBranchDiffLog = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  events: DropDiffEvent[],
): Promise<void> => {
  await writeR2Json(
    bucket,
    createBranchDiffLogKey(rootDropId, branchId),
    events,
  );
};

/** Lists snapshot records for a branch, sorted by snapshot id. */
export const listSnapshotsForBranch = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  db?: VoidSqlStore,
): Promise<DropSnapshotRecord[]> => {
  if (db) {
    const rows = await db
      .prepare(
        `SELECT record_json
         FROM branch_snapshots
         WHERE root_drop_id = ? AND branch_id = ?
         ORDER BY snapshot_id ASC`,
      )
      .bind(rootDropId, branchId)
      .all<{ record_json: string }>();
    const snapshots = (rows.results ?? [])
      .map((row) => parseJsonColumn(row.record_json, isDropSnapshotRecord))
      .filter((entry): entry is DropSnapshotRecord => Boolean(entry));
    if (snapshots.length > 0) return snapshots;
  }

  const listed = await bucket.list({
    prefix: `${SNAPSHOT_KEY_PREFIX}${rootDropId}/${branchId}/`,
    limit: 1000,
  });
  const snapshots = await Promise.all(
    listed.objects.map((entry) =>
      readR2Json(bucket, entry.key, isDropSnapshotRecord),
    ),
  );

  return snapshots
    .filter((entry): entry is DropSnapshotRecord => Boolean(entry))
    .sort((a, b) => a.snapshotId - b.snapshotId);
};

/** Lists branch records for a root drop, sorted by creation time. */
export const listBranchesForRoot = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  db?: VoidSqlStore,
): Promise<DropBranchRecord[]> => {
  if (db) {
    const rows = await db
      .prepare(
        `SELECT record_json
         FROM branches
         WHERE root_drop_id = ?
         ORDER BY created_at ASC`,
      )
      .bind(rootDropId)
      .all<{ record_json: string }>();
    const branches = (rows.results ?? [])
      .map((row) => parseJsonColumn(row.record_json, isDropBranchRecord))
      .filter((entry): entry is DropBranchRecord => Boolean(entry));
    if (branches.length > 0) return branches;
  }

  const listed = await bucket.list({
    prefix: `${BRANCH_KEY_PREFIX}${rootDropId}/`,
    limit: 1000,
  });
  const branches = await Promise.all(
    listed.objects.map((entry) =>
      readR2Json(bucket, entry.key, isDropBranchRecord),
    ),
  );

  return branches
    .filter((entry): entry is DropBranchRecord => Boolean(entry))
    .sort((a, b) => a.createdAt - b.createdAt);
};

/** Paged branch-record listing for root-level maintenance jobs. */
export const listBranchesForRootPage = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  limit: number,
  cursor?: string,
  db?: VoidSqlStore,
): Promise<{
  branches: DropBranchRecord[];
  cursor: string | null;
  truncated: boolean;
}> => {
  if (db) {
    const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
    const normalizedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = await db
      .prepare(
        `SELECT record_json
         FROM branches
         WHERE root_drop_id = ?
         ORDER BY created_at ASC
         LIMIT ? OFFSET ?`,
      )
      .bind(rootDropId, normalizedLimit + 1, offset)
      .all<{ record_json: string }>();
    const parsed = (rows.results ?? [])
      .map((row) => parseJsonColumn(row.record_json, isDropBranchRecord))
      .filter((entry): entry is DropBranchRecord => Boolean(entry));
    if (parsed.length > 0) {
      return {
        branches: parsed.slice(0, normalizedLimit),
        cursor:
          parsed.length > normalizedLimit
            ? String(offset + normalizedLimit)
            : null,
        truncated: parsed.length > normalizedLimit,
      };
    }
  }

  const listed = await bucket.list({
    prefix: `${BRANCH_KEY_PREFIX}${rootDropId}/`,
    limit: Math.max(1, Math.min(1000, Math.floor(limit))),
    cursor,
  });
  const branches = await Promise.all(
    listed.objects.map((entry) =>
      readR2Json(bucket, entry.key, isDropBranchRecord),
    ),
  );

  return {
    branches: branches
      .filter((entry): entry is DropBranchRecord => Boolean(entry))
      .sort((a, b) => a.createdAt - b.createdAt),
    cursor: listed.truncated && listed.cursor ? listed.cursor : null,
    truncated: listed.truncated,
  };
};
