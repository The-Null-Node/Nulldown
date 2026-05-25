/*
Branch state is persisted in R2 as branch records, snapshots, checkpoints, and per-event
objects. The core invariants are: mutations are serialized with a coarse lock, snapshots
advance monotonically, and branch content can always be rebuilt from the nearest stored
checkpoint plus the diff event range after it.
*/

import type { R2Bucket } from "@cloudflare/workers-types";
import {
  type DropBranchRecord,
  type DropSnapshotRecord,
  isDropBranchRecord,
  isDropSnapshotRecord,
} from "../../../shared/drop/branch";
import {
  type DropDiffEvent,
  dropDiffOpToDiff,
  isDropDiffEvent,
} from "../../../shared/drop/diff";
import { applyDiff } from "../../../shared/nulledit/textDiff";
import { DiffOp, type Diff } from "../../../shared/nulledit/types";
import { isDropEnvelopeV1, isDropPayload } from "../../../shared/drop/types";
import { decryptProviderEscrowEnvelope } from "./providerEscrow";

const BRANCH_KEY_PREFIX = "__drop_branch__/";
const WRITER_BRANCH_KEY_PREFIX = "__drop_writer_branch__/";
const SNAPSHOT_KEY_PREFIX = "__drop_snapshot__/";
const CHECKPOINT_KEY_PREFIX = "__drop_checkpoint__/";
const BRANCH_DIFF_LOG_KEY_PREFIX = "__drop_branch_diffs__/";
const BRANCH_DIFF_EVENT_KEY_PREFIX = "__drop_branch_diff_events__/";
const BRANCH_DIFF_EVENT_ID_KEY_PREFIX = "__drop_branch_diff_event_ids__/";
const BRANCH_LOCK_KEY_PREFIX = "__drop_branch_lock__/";

const OWNER_BRANCH_ID = "owner";
const DEFAULT_CHECKPOINT_INTERVAL = 24;
const EVENT_SEQ_PAD = 16;
const BRANCH_LOCK_MAX_ATTEMPTS = 120;
const BRANCH_LOCK_BASE_BACKOFF_MS = 8;
const BRANCH_LOCK_STALE_MS = 20_000;

interface RootDropState {
  rootDropId: string;
  ownerAccountId: string | null;
  baseContent: string;
}

export interface BranchAppendObserverContext {
  bucket: R2Bucket;
  branch: DropBranchRecord;
  snapshot: DropSnapshotRecord;
  content: string;
  acceptedEvents: DropDiffEvent[];
  deduplicatedCount: number;
  totalStored: number;
}

export interface BranchAppendObserver {
  id: string;
  onDiffAccepted?(
    event: DropDiffEvent,
    context: BranchAppendObserverContext,
  ): Promise<void> | void;
  onSnapshotCreated?(
    snapshot: DropSnapshotRecord,
    context: BranchAppendObserverContext,
  ): Promise<void> | void;
}

export interface BranchAppendObserverOptions {
  observers?: BranchAppendObserver[];
  waitUntil?: (promise: Promise<void>) => void;
  onObserverError?: (error: unknown, observerId: string) => void;
}

interface AppendEventsToBranchResult {
  branch: DropBranchRecord;
  snapshot: DropSnapshotRecord | null;
  content: string;
  acceptedEvents: DropDiffEvent[];
  deduplicatedCount: number;
  totalStored: number;
}

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

const branchDiffEventPrefix = (rootDropId: string, branchId: string) =>
  `${BRANCH_DIFF_EVENT_KEY_PREFIX}${rootDropId}/${branchId}/`;

const branchDiffEventKey = (
  rootDropId: string,
  branchId: string,
  seq: number,
) =>
  `${branchDiffEventPrefix(rootDropId, branchId)}${String(seq).padStart(EVENT_SEQ_PAD, "0")}.json`;

