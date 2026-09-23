import {
  type DropBranchRecord,
  type DropSnapshotRecord,
} from "../../../../shared/drop/branch";
import { isDropPayload } from "../../../../shared/drop/codecs/draft-pack-v1";
import { decodeDropEnvelope } from "../../../../shared/drop/codecs/envelope-v1";
import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../src/server/ports";
import { decryptProviderEscrowEnvelope } from "../crypto/envelopes/provider-escrow";
import {
  DEFAULT_CHECKPOINT_INTERVAL,
  OWNER_BRANCH_ID,
  createBranchDiffEventIdKey,
  createCloneBranchId,
  createWriterBranchKey,
  createWriterKey,
} from "./storage/keys";
import { createBranchDiffRepository } from "./storage/diff-log";
import {
  withBranchMutationLock,
  type BranchMutationLockContext,
} from "./storage/mutation-lock";
import {
  createBranchRepository,
  readR2Text,
  resolveSnapshotCheckpointKey,
} from "./storage/repository";

/** Root drop material required to initialize or resolve branch timelines. */
export interface RootDropState {
  rootDropId: string;
  ownerAccountId: string | null;
  baseContent: string;
}

/** Reads root drop ownership and plaintext content needed for branch creation. */
export const readRootDropState = async (
  bucket: BlobObjectStore,
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

  const envelope = decodeDropEnvelope(parsedJson);
  if (envelope) {
    if (!rawProviderPrivateKey) {
      return null;
    }

    try {
      const payload = await decryptProviderEscrowEnvelope(
        envelope,
        rawProviderPrivateKey,
      );
      return {
        rootDropId,
        ownerAccountId: envelope.accountId,
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
  bucket: BlobObjectStore,
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

  const envelope = decodeDropEnvelope(parsed);
  if (envelope) {
    return envelope.accountId;
  }

  if (
    isDropPayload(parsed) &&
    typeof parsed.metadata?.ownerAccountId === "string"
  ) {
    return parsed.metadata.ownerAccountId;
  }

  return null;
};

/** Upgrades a branch to heap-v2 event storage while the caller holds its mutation fence. */
export const ensureBranchHeapV2ForMutation = async (
  bucket: BlobObjectStore,
  branch: DropBranchRecord,
  lock: BranchMutationLockContext,
  db?: SqlMetadataStore,
  expectedEtag?: string,
): Promise<DropBranchRecord> => {
  const branchRepository = createBranchRepository({ blobs: bucket, sql: db });
  const branchDiffRepository = createBranchDiffRepository({
    blobs: bucket,
    sql: db,
  });
  if (
    branch.snapshotHeapVersion === 2 &&
    typeof branch.headEventSeq === "number"
  ) {
    return branch;
  }

  // The migration writes canonical event objects before publishing the branch head.
  await lock.beginCommit();

  const legacyEvents = await branchDiffRepository.readLegacyBranchDiffLog(
    branch.rootDropId,
    branch.branchId,
  );
  const snapshots = await branchRepository.listSnapshotsForBranch(
    branch.rootDropId,
    branch.branchId,
  );
  const snapshotsById = new Map(
    snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]),
  );
  const snapshotIdByEventId = new Map<string, number>();
  const visitedSnapshotIds = new Set<number>();
  let snapshotId: number | null = branch.headSnapshotId;
  while (snapshotId !== null && !visitedSnapshotIds.has(snapshotId)) {
    visitedSnapshotIds.add(snapshotId);
    const snapshot = snapshotsById.get(snapshotId);
    if (
      !snapshot ||
      snapshot.rootDropId !== branch.rootDropId ||
      snapshot.branchId !== branch.branchId
    ) {
      break;
    }
    snapshot.eventIds.forEach((eventId) => {
      if (!snapshotIdByEventId.has(eventId)) {
        snapshotIdByEventId.set(eventId, snapshot.snapshotId);
      }
    });
    if (
      snapshot.parentSnapshotId !== null &&
      snapshot.parentSnapshotId >= snapshot.snapshotId
    ) {
      break;
    }
    snapshotId = snapshot.parentSnapshotId;
  }
  const normalizedLegacyEvents = legacyEvents.map((event) => ({
    ...event,
    ...(event.snapshotId === undefined && snapshotIdByEventId.has(event.eventId)
      ? { snapshotId: snapshotIdByEventId.get(event.eventId)! }
      : {}),
  }));

  if (normalizedLegacyEvents.length > 0) {
    // Migration is additive: copy legacy log entries into per-seq objects before flipping the branch version.
    await Promise.all(
      normalizedLegacyEvents.map((event) =>
        branchDiffRepository.writeBranchDiffEvent(
          branch.rootDropId,
          branch.branchId,
          event,
        ),
      ),
    );

    await Promise.all(
      normalizedLegacyEvents.map((event) =>
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

  const maxSeq = normalizedLegacyEvents.length
    ? Math.max(...normalizedLegacyEvents.map((event) => event.seq))
    : await branchDiffRepository.readBranchHeadEventSeq(
        branch.rootDropId,
        branch.branchId,
      );

  const upgraded: DropBranchRecord = {
    ...branch,
    snapshotHeapVersion: 2,
    headEventSeq: maxSeq,
    checkpointInterval: Math.max(
      1,
      branch.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL,
    ),
  };

  if (!(await branchRepository.writeBranch(upgraded, expectedEtag))) {
    throw new Error("branch_head_fenced_write_failed");
  }
  await Promise.all(
    normalizedLegacyEvents.map((event) => {
      if (event.snapshotId === undefined) {
        return Promise.resolve();
      }
      return branchDiffRepository.writeBranchDiffEventIdMarker(
        branch.rootDropId,
        branch.branchId,
        event,
      );
    }),
  );
  return upgraded;
};

/** Upgrades a branch to heap-v2 event storage without removing legacy fallback data. */
export const ensureBranchSnapshotHeap = async (
  bucket: BlobObjectStore,
  branch: DropBranchRecord,
  db?: SqlMetadataStore,
): Promise<DropBranchRecord> => {
  if (
    branch.snapshotHeapVersion === 2 &&
    typeof branch.headEventSeq === "number"
  ) {
    return branch;
  }

  const branchRepository = createBranchRepository({ blobs: bucket, sql: db });
  return withBranchMutationLock(
    bucket,
    branch.rootDropId,
    branch.branchId,
    async (lock) => {
      const current = await branchRepository.readBranchWithEtag(
        branch.rootDropId,
        branch.branchId,
      );
      if (!current) {
        throw new Error("Branch not found.");
      }
      return ensureBranchHeapV2ForMutation(
        bucket,
        current.branch,
        lock,
        db,
        current.etag,
      );
    },
  );
};

const readWriterBranchId = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  writerKey: string,
  db?: SqlMetadataStore,
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

  const writerPointer = await bucket.get(
    createWriterBranchKey(rootDropId, writerKey),
  );
  return (await readR2Text(writerPointer))?.trim() || null;
};

const writeWriterBranchId = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  writerKey: string,
  branchId: string,
  db?: SqlMetadataStore,
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
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
  mode: DropBranchRecord["mode"],
  ownerAccountId: string | null,
  writerAccountId: string | null,
  writerClientId: string | null,
  baseContent: string,
  db?: SqlMetadataStore,
): Promise<DropBranchRecord> => {
  const branchRepository = createBranchRepository({ blobs: bucket, sql: db });
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
    branchRepository.writeBranch(branch),
    branchRepository.writeSnapshot(snapshot),
    branchRepository.writeSnapshotCheckpoint(
      rootDropId,
      branchId,
      0,
      baseContent,
      initialCheckpointKey,
    ),
    branchRepository.writeBranchDiffLog(rootDropId, branchId, []),
  ]);

  return branch;
};

