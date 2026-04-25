import type { R2Bucket } from "@cloudflare/workers-types";
import {
  type DropBranchRecord,
  type DropSnapshotRecord,
  isDropBranchRecord,
  isDropSnapshotRecord,
} from "../../../shared/drop/branch";
import {
  type DropDiffEvent,
  type DropDiffOp,
  isDropDiffEvent,
} from "../../../shared/drop/diff";
import { isDropEnvelopeV1, isDropPayload } from "../../../shared/drop/types";
import { decryptProviderEscrowEnvelope } from "./providerEscrow";

const BRANCH_KEY_PREFIX = "__drop_branch__/";
const WRITER_BRANCH_KEY_PREFIX = "__drop_writer_branch__/";
const SNAPSHOT_KEY_PREFIX = "__drop_snapshot__/";
const CHECKPOINT_KEY_PREFIX = "__drop_checkpoint__/";
const BRANCH_DIFF_LOG_KEY_PREFIX = "__drop_branch_diffs__/";

const OWNER_BRANCH_ID = "owner";

interface RootDropState {
  rootDropId: string;
  ownerAccountId: string | null;
  baseContent: string;
}

const encoder = new TextEncoder();

const branchKey = (rootDropId: string, branchId: string) =>
  `${BRANCH_KEY_PREFIX}${rootDropId}/${branchId}.json`;

const writerBranchKey = (rootDropId: string, writerKey: string) =>
  `${WRITER_BRANCH_KEY_PREFIX}${rootDropId}/${writerKey}.txt`;

const snapshotKey = (
  rootDropId: string,
  branchId: string,
  snapshotId: number,
) => `${SNAPSHOT_KEY_PREFIX}${rootDropId}/${branchId}/${snapshotId}.json`;

const checkpointKey = (
  rootDropId: string,
  branchId: string,
  snapshotId: number,
) => `${CHECKPOINT_KEY_PREFIX}${rootDropId}/${branchId}/${snapshotId}.txt`;

const branchDiffLogKey = (rootDropId: string, branchId: string) =>
  `${BRANCH_DIFF_LOG_KEY_PREFIX}${rootDropId}/${branchId}.json`;

const readText = async (
  object: { body?: ReadableStream | null } | null,
): Promise<string | null> => {
  if (!object?.body) {
    return null;
  }

  return new Response(object.body).text();
};

const readJson = async <T>(
  bucket: R2Bucket,
  key: string,
  guard: (value: unknown) => value is T,
): Promise<T | null> => {
  const object = await bucket.get(key);
  if (!object?.body) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await new Response(object.body).json();
  } catch {
    return null;
  }

  return guard(parsed) ? parsed : null;
};

const writeJson = async (
  bucket: R2Bucket,
  key: string,
  value: unknown,
): Promise<void> => {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
};

const applyOp = (text: string, op: DropDiffOp): string => {
  const start = Math.max(0, Math.min(op.start, text.length));
  const end = Math.max(start, Math.min(op.end, text.length));

  if (op.type === "delete") {
    return text.slice(0, start) + text.slice(end);
  }

  return text.slice(0, start) + op.text + text.slice(start);
};

const applyEventOps = (text: string, events: DropDiffEvent[]): string =>
  events.reduce(
    (current, event) =>
      event.ops.reduce((next, op) => applyOp(next, op), current),
    text,
  );

const sanitizeWriterKeyPart = (value: string) =>
  value.replace(/[^A-Za-z0-9._:-]/g, "_");

const buildWriterKey = (
  accountId: string | null,
  clientId: string | null,
): string => {
  if (accountId) {
    return `account:${sanitizeWriterKeyPart(accountId)}`;
  }

  if (clientId) {
    return `client:${sanitizeWriterKeyPart(clientId)}`;
  }

  return "anonymous";
};

const buildCloneBranchId = (writerKey: string): string =>
  `clone_${sanitizeWriterKeyPart(writerKey)}`;

const parseRootPayload = (raw: string): RootDropState | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { rootDropId: "", ownerAccountId: null, baseContent: "" };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isDropEnvelopeV1(parsed)) {
      return null;
    }

    if (isDropPayload(parsed)) {
      return {
        rootDropId: "",
        ownerAccountId: null,
        baseContent: parsed.content,
      };
    }
  } catch {
    return {
      rootDropId: "",
      ownerAccountId: null,
      baseContent: raw,
    };
  }

  return null;
};

export const readRootDropState = async (
  bucket: R2Bucket,
  rootDropId: string,
  rawProviderPrivateKey?: string,
): Promise<RootDropState | null> => {
  const object = await bucket.get(rootDropId);
  const raw = await readText(object);
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

export const getOwnerAccountIdForDrop = async (
  bucket: R2Bucket,
  rootDropId: string,
): Promise<string | null> => {
  const object = await bucket.get(rootDropId);
  if (!object?.body) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await new Response(object.body).json();
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

export const readBranch = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<DropBranchRecord | null> =>
  readJson(bucket, branchKey(rootDropId, branchId), isDropBranchRecord);

export const readSnapshot = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
): Promise<DropSnapshotRecord | null> =>
  readJson(
    bucket,
    snapshotKey(rootDropId, branchId, snapshotId),
    isDropSnapshotRecord,
  );

export const readBranchContent = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
): Promise<string | null> => {
  const object = await bucket.get(
    checkpointKey(rootDropId, branchId, snapshotId),
  );
  return readText(object);
};