const branchDiffEventIdKey = (
  rootDropId: string,
  branchId: string,
  eventId: string,
) =>
  `${BRANCH_DIFF_EVENT_ID_KEY_PREFIX}${rootDropId}/${branchId}/${sanitizeWriterKeyPart(eventId)}.txt`;

const branchLockKey = (rootDropId: string, branchId: string) =>
  `${BRANCH_LOCK_KEY_PREFIX}${rootDropId}/${branchId}.json`;

const readText = async (
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

const readJson = async <T>(
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

const writeJson = async (
  bucket: R2Bucket,
  key: string,
  value: unknown,
): Promise<void> => {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
};

const writeJsonIfAbsent = async (
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

const toEditableDiff = (op: DropDiffEvent["ops"][number]): Diff | null => {
  const converted = dropDiffOpToDiff(op);
  if (!converted) {
    return null;
  }

  if (converted.op !== DiffOp.INSERT && converted.op !== DiffOp.DELETE) {
    return null;
  }

  return converted;
};

const applyEventOps = (
  baseContent: string,
  events: DropDiffEvent[],
): string => {
  let currentContent = baseContent;

  events.forEach((event) => {
    const diffs = event.ops
      .map((op) => toEditableDiff(op))
      .filter((entry): entry is Diff => Boolean(entry));
    currentContent = diffs.reduce(
      (text, diff) => applyDiff(text, diff),
      currentContent,
    );
  });

  return currentContent;
};

const dispatchBranchAppendObservers = (
  bucket: R2Bucket,
  result: AppendEventsToBranchResult,
  options?: BranchAppendObserverOptions,
): void => {
  const observers = options?.observers ?? [];
  if (!result.snapshot || result.acceptedEvents.length === 0 || observers.length === 0) {
    return;
  }

  const context: BranchAppendObserverContext = {
    bucket,
    branch: result.branch,
    snapshot: result.snapshot,
    content: result.content,
    acceptedEvents: result.acceptedEvents,
    deduplicatedCount: result.deduplicatedCount,
    totalStored: result.totalStored,
  };

  const observerTask = Promise.all(
    observers.map(async (observer) => {
      try {
        for (const event of result.acceptedEvents) {
          await observer.onDiffAccepted?.(event, context);
        }
        await observer.onSnapshotCreated?.(result.snapshot as DropSnapshotRecord, context);
      } catch (error) {
        options?.onObserverError?.(error, observer.id);
      }
    }),
  ).then(() => undefined);

  if (options?.waitUntil) {
    try {
      options.waitUntil(observerTask);
      return;
    } catch (error) {
      options.onObserverError?.(error, "waitUntil");
    }
  }

  void observerTask;
};

const sleep = async (durationMs: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
};

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

const resolveSnapshotCheckpointKey = (
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  explicitKey?: string,
): string =>
  explicitKey && explicitKey.trim().length > 0
    ? explicitKey
    : checkpointKey(rootDropId, branchId, snapshotId);

const readSnapshotCheckpoint = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  explicitKey?: string,
): Promise<string | null> => {
  const object = await bucket.get(
    resolveSnapshotCheckpointKey(rootDropId, branchId, snapshotId, explicitKey),
  );
  return readText(object);
};

const readEventsBySeqRange = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  startSeq: number,
  endSeq: number,
): Promise<DropDiffEvent[] | null> => {
  if (endSeq < startSeq) {
    return [];
  }

  const eventReads: Promise<DropDiffEvent | null>[] = [];
  for (let seq = startSeq; seq <= endSeq; seq += 1) {
    eventReads.push(
      readJson(
        bucket,
        branchDiffEventKey(rootDropId, branchId, seq),
        isDropDiffEvent,
      ),
    );
  }

  const events = await Promise.all(eventReads);
  const materialized = events
    .filter((entry): entry is DropDiffEvent => Boolean(entry))
    .sort((a, b) => a.seq - b.seq);

  const expectedCount = endSeq - startSeq + 1;
  if (materialized.length !== expectedCount) {
    return null;
  }

  return materialized;
};

export const readBranchEventsBySeqRange = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  startSeq: number,
  endSeq: number,
): Promise<DropDiffEvent[]> =>
  (await readEventsBySeqRange(bucket, rootDropId, branchId, startSeq, endSeq)) ?? [];

