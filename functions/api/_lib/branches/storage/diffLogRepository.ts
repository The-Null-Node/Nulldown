import { type DropDiffEvent, isDropDiffEvent } from "../../../../../shared/drop/diff";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import { parseJsonColumn } from "../../core/d1/metadata";
import {
  createBranchDiffEventIdKey,
  createBranchDiffEventKey,
  createBranchDiffEventPrefix,
  createBranchDiffLogKey,
} from "./keys";
import { readBranch, readR2Json, writeR2Json } from "./repository";

const isDropDiffEventList = (value: unknown): value is DropDiffEvent[] =>
  Array.isArray(value) && value.every((entry) => isDropDiffEvent(entry));

/** Reads the legacy single-object branch diff log. */
export const readLegacyBranchDiffLog = async (
  bucket: VoidBlobStore,
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
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  db?: VoidSqlStore,
): Promise<DropDiffEvent[]> => {
  if (db) {
    const rows = await db
      .prepare(
        `SELECT event_json
         FROM branch_events
         WHERE root_drop_id = ? AND branch_id = ?
         ORDER BY seq ASC`,
      )
      .bind(rootDropId, branchId)
      .all<{ event_json: string }>();
    const events = (rows.results ?? [])
      .map((row) => parseJsonColumn(row.event_json, isDropDiffEvent))
      .filter((entry): entry is DropDiffEvent => Boolean(entry));
    if (events.length > 0) return events;
  }

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
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  db?: VoidSqlStore,
): Promise<DropDiffEvent[]> => {
  const heapEvents = await readHeapBranchDiffLog(bucket, rootDropId, branchId, db);
  if (heapEvents.length > 0) {
    return heapEvents;
  }

  return readLegacyBranchDiffLog(bucket, rootDropId, branchId);
};

/** Resolves the highest stored branch diff event sequence. */
export const readBranchHeadEventSeq = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  db?: VoidSqlStore,
): Promise<number> => {
  const branch = await readBranch(bucket, rootDropId, branchId, db);
  if (branch && typeof branch.headEventSeq === "number") {
    return branch.headEventSeq;
  }

  const all = await readBranchDiffLog(bucket, rootDropId, branchId, db);
  return all.length > 0 ? Math.max(...all.map((event) => event.seq)) : -1;
};

/** Reads one heap-v2 branch diff event by sequence with D1-primary/R2 fallback. */
export const readBranchDiffEventBySeq = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  seq: number,
  db?: VoidSqlStore,
): Promise<DropDiffEvent | null> => {
  if (db) {
    const row = await db
      .prepare(
        `SELECT event_json
         FROM branch_events
         WHERE root_drop_id = ? AND branch_id = ? AND seq = ?`,
      )
      .bind(rootDropId, branchId, seq)
      .first<{ event_json: string }>();
    const event = parseJsonColumn(row?.event_json, isDropDiffEvent);
    if (event) return event;
  }

  return readR2Json(
    bucket,
    createBranchDiffEventKey(rootDropId, branchId, seq),
    isDropDiffEvent,
  );
};

/** Checks whether a branch diff event id has already been stored. */
export const hasBranchDiffEventId = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  eventId: string,
  db?: VoidSqlStore,
): Promise<boolean> => {
  if (db) {
    const row = await db
      .prepare(
        `SELECT 1 AS found
         FROM branch_events
         WHERE root_drop_id = ? AND branch_id = ? AND event_id = ?`,
      )
      .bind(rootDropId, branchId, eventId)
      .first<{ found: number }>();
    if (row) return true;
  }

  const dedupeKey = createBranchDiffEventIdKey(rootDropId, branchId, eventId);
  return Boolean(await bucket.head(dedupeKey));
};

/** Writes one heap-v2 branch diff event to D1 and R2 fallback storage. */
export const writeBranchDiffEvent = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  event: DropDiffEvent,
  db?: VoidSqlStore,
): Promise<void> => {
  if (db) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO branch_events (
           root_drop_id, branch_id, seq, event_id, snapshot_id,
           source_client_id, created_at, event_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        rootDropId,
        branchId,
        event.seq,
        event.eventId,
        event.snapshotId ?? null,
        event.sourceClientId,
        event.createdAt,
        JSON.stringify(event),
      )
      .run();
  }

  await writeR2Json(
    bucket,
    createBranchDiffEventKey(rootDropId, branchId, event.seq),
    event,
  );
};

/** Polls branch diff events after a sequence cursor with heap-v2 and legacy fallback. */
export const pollBranchDiffEventsSince = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  afterSeq: number,
  limit: number,
  excludeClient?: string,
  db?: VoidSqlStore,
): Promise<{
  events: DropDiffEvent[];
  nextCursor: number | null;
  headSeq: number;
}> => {
  const normalizedAfter = Number.isFinite(afterSeq)
    ? Math.max(-1, Math.floor(afterSeq))
    : -1;
  const normalizedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  if (db) {
    const params: Array<string | number> = [rootDropId, branchId, normalizedAfter];
    let filter = "root_drop_id = ? AND branch_id = ? AND seq > ?";
    if (excludeClient) {
      filter += " AND source_client_id != ?";
      params.push(excludeClient);
    }
    params.push(normalizedLimit);

    const rows = await db
      .prepare(
        `SELECT event_json
         FROM branch_events
         WHERE ${filter}
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .bind(...params)
      .all<{ event_json: string }>();
    const events = (rows.results ?? [])
      .map((row) => parseJsonColumn(row.event_json, isDropDiffEvent))
      .filter((entry): entry is DropDiffEvent => Boolean(entry));
    if (events.length > 0) {
      const headSeq = await readBranchHeadEventSeq(bucket, rootDropId, branchId, db);
      const lastSeq = events[events.length - 1]?.seq ?? normalizedAfter;
      return {
        events,
        nextCursor: lastSeq < headSeq ? lastSeq : null,
        headSeq,
      };
    }
  }

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
