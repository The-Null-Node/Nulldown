import {
  type DropDiffEvent,
  isDropDiffEvent,
} from "../../../../../shared/drop/diff";
import type {
  VoidBlobStore,
  VoidSqlStore,
} from "../../../../../src/server/ports";
import { parseJsonColumn } from "../../core/d1/metadata";
import {
  createBranchDiffEventIdKey,
  createBranchDiffEventIdMarkerV2Key,
  createBranchDiffEventKey,
  createBranchDiffEventPrefix,
  createBranchDiffLogKey,
} from "./keys";
import {
  readBranch,
  readR2Json,
  writeR2Json,
  writeR2JsonIfAbsent,
} from "./repository";
import { serializeCanonicalJson } from "../../../../../shared/drop/types";

/** Persisted exact event-identity marker written only after branch-head publication. */
export interface BranchDiffEventIdMarkerV2 {
  version: 2;
  rootDropId: string;
  branchId: string;
  eventId: string;
  seq: number;
  snapshotId: number;
}

/** Exact event lookup outcome before append logic confirms branch reachability. */
export type BranchDiffEventIdentityLookup =
  | { status: "absent" }
  | { status: "found"; event: DropDiffEvent }
  | { status: "invalid"; reason: string };

/** Ports used by branch diff-event repositories. */
export interface BranchDiffRepositoryPorts {
  /** Blob store containing branch diff logs and fallback event objects. */
  blobs: VoidBlobStore;
  /** Optional SQL store containing queryable branch event metadata. */
  sql?: VoidSqlStore;
}

/** Repository for branch diff logs, event records, and polling cursors. */
export interface BranchDiffRepository {
  /** Reads the legacy single-object branch diff log. */
  readLegacyBranchDiffLog(
    rootDropId: string,
    branchId: string,
  ): Promise<DropDiffEvent[]>;
  /** Reads heap-v2 per-sequence branch diff events. */
  readHeapBranchDiffLog(
    rootDropId: string,
    branchId: string,
  ): Promise<DropDiffEvent[]>;
  /** Reads branch diff events, preferring heap-v2 storage with legacy fallback. */
  readBranchDiffLog(
    rootDropId: string,
    branchId: string,
  ): Promise<DropDiffEvent[]>;
  /** Resolves the highest stored branch diff event sequence. */
  readBranchHeadEventSeq(rootDropId: string, branchId: string): Promise<number>;
  /** Reads one heap-v2 branch diff event by sequence with D1-primary/R2 fallback. */
  readBranchDiffEventBySeq(
    rootDropId: string,
    branchId: string,
    seq: number,
  ): Promise<DropDiffEvent | null>;
  /** Reads one branch diff event by its stable writer-supplied identity. */
  readBranchDiffEventById(
    rootDropId: string,
    branchId: string,
    eventId: string,
  ): Promise<DropDiffEvent | null>;
  /** Resolves one exact event identity while distinguishing corrupt marker state. */
  lookupBranchDiffEventIdentity(
    rootDropId: string,
    branchId: string,
    eventId: string,
  ): Promise<BranchDiffEventIdentityLookup>;
  /** Checks whether a branch diff event id has already been stored. */
  hasBranchDiffEventId(
    rootDropId: string,
    branchId: string,
    eventId: string,
  ): Promise<boolean>;
  /** Writes one heap-v2 branch diff event to D1 and R2 fallback storage. */
  writeBranchDiffEvent(
    rootDropId: string,
    branchId: string,
    event: DropDiffEvent,
  ): Promise<void>;
  /** Writes or validates a collision-free v2 event identity marker. */
  writeBranchDiffEventIdMarker(
    rootDropId: string,
    branchId: string,
    event: DropDiffEvent,
  ): Promise<void>;
  /** Polls branch diff events after a sequence cursor with heap-v2 and legacy fallback. */
  pollBranchDiffEventsSince(
    rootDropId: string,
    branchId: string,
    afterSeq: number,
    limit: number,
    excludeClient?: string,
  ): Promise<{
    events: DropDiffEvent[];
    nextCursor: number | null;
    headSeq: number;
  }>;
}

const isDropDiffEventList = (value: unknown): value is DropDiffEvent[] =>
  Array.isArray(value) && value.every((entry) => isDropDiffEvent(entry));