export const readBranchContent = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
): Promise<string | null> => {
  const direct = await readSnapshotCheckpoint(
    bucket,
    rootDropId,
    branchId,
    snapshotId,
  );
  if (direct !== null) {
    return direct;
  }

  const targetSnapshot = await readSnapshot(
    bucket,
    rootDropId,
    branchId,
    snapshotId,
  );
  if (!targetSnapshot) {
    return null;
  }

  const replayChain: DropSnapshotRecord[] = [];
  let cursor: DropSnapshotRecord | null = targetSnapshot;
  let baseContent: string | null = null;

  while (cursor) {
    const checkpoint = await readSnapshotCheckpoint(
      bucket,
      rootDropId,
      branchId,
      cursor.snapshotId,
      cursor.checkpointKey,
    );
    if (checkpoint !== null) {
      baseContent = checkpoint;
      break;
    }

    replayChain.push(cursor);
    if (cursor.parentSnapshotId === null) {
      break;
    }

    cursor = await readSnapshot(
      bucket,
      rootDropId,
      branchId,
      cursor.parentSnapshotId,
    );
  }

  if (baseContent === null) {
    return null;
  }

  let rebuiltContent = baseContent;
  for (let index = replayChain.length - 1; index >= 0; index -= 1) {
    const snapshot = replayChain[index];

    if (
      typeof snapshot.patchStartSeq === "number" &&
      typeof snapshot.patchEndSeq === "number" &&
      snapshot.patchEndSeq >= snapshot.patchStartSeq
    ) {
      // Heap v2 snapshots prefer replaying compact event ranges over materializing every checkpoint.
      const events = await readEventsBySeqRange(
        bucket,
        rootDropId,
        branchId,
        snapshot.patchStartSeq,
        snapshot.patchEndSeq,
      );
      if (!events) {
        return null;
      }
      rebuiltContent = applyEventOps(rebuiltContent, events);
      continue;
    }

    const fallbackCheckpoint = await readSnapshotCheckpoint(
      bucket,
      rootDropId,
      branchId,
      snapshot.snapshotId,
      snapshot.checkpointKey,
    );
    if (fallbackCheckpoint === null) {
      return null;
    }
    rebuiltContent = fallbackCheckpoint;
  }

  return rebuiltContent;
};

