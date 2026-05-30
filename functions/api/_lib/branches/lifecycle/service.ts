import {
  type DropBranchRecord,
  type DropSnapshotRecord,
} from "../../../../../shared/drop/branch";
import { isDropEnvelopeV1, isDropPayload } from "../../../../../shared/drop/types";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import { decryptProviderEscrowEnvelope } from "../../crypto/envelopes/providerEscrow";
import {
  DEFAULT_CHECKPOINT_INTERVAL,
  OWNER_BRANCH_ID,
  createBranchDiffEventIdKey,
  createCloneBranchId,
  createWriterBranchKey,
  createWriterKey,
} from "../storage/keys";
import {
  readBranchHeadEventSeq,
  readLegacyBranchDiffLog,
  writeBranchDiffEvent,
} from "../storage/diffLogRepository";
import { withBranchMutationLock } from "../storage/mutationLock";
import {
  readBranch,
  readR2Text,
  resolveSnapshotCheckpointKey,
  writeBranch,
  writeBranchDiffLog,
  writeSnapshot,
  writeSnapshotCheckpoint,
} from "../storage/repository";

/** Root drop material required to initialize or resolve branch timelines. */
export interface RootDropState {
  rootDropId: string;
  ownerAccountId: string | null;
  baseContent: string;
}

/** Reads root drop ownership and plaintext content needed for branch creation. */
export const readRootDropState = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  rawProviderPrivateKey?: string,
): Promise<RootDropState | null> => {
  const object = await bucket.get(rootDropId);
  const raw = await readR2Text(object);
  if (raw === null) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return {
      rootDropId,
      ownerAccountId: null,
      baseContent: raw,
    };
  }

  if (isDropEnvelopeV1(parsedJson)) {
    if (!rawProviderPrivateKey) {
      return null;
    }

    try {
      const payload = await decryptProviderEscrowEnvelope(
        parsedJson,
        rawProviderPrivateKey,
      );
      return {
        rootDropId,
        ownerAccountId: parsedJson.accountId,
        baseContent: payload.content,
      };
    } catch {
      return null;
    }
  }

  if (isDropPayload(parsedJson)) {
    return {
      rootDropId,
      ownerAccountId:
        typeof parsedJson.metadata?.ownerAccountId === "string"
          ? parsedJson.metadata.ownerAccountId
          : null,
      baseContent: parsedJson.content,
    };
  }

  return {
    rootDropId,
    ownerAccountId: null,
    baseContent: raw,
  };
};

/** Reads the owning account id for a root drop without materializing branch content. */
export const getOwnerAccountIdForDrop = async (
  bucket: VoidBlobStore,
  rootDropId: string,
): Promise<string | null> => {
  const object = await bucket.get(rootDropId);
  if (!object) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await object.json();
  } catch {
    return null;
  }

  if (isDropEnvelopeV1(parsed)) {
    return parsed.accountId;
  }

  if (
    isDropPayload(parsed) &&
    typeof parsed.metadata?.ownerAccountId === "string"
  ) {
    return parsed.metadata.ownerAccountId;
  }

  return null;
};

/** Upgrades a branch to heap-v2 event storage without removing legacy fallback data. */
export const ensureBranchHeapV2 = async (
  bucket: VoidBlobStore,
  branch: DropBranchRecord,
  db?: VoidSqlStore,
): Promise<DropBranchRecord> => {
  if (
    branch.snapshotHeapVersion === 2 &&
    typeof branch.headEventSeq === "number"
  ) {
    return branch;
  }

  const legacyEvents = await readLegacyBranchDiffLog(
    bucket,
    branch.rootDropId,
    branch.branchId,
  );

  if (legacyEvents.length > 0) {
    // Migration is additive: copy legacy log entries into per-seq objects before flipping the branch version.
    await Promise.all(
      legacyEvents.map((event) =>
        writeBranchDiffEvent(bucket, branch.rootDropId, branch.branchId, event, db),
      ),
    );

    await Promise.all(
      legacyEvents.map((event) =>
        bucket.put(
          createBranchDiffEventIdKey(
            branch.rootDropId,
            branch.branchId,
            event.eventId,
          ),
          String(event.seq),
          {
            httpMetadata: { contentType: "text/plain" },
            onlyIf: { etagDoesNotMatch: "*" },
          },
        ),
      ),
    );
  }

  const maxSeq = legacyEvents.length
    ? Math.max(...legacyEvents.map((event) => event.seq))
    : await readBranchHeadEventSeq(bucket, branch.rootDropId, branch.branchId, db);

  const upgraded: DropBranchRecord = {
    ...branch,
    snapshotHeapVersion: 2,
    headEventSeq: maxSeq,
    checkpointInterval: Math.max(
      1,
      branch.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL,
    ),
  };

  await writeBranch(bucket, upgraded, db);
  return upgraded;
};

const readWriterBranchId = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  writerKey: string,
  db?: VoidSqlStore,
): Promise<string | null> => {
  if (db) {
    const row = await db
      .prepare(
        `SELECT branch_id
         FROM branch_writers
         WHERE root_drop_id = ? AND writer_key = ?`,
      )
      .bind(rootDropId, writerKey)
      .first<{ branch_id: string }>();
    if (row?.branch_id) return row.branch_id;
  }

  const writerPointer = await bucket.get(createWriterBranchKey(rootDropId, writerKey));
  return (await readR2Text(writerPointer))?.trim() || null;
};

