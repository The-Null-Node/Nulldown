import type { R2Bucket } from "@cloudflare/workers-types";
import {
  type DropBranchRecord,
  type DropSnapshotRecord,
} from "../../../shared/drop/branch";
import { isDropEnvelopeV1, isDropPayload } from "../../../shared/drop/types";
import { decryptProviderEscrowEnvelope } from "./providerEscrow";
import {
  DEFAULT_CHECKPOINT_INTERVAL,
  OWNER_BRANCH_ID,
  createBranchDiffEventIdKey,
  createBranchDiffEventKey,
  createCloneBranchId,
  createWriterBranchKey,
  createWriterKey,
} from "./branchKeys";
import {
  readBranchHeadEventSeq,
  readLegacyBranchDiffLog,
} from "./branchDiffLogRepository";
import { withBranchMutationLock } from "./branchMutationLock";
import {
  readBranch,
  readR2Text,
  resolveSnapshotCheckpointKey,
  writeBranch,
  writeBranchDiffLog,
  writeR2JsonIfAbsent,
  writeSnapshot,
  writeSnapshotCheckpoint,
} from "./branchRepository";

/** Root drop material required to initialize or resolve branch timelines. */
export interface RootDropState {
  rootDropId: string;
  ownerAccountId: string | null;
  baseContent: string;
}

/** Reads root drop ownership and plaintext content needed for branch creation. */
export const readRootDropState = async (
  bucket: R2Bucket,
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
  bucket: R2Bucket,
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

  if (isDropPayload(parsed) && typeof parsed.metadata?.ownerAccountId === "string") {
    return parsed.metadata.ownerAccountId;
  }

  return null;
};

/** Upgrades a branch to heap-v2 event storage without removing legacy fallback data. */
export const ensureBranchHeapV2 = async (
  bucket: R2Bucket,
  branch: DropBranchRecord,
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
        writeR2JsonIfAbsent(
          bucket,
          createBranchDiffEventKey(branch.rootDropId, branch.branchId, event.seq),
          event,
        ),
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
    : await readBranchHeadEventSeq(bucket, branch.rootDropId, branch.branchId);

  const upgraded: DropBranchRecord = {
    ...branch,
    snapshotHeapVersion: 2,
    headEventSeq: maxSeq,
    checkpointInterval: Math.max(
      1,
      branch.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL,
    ),
  };

  await writeBranch(bucket, upgraded);
  return upgraded;
};

const createInitialBranchState = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  mode: DropBranchRecord["mode"],
  ownerAccountId: string | null,
  writerAccountId: string | null,
  writerClientId: string | null,
  baseContent: string,
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
  const initialCheckpointKey = resolveSnapshotCheckpointKey(rootDropId, branchId, 0);
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
    writeBranch(bucket, branch),
    writeSnapshot(bucket, snapshot),
    writeSnapshotCheckpoint(bucket, rootDropId, branchId, 0, baseContent, initialCheckpointKey),
    writeBranchDiffLog(bucket, rootDropId, branchId, []),
  ]);

  return branch;
};

/** Resolves or creates the branch assigned to an authenticated actor/client pair. */
export const resolveBranchForActor = async (
  bucket: R2Bucket,
  rootDropId: string,
  accountId: string | null,
  clientId: string | null,
  rawProviderPrivateKey?: string,
): Promise<{ branch: DropBranchRecord; created: boolean }> => {
  const ownerAccountId = await getOwnerAccountIdForDrop(bucket, rootDropId);
  const rootState = await readRootDropState(bucket, rootDropId, rawProviderPrivateKey);
  if (!rootState) {
    throw new Error(
      "Remote branch editing is not available for encrypted drop envelopes yet.",
    );
  }

  if (ownerAccountId && accountId === ownerAccountId) {
    const existing = await readBranch(bucket, rootDropId, OWNER_BRANCH_ID);
    if (existing) {
      const upgraded = await ensureBranchHeapV2(bucket, existing);
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
    );
    return { branch: created, created: true };
  }

  const writerKey = createWriterKey(accountId, clientId);
  const writerPointer = await bucket.get(createWriterBranchKey(rootDropId, writerKey));
  const existingBranchId = (await readR2Text(writerPointer))?.trim() || null;
  if (existingBranchId) {
    const existingBranch = await readBranch(bucket, rootDropId, existingBranchId);
    if (existingBranch) {
      const upgraded = await ensureBranchHeapV2(bucket, existingBranch);
      return { branch: upgraded, created: false };
    }
  }

  const branchId = createCloneBranchId(writerKey);
  const existing = await readBranch(bucket, rootDropId, branchId);
  if (existing) {
    const upgraded = await ensureBranchHeapV2(bucket, existing);
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
  );

  await bucket.put(createWriterBranchKey(rootDropId, writerKey), branchId, {
    httpMetadata: { contentType: "text/plain" },
  });

  return { branch: created, created: true };
};

/** Migrates one branch to heap-v2 snapshot/event storage under the branch mutation lock. */
export const backfillBranchToSnapshotHeapV2 = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<DropBranchRecord | null> => {
  const existing = await readBranch(bucket, rootDropId, branchId);
  if (!existing) {
    return null;
  }

  return withBranchMutationLock(bucket, rootDropId, branchId, async () => {
    const latest = await readBranch(bucket, rootDropId, branchId);
    if (!latest) {
      return null;
    }

    return ensureBranchHeapV2(bucket, latest);
  });
};
