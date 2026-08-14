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

/** Ports used by branch storage repositories. */
export interface BranchRepositoryPorts {
  /** Blob store containing canonical branch records and fallback objects. */
  blobs: VoidBlobStore;
  /** Optional SQL store containing queryable branch metadata. */
  sql?: VoidSqlStore;
}

/** Repository for branch records, snapshots, checkpoints, and listings. */
export interface BranchRepository {
  /** Reads a branch record by root and branch id. */
  readBranch(
    rootDropId: string,
    branchId: string,
  ): Promise<DropBranchRecord | null>;
  /** Reads a branch record and its canonical R2 revision. */
  readBranchWithEtag(
    rootDropId: string,
    branchId: string,
  ): Promise<{ branch: DropBranchRecord; etag: string } | null>;
  /** Writes a branch record to durable storage. */
  writeBranch(branch: DropBranchRecord, expectedEtag?: string): Promise<boolean>;
  /** Reads a snapshot record by root, branch, and snapshot id. */
  readSnapshot(
    rootDropId: string,
    branchId: string,
    snapshotId: number,
  ): Promise<DropSnapshotRecord | null>;
  /** Writes a snapshot record to durable storage. */
  writeSnapshot(snapshot: DropSnapshotRecord): Promise<void>;
  /** Reads a branch snapshot checkpoint body. */
  readSnapshotCheckpoint(
    rootDropId: string,
    branchId: string,
    snapshotId: number,
    explicitKey?: string,
  ): Promise<string | null>;
  /** Writes a branch snapshot checkpoint body. */
  writeSnapshotCheckpoint(
    rootDropId: string,
    branchId: string,
    snapshotId: number,
    content: string,
    explicitKey?: string,
  ): Promise<void>;
  /** Writes the legacy full branch diff log. */
  writeBranchDiffLog(
    rootDropId: string,
    branchId: string,
    events: DropDiffEvent[],
  ): Promise<void>;
  /** Lists snapshot records for a branch, sorted by snapshot id. */
  listSnapshotsForBranch(
    rootDropId: string,
    branchId: string,
  ): Promise<DropSnapshotRecord[]>;
  /** Lists branch records for a root drop, sorted by creation time. */
  listBranchesForRoot(rootDropId: string): Promise<DropBranchRecord[]>;
  /** Paged branch-record listing for root-level maintenance jobs. */
  listBranchesForRootPage(
    rootDropId: string,
    limit: number,
    cursor?: string,
  ): Promise<{
    branches: DropBranchRecord[];
    cursor: string | null;
    truncated: boolean;
  }>;
}

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
): Promise<DropBranchRecord | null> => {
  const canonical = await readR2Json(
    bucket,
    createBranchKey(rootDropId, branchId),
    isDropBranchRecord,
  );
  if (canonical || !db) return canonical;
  try {
    return parseJsonColumn(
      (
        await db
          .prepare(
            `SELECT record_json FROM branches WHERE root_drop_id = ? AND branch_id = ?`,
          )
          .bind(rootDropId, branchId)
          .first<{ record_json: string }>()
      )?.record_json,
      isDropBranchRecord,
    );
  } catch {
    return null;
  }
};

/** Reads a canonical R2 branch record with the ETag required for fenced publication. */
export const readBranchWithEtag = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
): Promise<{ branch: DropBranchRecord; etag: string } | null> => {
  const object = await bucket.get(createBranchKey(rootDropId, branchId));
  const etag = object?.etag ?? object?.httpEtag;
  if (!object || !etag) return null;
  try {
    const branch = await object.json<unknown>();
    return isDropBranchRecord(branch) ? { branch, etag } : null;
  } catch {
    return null;
  }
};