const isBranchDiffEventIdMarkerV2 = (
  value: unknown,
): value is BranchDiffEventIdMarkerV2 => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 2 &&
    typeof record.rootDropId === "string" &&
    typeof record.branchId === "string" &&
    typeof record.eventId === "string" &&
    Number.isInteger(record.seq) &&
    (record.seq as number) >= 0 &&
    Number.isInteger(record.snapshotId) &&
    (record.snapshotId as number) >= 0
  );
};

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
  const heapEvents = await readHeapBranchDiffLog(
    bucket,
    rootDropId,
    branchId,
    db,
  );
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

const hasSameStoredEvent = (
  left: DropDiffEvent,
  right: DropDiffEvent,
): boolean => serializeCanonicalJson(left) === serializeCanonicalJson(right);

const readR2BranchDiffEventBySeq = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  seq: number,
): Promise<DropDiffEvent | null> =>
  readR2Json(
    bucket,
    createBranchDiffEventKey(rootDropId, branchId, seq),
    isDropDiffEvent,
  );

const readBranchDiffEventIdMarkerV2 = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  eventId: string,
): Promise<
  | { status: "absent" }
  | { status: "found"; marker: BranchDiffEventIdMarkerV2 }
  | { status: "invalid" }
> => {
  const key = createBranchDiffEventIdMarkerV2Key(rootDropId, branchId, eventId);
  const object = await bucket.get(key);
  if (!object) return { status: "absent" };
  try {
    const value = await object.json();
    return isBranchDiffEventIdMarkerV2(value)
      ? { status: "found", marker: value }
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
};

/** Resolves an exact event identity without treating legacy marker collisions as presence. */
export const lookupBranchDiffEventIdentity = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  eventId: string,
  db?: VoidSqlStore,
): Promise<BranchDiffEventIdentityLookup> => {
  const marker = await readBranchDiffEventIdMarkerV2(
    bucket,
    rootDropId,
    branchId,
    eventId,
  );
  if (marker.status === "invalid") {
    return { status: "invalid", reason: "v2_marker_invalid" };
  }
  if (
    marker.status === "found" &&
    (marker.marker.rootDropId !== rootDropId ||
      marker.marker.branchId !== branchId ||
      marker.marker.eventId !== eventId)
  ) {
    return { status: "invalid", reason: "v2_marker_identity_mismatch" };
  }

  let d1Event: DropDiffEvent | null = null;
  if (db) {
    const row = await db
      .prepare(
        `SELECT event_json
         FROM branch_events
         WHERE root_drop_id = ? AND branch_id = ? AND event_id = ?`,
      )
      .bind(rootDropId, branchId, eventId)
      .first<{ event_json: string }>();
    d1Event = parseJsonColumn(row?.event_json, isDropDiffEvent);
  }

  if (marker.status === "found") {
    const r2Event = await readR2BranchDiffEventBySeq(
      bucket,
      rootDropId,
      branchId,
      marker.marker.seq,
    );
    if (
      (!d1Event && !r2Event) ||
      (d1Event &&
        (d1Event.eventId !== eventId ||
          d1Event.seq !== marker.marker.seq ||
          d1Event.snapshotId !== marker.marker.snapshotId)) ||
      (r2Event &&
        (r2Event.eventId !== eventId ||
          r2Event.seq !== marker.marker.seq ||
          r2Event.snapshotId !== marker.marker.snapshotId)) ||
      (d1Event && r2Event && !hasSameStoredEvent(d1Event, r2Event))
    ) {
      return { status: "invalid", reason: "v2_marker_event_mismatch" };
    }
    return { status: "found", event: d1Event ?? r2Event! };
  }

  const r2Events = await readHeapBranchDiffLog(bucket, rootDropId, branchId);
  const legacyEvents = await readLegacyBranchDiffLog(
    bucket,
    rootDropId,
    branchId,
  );
  const r2Matches = [...r2Events, ...legacyEvents].filter(
    (event) => event.eventId === eventId,
  );
  const uniqueMatches = new Map<number, DropDiffEvent>();
  for (const event of r2Matches) {
    const prior = uniqueMatches.get(event.seq);
    if (prior && !hasSameStoredEvent(prior, event)) {
      return { status: "invalid", reason: "r2_event_sequence_mismatch" };
    }
    uniqueMatches.set(event.seq, event);
  }
  if (uniqueMatches.size > 1) {
    return { status: "invalid", reason: "multiple_event_sequences" };
  }
  const r2Event = uniqueMatches.values().next().value as
    | DropDiffEvent
    | undefined;
  if (d1Event && r2Event && !hasSameStoredEvent(d1Event, r2Event)) {
    return { status: "invalid", reason: "d1_r2_event_mismatch" };
  }
  if (d1Event) return { status: "found", event: d1Event };
  return r2Event ? { status: "found", event: r2Event } : { status: "absent" };
};