export const readBranchDiffLog = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<DropDiffEvent[]> => {
  const object = await bucket.get(branchDiffLogKey(rootDropId, branchId));
  if (!object?.body) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = await new Response(object.body).json();
  } catch {
    return [];
  }

  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => isDropDiffEvent(entry))
  ) {
    return [];
  }

  return parsed;
};

const writeBranchDiffLog = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  events: DropDiffEvent[],
): Promise<void> => {
  await writeJson(bucket, branchDiffLogKey(rootDropId, branchId), events);
};

const writeSnapshotCheckpoint = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  content: string,
): Promise<void> => {
  await bucket.put(checkpointKey(rootDropId, branchId, snapshotId), content, {
    httpMetadata: { contentType: "text/plain" },
  });
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
    createdAt: now,
    updatedAt: now,
  };
  const snapshot: DropSnapshotRecord = {
    version: 1,
    snapshotId: 0,
    rootDropId,
    branchId,
    parentSnapshotId: null,
    seq: 0,
    eventIds: [],
    checkpointed: true,
    textLength: baseContent.length,
    createdAt: now,
  };

  await Promise.all([
    writeJson(bucket, branchKey(rootDropId, branchId), branch),
    writeJson(bucket, snapshotKey(rootDropId, branchId, 0), snapshot),
    writeSnapshotCheckpoint(bucket, rootDropId, branchId, 0, baseContent),
    writeBranchDiffLog(bucket, rootDropId, branchId, []),
  ]);

  return branch;
};

export const resolveBranchForActor = async (
  bucket: R2Bucket,
  rootDropId: string,
  accountId: string | null,
  clientId: string | null,
  rawProviderPrivateKey?: string,
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
    const existing = await readBranch(bucket, rootDropId, OWNER_BRANCH_ID);
    if (existing) {
      return { branch: existing, created: false };
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

  const writerKey = buildWriterKey(accountId, clientId);
  const writerPointer = await bucket.get(
    writerBranchKey(rootDropId, writerKey),
  );
  const existingBranchId = (await readText(writerPointer))?.trim() || null;
  if (existingBranchId) {
    const existingBranch = await readBranch(
      bucket,
      rootDropId,
      existingBranchId,
    );
    if (existingBranch) {
      return { branch: existingBranch, created: false };
    }
  }

  const branchId = buildCloneBranchId(writerKey);
  const existing = await readBranch(bucket, rootDropId, branchId);
  if (existing) {
    return { branch: existing, created: false };
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

  await bucket.put(writerBranchKey(rootDropId, writerKey), branchId, {
    httpMetadata: { contentType: "text/plain" },
  });

  return { branch: created, created: true };
};

export const appendEventsToBranch = async (
  bucket: R2Bucket,
  branch: DropBranchRecord,
  events: DropDiffEvent[],
): Promise<{
  branch: DropBranchRecord;
  snapshot: DropSnapshotRecord;
  content: string;
}> => {
  const currentContent = await readBranchContent(
    bucket,
    branch.rootDropId,
    branch.branchId,
    branch.headSnapshotId,
  );
  if (currentContent === null) {
    throw new Error("Branch head content is missing.");
  }

  const nextContent = applyEventOps(currentContent, events);
  const snapshotId = branch.headSnapshotId + 1;
  const seq = snapshotId;
  const snapshot: DropSnapshotRecord = {
    version: 1,
    snapshotId,
    rootDropId: branch.rootDropId,
    branchId: branch.branchId,
    parentSnapshotId: branch.headSnapshotId,
    seq,
    eventIds: events.map((event) => event.eventId),
    checkpointed: true,
    textLength: nextContent.length,
    createdAt: Date.now(),
  };
  const nextBranch: DropBranchRecord = {
    ...branch,
    headSnapshotId: snapshotId,
    updatedAt: snapshot.createdAt,
  };
  const existingLog = await readBranchDiffLog(
    bucket,
    branch.rootDropId,
    branch.branchId,
  );

  await Promise.all([
    writeJson(
      bucket,
      branchKey(branch.rootDropId, branch.branchId),
      nextBranch,
    ),
    writeJson(
      bucket,
      snapshotKey(branch.rootDropId, branch.branchId, snapshotId),
      snapshot,
    ),
    writeSnapshotCheckpoint(
      bucket,
      branch.rootDropId,
      branch.branchId,
      snapshotId,
      nextContent,
    ),
    writeBranchDiffLog(bucket, branch.rootDropId, branch.branchId, [
      ...existingLog,
      ...events,
    ]),
  ]);

  return {
    branch: nextBranch,
    snapshot,
    content: nextContent,
  };
};

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
      readJson(bucket, entry.key, isDropSnapshotRecord),
    ),
  );

  return snapshots
    .filter((entry): entry is DropSnapshotRecord => Boolean(entry))
    .sort((a, b) => a.snapshotId - b.snapshotId);
};

export const listBranchesForRoot = async (
  bucket: R2Bucket,
  rootDropId: string,
): Promise<DropBranchRecord[]> => {
  const listed = await bucket.list({
    prefix: `${BRANCH_KEY_PREFIX}${rootDropId}/`,
    limit: 1000,
  });
  const branches = await Promise.all(
    listed.objects.map((entry) =>
      readJson(bucket, entry.key, isDropBranchRecord),
    ),
  );

  return branches
    .filter((entry): entry is DropBranchRecord => Boolean(entry))
    .sort((a, b) => a.createdAt - b.createdAt);
};
