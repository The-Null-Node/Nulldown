import type { R2Bucket } from "@cloudflare/workers-types";
import { type DropDiffEvent, isDropDiffEvent } from "../../../shared/drop/diff";
import {
  createBranchDiffEventKey,
  createBranchDiffEventPrefix,
  createBranchDiffLogKey,
} from "./branchKeys";
import { readBranch, readR2Json } from "./branchRepository";

const isDropDiffEventList = (value: unknown): value is DropDiffEvent[] =>
  Array.isArray(value) && value.every((entry) => isDropDiffEvent(entry));

/** Reads the legacy single-object branch diff log. */
export const readLegacyBranchDiffLog = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<DropDiffEvent[]> =>
  (await readR2Json(
    bucket,
    createBranchDiffLogKey(rootDropId, branchId),
    isDropDiffEventList,
  )) ?? [];

/** Reads heap-v2 per-sequence branch diff events. */
export const readHeapBranchDiffLog = async (
  bucket: R2Bucket,
  rootDropId: string,
  branchId: string,
): Promise<DropDiffEvent[]> => {
  const prefix = createBranchDiffEventPrefix(rootDropId, branchId);
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
        readR2Json(bucket, entry.key, isDropDiffEvent),
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

/** Reads branch diff events, preferring heap-v2 storage with legacy fallback. */
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

/** Resolves the highest stored branch diff event sequence. */
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

/** Polls branch diff events after a sequence cursor with heap-v2 and legacy fallback. */
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
  const prefix = createBranchDiffEventPrefix(rootDropId, branchId);
  const hasHeapEvents =
    (await bucket.list({ prefix, limit: 1 })).objects.length > 0;

  let cursor: string | undefined;
  let startAfter =
    normalizedAfter >= 0
      ? createBranchDiffEventKey(rootDropId, branchId, normalizedAfter)
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
        readR2Json(bucket, entry.key, isDropDiffEvent),
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