/** Reads a branch diff event through D1, the R2 identity index, or legacy storage. */
export const readBranchDiffEventById = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  eventId: string,
  db?: VoidSqlStore,
): Promise<DropDiffEvent | null> => {
  const result = await lookupBranchDiffEventIdentity(
    bucket,
    rootDropId,
    branchId,
    eventId,
    db,
  );
  return result.status === "found" ? result.event : null;
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

/** Writes or validates the exact v2 marker for an accepted branch event. */
export const writeBranchDiffEventIdMarker = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  event: DropDiffEvent,
): Promise<void> => {
  if (event.snapshotId === undefined) {
    throw new Error("diff_event_marker_snapshot_missing");
  }
  const marker: BranchDiffEventIdMarkerV2 = {
    version: 2,
    rootDropId,
    branchId,
    eventId: event.eventId,
    seq: event.seq,
    snapshotId: event.snapshotId,
  };
  const key = createBranchDiffEventIdMarkerV2Key(
    rootDropId,
    branchId,
    event.eventId,
  );
  if (await writeR2JsonIfAbsent(bucket, key, marker)) return;
  const existing = await readR2Json(bucket, key, isBranchDiffEventIdMarkerV2);
  if (
    !existing ||
    existing.rootDropId !== marker.rootDropId ||
    existing.branchId !== marker.branchId ||
    existing.eventId !== marker.eventId ||
    existing.seq !== marker.seq ||
    existing.snapshotId !== marker.snapshotId
  ) {
    throw new Error("diff_event_marker_conflict");
  }
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
    const params: Array<string | number> = [
      rootDropId,
      branchId,
      normalizedAfter,
    ];
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
      const headSeq = await readBranchHeadEventSeq(
        bucket,
        rootDropId,
        branchId,
        db,
      );
      const lastSeq = events[events.length - 1]?.seq ?? normalizedAfter;
      return {
        events,
        // A returned event always advances the caller high-water mark, including at head.
        nextCursor: lastSeq,
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

/** Creates a branch diff-event repository bound to composed blob and SQL ports. */
export const createBranchDiffRepository = ({
  blobs,
  sql,
}: BranchDiffRepositoryPorts): BranchDiffRepository => ({
  readLegacyBranchDiffLog: (rootDropId, branchId) =>
    readLegacyBranchDiffLog(blobs, rootDropId, branchId),
  readHeapBranchDiffLog: (rootDropId, branchId) =>
    readHeapBranchDiffLog(blobs, rootDropId, branchId, sql),
  readBranchDiffLog: (rootDropId, branchId) =>
    readBranchDiffLog(blobs, rootDropId, branchId, sql),
  readBranchHeadEventSeq: (rootDropId, branchId) =>
    readBranchHeadEventSeq(blobs, rootDropId, branchId, sql),
  readBranchDiffEventBySeq: (rootDropId, branchId, seq) =>
    readBranchDiffEventBySeq(blobs, rootDropId, branchId, seq, sql),
  readBranchDiffEventById: (rootDropId, branchId, eventId) =>
    readBranchDiffEventById(blobs, rootDropId, branchId, eventId, sql),
  lookupBranchDiffEventIdentity: (rootDropId, branchId, eventId) =>
    lookupBranchDiffEventIdentity(blobs, rootDropId, branchId, eventId, sql),
  hasBranchDiffEventId: (rootDropId, branchId, eventId) =>
    hasBranchDiffEventId(blobs, rootDropId, branchId, eventId, sql),
  writeBranchDiffEvent: (rootDropId, branchId, event) =>
    writeBranchDiffEvent(blobs, rootDropId, branchId, event, sql),
  writeBranchDiffEventIdMarker: (rootDropId, branchId, event) =>
    writeBranchDiffEventIdMarker(blobs, rootDropId, branchId, event),
  pollBranchDiffEventsSince: (
    rootDropId,
    branchId,
    afterSeq,
    limit,
    excludeClient,
  ) =>
    pollBranchDiffEventsSince(
      blobs,
      rootDropId,
      branchId,
      afterSeq,
      limit,
      excludeClient,
      sql,
    ),
});