const readLegacyBranchDiffLog = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<DropDiffEvent[]> => {
  const object = await bucket.get(branchDiffLogKey(rootDropId, branchId));
  if (!object) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = await object.json();
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

const readHeapBranchDiffLog = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<DropDiffEvent[]> => {
  const prefix = branchDiffEventPrefix(rootDropId, branchId);
  const out: DropDiffEvent[] = [];

  let cursor: string | undefined;
  while (true) {
    const listed = await bucket.list({
      prefix,
      cursor,
      limit: 1000,
    });

    if (!listed.objects.length) {
      break;
    }

    const chunk = await Promise.all(
      listed.objects.map((entry) =>
        readJson(bucket, entry.key, isDropDiffEvent),
      ),
    );
    out.push(
      ...chunk.filter((entry): entry is DropDiffEvent => Boolean(entry)),
    );

    if (!listed.truncated || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return out.sort((a, b) => a.seq - b.seq);
};

export const readBranchDiffLog = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<DropDiffEvent[]> => {
  const heapEvents = await readHeapBranchDiffLog(bucket, rootDropId, branchId);
  if (heapEvents.length > 0) {
    return heapEvents;
  }

  return readLegacyBranchDiffLog(bucket, rootDropId, branchId);
};

export const readBranchHeadEventSeq = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<number> => {
  const branch = await readBranch(bucket, rootDropId, branchId);
  if (branch && typeof branch.headEventSeq === "number") {
    return branch.headEventSeq;
  }

  const all = await readBranchDiffLog(bucket, rootDropId, branchId);
  return all.length > 0 ? Math.max(...all.map((event) => event.seq)) : -1;
};

export const pollBranchDiffEventsSince = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  afterSeq: number,
  limit: number,
  excludeClient?: string,
): Promise<{
  events: DropDiffEvent[];
  nextCursor: number | null;
  headSeq: number;
}> => {
  const normalizedAfter = Number.isFinite(afterSeq)
    ? Math.max(-1, Math.floor(afterSeq))
    : -1;
  const normalizedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const prefix = branchDiffEventPrefix(rootDropId, branchId);
  const hasHeapEvents =
    (await bucket.list({ prefix, limit: 1 })).objects.length > 0;

  let cursor: string | undefined;
  let startAfter =
    normalizedAfter >= 0
      ? branchDiffEventKey(rootDropId, branchId, normalizedAfter)
      : undefined;
  const page: DropDiffEvent[] = [];
  let observedHeadSeq = normalizedAfter;

  const listLimit = Math.min(1000, Math.max(64, normalizedLimit * 4));

  while (page.length < normalizedLimit) {
    const listed = await bucket.list({
      prefix,
      cursor,
      startAfter,
      limit: listLimit,
    });

    if (!listed.objects.length) {
      break;
    }

    const chunk = await Promise.all(
      listed.objects.map((entry) =>
        readJson(bucket, entry.key, isDropDiffEvent),
      ),
    );

    for (const event of chunk) {
      if (!event) {
        continue;
      }

      observedHeadSeq = Math.max(observedHeadSeq, event.seq);
      if (event.seq <= normalizedAfter) {
        continue;
      }
      if (excludeClient && event.sourceClientId === excludeClient) {
        continue;
      }

      page.push(event);
      if (page.length >= normalizedLimit) {
        break;
      }
    }

    if (page.length >= normalizedLimit) {
      break;
    }
    if (!listed.truncated || !listed.cursor) {
      break;
    }

    cursor = listed.cursor;
    startAfter = undefined;
  }

  if (
    !hasHeapEvents &&
    page.length === 0 &&
    observedHeadSeq === normalizedAfter
  ) {
    const legacy = await readLegacyBranchDiffLog(bucket, rootDropId, branchId);
    const filtered = legacy
      .filter((event) => event.seq > normalizedAfter)
      .filter((event) =>
        excludeClient ? event.sourceClientId !== excludeClient : true,
      );
    const legacyPage = filtered.slice(0, normalizedLimit);
    const headSeq = legacy.length
      ? Math.max(...legacy.map((event) => event.seq))
      : -1;
    return {
      events: legacyPage,
      nextCursor: legacyPage.length
        ? legacyPage[legacyPage.length - 1].seq
        : null,
      headSeq,
    };
  }

  return {
    events: page,
    nextCursor: page.length ? page[page.length - 1].seq : null,
    headSeq: observedHeadSeq,
  };
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

interface BranchLockPayload {
  token: string;
  createdAt: number;
}

const parseBranchLockPayload = (
  value: string | null,
): BranchLockPayload | null => {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { token?: unknown }).token === "string" &&
      typeof (parsed as { createdAt?: unknown }).createdAt === "number"
    ) {
      return {
        token: (parsed as { token: string }).token,
        createdAt: (parsed as { createdAt: number }).createdAt,
      };
    }
  } catch {
    return null;
  }

  return null;
};