const writeWriterBranchId = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  writerKey: string,
  branchId: string,
  db?: VoidSqlStore,
): Promise<void> => {
  const now = Date.now();
  if (db) {
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
  }

  await bucket.put(createWriterBranchKey(rootDropId, writerKey), branchId, {
    httpMetadata: { contentType: "text/plain" },
  });
};

const createInitialBranchState = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  mode: DropBranchRecord["mode"],
  ownerAccountId: string | null,
  writerAccountId: string | null,
  writerClientId: string | null,
  baseContent: string,
  db?: VoidSqlStore,
): Promise<DropBranchRecord> => {
  const now = Date.now();
  const branch: DropBranchRecord = {
    version: 1,
    branchId,
    rootDropId,
    baseDropId: rootDropId,
    mode,
    status: "active",
    ownerAccountId,
    writerAccountId,
    writerClientId,
    headSnapshotId: 0,
    snapshotHeapVersion: 2,
    headEventSeq: -1,
    checkpointInterval: DEFAULT_CHECKPOINT_INTERVAL,
    createdAt: now,
    updatedAt: now,
  };
  const initialCheckpointKey = resolveSnapshotCheckpointKey(
    rootDropId,
    branchId,
    0,
  );
  const snapshot: DropSnapshotRecord = {
    version: 1,
    snapshotId: 0,
    rootDropId,
    branchId,
    parentSnapshotId: null,
    seq: 0,
    eventIds: [],
    checkpointed: true,
    patchStartSeq: null,
    patchEndSeq: null,
    checkpointKey: initialCheckpointKey,
    textLength: baseContent.length,
    createdAt: now,
  };

  await Promise.all([
    writeBranch(bucket, branch, db),
    writeSnapshot(bucket, snapshot, db),
    writeSnapshotCheckpoint(
      bucket,
      rootDropId,
      branchId,
      0,
      baseContent,
      initialCheckpointKey,
    ),
    writeBranchDiffLog(bucket, rootDropId, branchId, []),
  ]);

  return branch;
};

/** Resolves or creates the branch assigned to an authenticated actor/client pair. */
export const resolveBranchForActor = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  accountId: string | null,
  clientId: string | null,
  rawProviderPrivateKey?: string,
  db?: VoidSqlStore,
): Promise<{ branch: DropBranchRecord; created: boolean }> => {
  const ownerAccountId = await getOwnerAccountIdForDrop(bucket, rootDropId);
  const rootState = await readRootDropState(
    bucket,
    rootDropId,
    rawProviderPrivateKey,
  );
  if (!rootState) {
    throw new Error(
      "Remote branch editing is not available for encrypted drop envelopes yet.",
    );
  }

  if (ownerAccountId && accountId === ownerAccountId) {
    const existing = await readBranch(bucket, rootDropId, OWNER_BRANCH_ID, db);
    if (existing) {
      const upgraded = await ensureBranchHeapV2(bucket, existing, db);
      return { branch: upgraded, created: false };
    }

    const created = await createInitialBranchState(
      bucket,
      rootDropId,
      OWNER_BRANCH_ID,
      "owner",
      ownerAccountId,
      accountId,
      clientId,
      rootState.baseContent,
      db,
    );
    return { branch: created, created: true };
  }

  const writerKey = createWriterKey(accountId, clientId);
  const existingBranchId = await readWriterBranchId(bucket, rootDropId, writerKey, db);
  if (existingBranchId) {
    const existingBranch = await readBranch(
      bucket,
      rootDropId,
      existingBranchId,
      db,
    );
    if (existingBranch) {
      const upgraded = await ensureBranchHeapV2(bucket, existingBranch, db);
      return { branch: upgraded, created: false };
    }
  }

  const branchId = createCloneBranchId(writerKey);
  const existing = await readBranch(bucket, rootDropId, branchId, db);
  if (existing) {
    const upgraded = await ensureBranchHeapV2(bucket, existing, db);
    return { branch: upgraded, created: false };
  }

  const created = await createInitialBranchState(
    bucket,
    rootDropId,
    branchId,
    "clone",
    ownerAccountId,
    accountId,
    clientId,
    rootState.baseContent,
    db,
  );

  await writeWriterBranchId(bucket, rootDropId, writerKey, branchId, db);

  return { branch: created, created: true };
};

/** Migrates one branch to heap-v2 snapshot/event storage under the branch mutation lock. */
export const backfillBranchToSnapshotHeapV2 = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  db?: VoidSqlStore,
): Promise<DropBranchRecord | null> => {
  const existing = await readBranch(bucket, rootDropId, branchId, db);
  if (!existing) {
    return null;
  }

  return withBranchMutationLock(bucket, rootDropId, branchId, async () => {
    const latest = await readBranch(bucket, rootDropId, branchId, db);
    if (!latest) {
      return null;
    }

    return ensureBranchHeapV2(bucket, latest, db);
  });
};