/** Resolves or creates the branch assigned to an authenticated actor/client pair. */
export const resolveBranchForActor = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  accountId: string | null,
  clientId: string | null,
  rawProviderPrivateKey?: string,
  db?: SqlMetadataStore,
): Promise<{ branch: DropBranchRecord; created: boolean }> => {
  const branchRepository = createBranchRepository({ blobs: bucket, sql: db });
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
    const existing = await branchRepository.readBranch(
      rootDropId,
      OWNER_BRANCH_ID,
    );
    if (existing) {
      const upgraded = await ensureBranchSnapshotHeap(bucket, existing, db);
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
  const existingBranchId = await readWriterBranchId(
    bucket,
    rootDropId,
    writerKey,
    db,
  );
  if (existingBranchId) {
    const existingBranch = await branchRepository.readBranch(
      rootDropId,
      existingBranchId,
    );
    if (existingBranch) {
      const upgraded = await ensureBranchSnapshotHeap(bucket, existingBranch, db);
      return { branch: upgraded, created: false };
    }
  }

  const branchId = createCloneBranchId(writerKey);
  const existing = await branchRepository.readBranch(rootDropId, branchId);
  if (existing) {
    const upgraded = await ensureBranchSnapshotHeap(bucket, existing, db);
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
export const backfillBranchToSnapshotHeap = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
  db?: SqlMetadataStore,
): Promise<DropBranchRecord | null> => {
  const branchRepository = createBranchRepository({ blobs: bucket, sql: db });
  const existing = await branchRepository.readBranch(rootDropId, branchId);
  if (!existing) {
    return null;
  }

  return withBranchMutationLock(bucket, rootDropId, branchId, async (lock) => {
    const current = await branchRepository.readBranchWithEtag(rootDropId, branchId);
    if (!current) {
      return null;
    }

    return ensureBranchHeapV2ForMutation(
      bucket,
      current.branch,
      lock,
      db,
      current.etag,
    );
  });
};