const acquireBranchMutationLock = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<{ key: string; token: string }> => {
  const key = branchLockKey(rootDropId, branchId);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  for (let attempt = 0; attempt < BRANCH_LOCK_MAX_ATTEMPTS; attempt += 1) {
    const acquired = await bucket.put(
      key,
      JSON.stringify({ token, createdAt: Date.now() }),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );

    if (acquired) {
      return { key, token };
    }

    const existing = await bucket.get(key);
    const existingPayload = parseBranchLockPayload(await readText(existing));
    const isStale =
      existingPayload &&
      Date.now() - existingPayload.createdAt > BRANCH_LOCK_STALE_MS;
    if (isStale) {
      // Locks are best-effort R2 objects, so stale holders are reaped instead of blocking the branch forever.
      await bucket.delete(key);
      continue;
    }

    const jitter = Math.floor(Math.random() * 10);
    const backoff =
      BRANCH_LOCK_BASE_BACKOFF_MS + Math.min(attempt, 15) * 3 + jitter;
    await sleep(backoff);
  }

  throw new Error("branch_lock_timeout");
};

const releaseBranchMutationLock = async (
  bucket: R2Bucket,
  lock: { key: string; token: string },
): Promise<void> => {
  const existing = await bucket.get(lock.key);
  const payload = parseBranchLockPayload(await readText(existing));
  if (payload && payload.token !== lock.token) {
    return;
  }
  await bucket.delete(lock.key);
};

const withBranchMutationLock = async <T>(
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
  work: () => Promise<T>,
): Promise<T> => {
  const lock = await acquireBranchMutationLock(bucket, rootDropId, branchId);
  try {
    return await work();
  } finally {
    await releaseBranchMutationLock(bucket, lock);
  }
};