/** Writes a branch record to D1 and its canonical R2 fallback key. */
export const writeBranch = async (
  bucket: VoidBlobStore,
  branch: DropBranchRecord,
  db?: VoidSqlStore,
  expectedEtag?: string,
): Promise<boolean> => {
  const written = await bucket.put(
    createBranchKey(branch.rootDropId, branch.branchId),
    JSON.stringify(branch),
    {
      httpMetadata: { contentType: "application/json" },
      ...(expectedEtag ? { onlyIf: { etagMatches: expectedEtag } } : {}),
    },
  );
  if (!written) return false;
  if (db) {
    try {
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
    } catch {
      // R2 is canonical; a failed D1 branch projection is rebuilt later.
    }
  }
  return true;
};

/** Reads a snapshot record by root, branch, and snapshot id. */
export const readSnapshot = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  db?: VoidSqlStore,
): Promise<DropSnapshotRecord | null> => {
  const canonical = await readR2Json(
    bucket,
    createSnapshotKey(rootDropId, branchId, snapshotId),
    isDropSnapshotRecord,
  );
  if (canonical || !db) return canonical;
  try {
    return parseJsonColumn(
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
    );
  } catch {
    return null;
  }
};

/** Writes a snapshot record to D1 and its canonical R2 fallback key. */
export const writeSnapshot = async (
  bucket: VoidBlobStore,
  snapshot: DropSnapshotRecord,
  db?: VoidSqlStore,
): Promise<void> => {
  await writeR2Json(
    bucket,
    createSnapshotKey(snapshot.rootDropId, snapshot.branchId, snapshot.snapshotId),
    snapshot,
  );
  if (db) {
    try {
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
    } catch {
      // R2 is canonical; a failed D1 snapshot projection is rebuilt later.
    }
  }
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
  const snapshots: DropSnapshotRecord[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({
      prefix: `${SNAPSHOT_KEY_PREFIX}${rootDropId}/${branchId}/`,
      cursor,
      limit: 1000,
    });
    const page = await Promise.all(
      listed.objects.map((entry) =>
        readR2Json(bucket, entry.key, isDropSnapshotRecord),
      ),
    );
    snapshots.push(
      ...page.filter((entry): entry is DropSnapshotRecord => Boolean(entry)),
    );
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return snapshots
    .sort((a, b) => a.snapshotId - b.snapshotId);
};

/** Lists branch records for a root drop, sorted by creation time. */
export const listBranchesForRoot = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  db?: VoidSqlStore,
): Promise<DropBranchRecord[]> => {
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

/** Creates a branch repository bound to composed blob and SQL ports. */
export const createBranchRepository = ({
  blobs,
  sql,
}: BranchRepositoryPorts): BranchRepository => ({
  readBranch: (rootDropId, branchId) =>
    readBranch(blobs, rootDropId, branchId, sql),
  readBranchWithEtag: (rootDropId, branchId) =>
    readBranchWithEtag(blobs, rootDropId, branchId),
  writeBranch: (branch, expectedEtag) =>
    writeBranch(blobs, branch, sql, expectedEtag),
  readSnapshot: (rootDropId, branchId, snapshotId) =>
    readSnapshot(blobs, rootDropId, branchId, snapshotId, sql),
  writeSnapshot: (snapshot) => writeSnapshot(blobs, snapshot, sql),
  readSnapshotCheckpoint: (rootDropId, branchId, snapshotId, explicitKey) =>
    readSnapshotCheckpoint(blobs, rootDropId, branchId, snapshotId, explicitKey),
  writeSnapshotCheckpoint: (
    rootDropId,
    branchId,
    snapshotId,
    content,
    explicitKey,
  ) =>
    writeSnapshotCheckpoint(
      blobs,
      rootDropId,
      branchId,
      snapshotId,
      content,
      explicitKey,
    ),
  writeBranchDiffLog: (rootDropId, branchId, events) =>
    writeBranchDiffLog(blobs, rootDropId, branchId, events),
  listSnapshotsForBranch: (rootDropId, branchId) =>
    listSnapshotsForBranch(blobs, rootDropId, branchId, sql),
  listBranchesForRoot: (rootDropId) =>
    listBranchesForRoot(blobs, rootDropId, sql),
  listBranchesForRootPage: (rootDropId, limit, cursor) =>
    listBranchesForRootPage(blobs, rootDropId, limit, cursor, sql),
});
