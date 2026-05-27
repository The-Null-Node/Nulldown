import type { R2Bucket } from "@cloudflare/workers-types";
import {
  type DropBranchRecord,
  type DropSnapshotRecord,
  isDropBranchRecord,
  isDropSnapshotRecord,
} from "../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import {
  BRANCH_KEY_PREFIX,
  SNAPSHOT_KEY_PREFIX,
  createBranchDiffLogKey,
  createBranchKey,
  createCheckpointKey,
  createSnapshotKey,
} from "./branchKeys";

/** Reads an R2 object body as text, returning null for missing or unreadable bodies. */
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

/** Reads and validates a JSON R2 object. */
export const readR2Json = async <T>(
  bucket: R2Bucket,
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

/** Writes a JSON value to R2. */
export const writeR2Json = async (
  bucket: R2Bucket,
  key: string,
  value: unknown,
): Promise<void> => {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
};

/** Writes a JSON value only when the target R2 key is absent. */
export const writeR2JsonIfAbsent = async (
  bucket: R2Bucket,
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
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<DropBranchRecord | null> =>
  readR2Json(bucket, createBranchKey(rootDropId, branchId), isDropBranchRecord);

/** Writes a branch record to its canonical R2 key. */
export const writeBranch = async (
  bucket: R2Bucket,
  branch: DropBranchRecord,
): Promise<void> => {
  await writeR2Json(
    bucket,
    createBranchKey(branch.rootDropId, branch.branchId),
    branch,
  );
};

/** Reads a snapshot record by root, branch, and snapshot id. */
export const readSnapshot = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
): Promise<DropSnapshotRecord | null> =>
  readR2Json(
    bucket,
    createSnapshotKey(rootDropId, branchId, snapshotId),
    isDropSnapshotRecord,
  );

/** Writes a snapshot record to its canonical R2 key. */
export const writeSnapshot = async (
  bucket: R2Bucket,
  snapshot: DropSnapshotRecord,
): Promise<void> => {
  await writeR2Json(
    bucket,
    createSnapshotKey(snapshot.rootDropId, snapshot.branchId, snapshot.snapshotId),
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
  bucket: R2Bucket,
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
  bucket: R2Bucket,
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
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  events: DropDiffEvent[],
): Promise<void> => {
  await writeR2Json(bucket, createBranchDiffLogKey(rootDropId, branchId), events);
};

/** Lists snapshot records for a branch, sorted by snapshot id. */
export const listSnapshotsForBranch = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<DropSnapshotRecord[]> => {
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
  bucket: R2Bucket,
  rootDropId: string,
): Promise<DropBranchRecord[]> => {
  const listed = await bucket.list({
    prefix: `${BRANCH_KEY_PREFIX}${rootDropId}/`,
    limit: 1000,
  });
  const branches = await Promise.all(
    listed.objects.map((entry) => readR2Json(bucket, entry.key, isDropBranchRecord)),
  );

  return branches
    .filter((entry): entry is DropBranchRecord => Boolean(entry))
    .sort((a, b) => a.createdAt - b.createdAt);
};

/** Paged branch-record listing for root-level maintenance jobs. */
export const listBranchesForRootPage = async (
  bucket: R2Bucket,
  rootDropId: string,
  limit: number,
  cursor?: string,
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
    listed.objects.map((entry) => readR2Json(bucket, entry.key, isDropBranchRecord)),
  );

  return {
    branches: branches
      .filter((entry): entry is DropBranchRecord => Boolean(entry))
      .sort((a, b) => a.createdAt - b.createdAt),
    cursor: listed.truncated && listed.cursor ? listed.cursor : null,
    truncated: listed.truncated,
  };
};