const ensureBranchHeapV2 = async (
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
        writeJsonIfAbsent(
          bucket,
          branchDiffEventKey(branch.rootDropId, branch.branchId, event.seq),
          event,
        ),
      ),
    );

    await Promise.all(
      legacyEvents.map((event) =>
        bucket.put(
          branchDiffEventIdKey(
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

  await writeJson(
    bucket,
    branchKey(branch.rootDropId, branch.branchId),
    upgraded,
  );
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
    writeJson(bucket, branchKey(rootDropId, branchId), branch),
    writeJson(bucket, snapshotKey(rootDropId, branchId, 0), snapshot),
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
      const upgraded = await ensureBranchHeapV2(bucket, existingBranch);
      return { branch: upgraded, created: false };
    }
  }

  const branchId = buildCloneBranchId(writerKey);
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

  await bucket.put(writerBranchKey(rootDropId, writerKey), branchId, {
    httpMetadata: { contentType: "text/plain" },
  });

  return { branch: created, created: true };
};

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

export const appendEventsToBranch = async (
  bucket: R2Bucket,
  branch: DropBranchRecord,
  events: DropDiffEvent[],
  options?: BranchAppendObserverOptions,
): Promise<AppendEventsToBranchResult> => {
  const result = await withBranchMutationLock(
    bucket,
    branch.rootDropId,
    branch.branchId,
    async () => {
      const latestBranch = await readBranch(
        bucket,
        branch.rootDropId,
        branch.branchId,
      );
      if (!latestBranch) {
        throw new Error("Branch not found.");
      }

      const upgradedBranch = await ensureBranchHeapV2(bucket, latestBranch);
      const currentContent = await readBranchContent(
        bucket,
        upgradedBranch.rootDropId,
        upgradedBranch.branchId,
        upgradedBranch.headSnapshotId,
      );
      if (currentContent === null) {
        throw new Error("Branch head content is missing.");
      }

      const seenEventIds = new Set<string>();
      const acceptedInput: Array<{ event: DropDiffEvent; dedupeKey: string }> =
        [];

      for (const event of events) {
        if (seenEventIds.has(event.eventId)) {
          continue;
        }
        seenEventIds.add(event.eventId);

        const dedupeKey = branchDiffEventIdKey(
          upgradedBranch.rootDropId,
          upgradedBranch.branchId,
          event.eventId,
        );
        const alreadyStored = await bucket.head(dedupeKey);
        if (alreadyStored) {
          continue;
        }

        acceptedInput.push({ event, dedupeKey });
      }

      if (acceptedInput.length === 0) {
        const headSeq =
          typeof upgradedBranch.headEventSeq === "number"
            ? upgradedBranch.headEventSeq
            : -1;
        return {
          branch: upgradedBranch,
          snapshot: null,
          content: currentContent,
          acceptedEvents: [],
          deduplicatedCount: events.length,
          totalStored: headSeq + 1,
        };
      }

      const nextSnapshotId = upgradedBranch.headSnapshotId + 1;
      const nextSeqStart =
        typeof upgradedBranch.headEventSeq === "number"
          ? upgradedBranch.headEventSeq + 1
          : 0;

      const acceptedEvents = acceptedInput.map(({ event }, index) => ({
        ...event,
        seq: nextSeqStart + index,
        snapshotId: nextSnapshotId,
      }));

      const nextContent = applyEventOps(currentContent, acceptedEvents);
      const patchStartSeq = acceptedEvents[0].seq;
      const patchEndSeq = acceptedEvents[acceptedEvents.length - 1].seq;

      const checkpointInterval = Math.max(
        1,
        upgradedBranch.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL,
      );
      // Checkpoints are periodic to cap replay cost without storing full plaintext for every event.
      const shouldCheckpoint = nextSnapshotId % checkpointInterval === 0;
      const checkpointObjectKey = shouldCheckpoint
        ? resolveSnapshotCheckpointKey(
            upgradedBranch.rootDropId,
            upgradedBranch.branchId,
            nextSnapshotId,
          )
        : undefined;

      const createdAt = Date.now();
      const snapshot: DropSnapshotRecord = {
        version: 1,
        snapshotId: nextSnapshotId,
        rootDropId: upgradedBranch.rootDropId,
        branchId: upgradedBranch.branchId,
        parentSnapshotId: upgradedBranch.headSnapshotId,
        seq: nextSnapshotId,
        eventIds: acceptedEvents.map((event) => event.eventId),
        checkpointed: shouldCheckpoint,
        patchStartSeq,
        patchEndSeq,
        checkpointKey: checkpointObjectKey,
        textLength: nextContent.length,
        createdAt,
      };

      const nextBranch: DropBranchRecord = {
        ...upgradedBranch,
        headSnapshotId: nextSnapshotId,
        snapshotHeapVersion: 2,
        headEventSeq: patchEndSeq,
        checkpointInterval,
        updatedAt: createdAt,
      };

      await Promise.all(
        acceptedEvents.map((event) =>
          writeJson(
            bucket,
            branchDiffEventKey(
              upgradedBranch.rootDropId,
              upgradedBranch.branchId,
              event.seq,
            ),
            event,
          ),
        ),
      );

      await writeJson(
        bucket,
        snapshotKey(
          upgradedBranch.rootDropId,
          upgradedBranch.branchId,
          nextSnapshotId,
        ),
        snapshot,
      );

      if (shouldCheckpoint) {
        await writeSnapshotCheckpoint(
          bucket,
          upgradedBranch.rootDropId,
          upgradedBranch.branchId,
          nextSnapshotId,
          nextContent,
          checkpointObjectKey,
        );
      }

      await writeJson(
        bucket,
        branchKey(upgradedBranch.rootDropId, upgradedBranch.branchId),
        nextBranch,
      );

      await Promise.all(
        acceptedInput.map(({ dedupeKey }, index) =>
          bucket.put(dedupeKey, String(acceptedEvents[index].seq), {
            httpMetadata: { contentType: "text/plain" },
          }),
        ),
      );

      return {
        branch: nextBranch,
        snapshot,
        content: nextContent,
        acceptedEvents,
        deduplicatedCount: events.length - acceptedEvents.length,
        totalStored: patchEndSeq + 1,
      };
    },
  );

  dispatchBranchAppendObservers(bucket, result, options);
  return result;
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
    listed.objects.map((entry) =>
      readJson(bucket, entry.key, isDropBranchRecord),
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
