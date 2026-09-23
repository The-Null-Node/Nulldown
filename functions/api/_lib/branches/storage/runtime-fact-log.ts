import {
  isDropBranchRuntimeFact,
  type DropBranchRuntimeFact,
} from "../../../../../shared/drop/diff";
import { nullplugUiRuntimeFactId } from "../../../../../shared/nullplug/ui";
import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../../src/server/ports";
import { parseJsonColumn } from "../../core/d1/metadata";
import {
  createBranchRuntimeFactEventIdKey,
  createBranchRuntimeFactEventKey,
  createBranchRuntimeFactEventPrefix,
  createBranchRuntimeFactHeadKey,
} from "./keys";
import { readR2Json, writeR2Json } from "./repository";
import { withBranchMutationLock } from "./mutation-lock";

/** Ports used by the branch runtime-fact timeline repository. */
export interface BranchRuntimeFactLogRepositoryPorts {
  /** Blob store containing cursor-addressable fallback fact records. */
  blobs: BlobObjectStore;
  /** Optional SQL store containing queryable fact records. */
  sql?: SqlMetadataStore;
}

/** Cursor-addressable repository for immutable branch runtime facts. */
export interface BranchRuntimeFactLogRepository {
  /** Resolves the latest branch-local runtime-fact sequence. */
  readBranchHeadRuntimeFactSeq(
    rootDropId: string,
    branchId: string,
  ): Promise<number>;
  /** Reads one fact by stable idempotency identity. */
  readBranchRuntimeFactById(
    rootDropId: string,
    branchId: string,
    factId: string,
  ): Promise<DropBranchRuntimeFact | null>;
  /** Appends a fact once, returning its existing event for an idempotent retry. */
  appendBranchRuntimeFact(
    rootDropId: string,
    branchId: string,
    fact: DropBranchRuntimeFact["fact"],
  ): Promise<{ event: DropBranchRuntimeFact; appended: boolean }>;
  /** Appends while the caller already holds the branch mutation lock. */
  appendBranchRuntimeFactUnderLock(
    rootDropId: string,
    branchId: string,
    fact: DropBranchRuntimeFact["fact"],
  ): Promise<{ event: DropBranchRuntimeFact; appended: boolean }>;
  /** Reads runtime facts after a branch-local cursor. */
  pollBranchRuntimeFactsSince(
    rootDropId: string,
    branchId: string,
    afterSeq: number,
    limit: number,
  ): Promise<{
    facts: DropBranchRuntimeFact[];
    nextCursor: number | null;
    headSeq: number;
  }>;
}

const normalizeAfterSeq = (value: number): number =>
  Number.isFinite(value) ? Math.max(-1, Math.floor(value)) : -1;

const normalizeLimit = (value: number): number =>
  Math.max(1, Math.min(200, Math.floor(value)));

const readD1FactById = async (
  db: SqlMetadataStore | undefined,
  rootDropId: string,
  branchId: string,
  factId: string,
): Promise<DropBranchRuntimeFact | null> => {
  if (!db) return null;
  const row = await db
    .prepare(
      `SELECT fact_json
       FROM branch_runtime_facts
       WHERE root_drop_id = ? AND branch_id = ? AND fact_id = ?`,
    )
    .bind(rootDropId, branchId, factId)
    .first<{ fact_json: string }>();
  return parseJsonColumn(row?.fact_json, isDropBranchRuntimeFact) ?? null;
};

const readD1HeadRuntimeFactSeq = async (
  db: SqlMetadataStore | undefined,
  rootDropId: string,
  branchId: string,
): Promise<number> => {
  if (!db) return -1;
  const row = await db
    .prepare(
      `SELECT MAX(seq) AS max_seq
       FROM branch_runtime_facts
       WHERE root_drop_id = ? AND branch_id = ?`,
    )
    .bind(rootDropId, branchId)
    .first<{ max_seq: number | null }>();
  return typeof row?.max_seq === "number" ? row.max_seq : -1;
};

const writeD1RuntimeFact = async (
  db: SqlMetadataStore | undefined,
  event: DropBranchRuntimeFact,
): Promise<void> => {
  if (!db) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO branch_runtime_facts (
         root_drop_id, branch_id, seq, fact_id, created_at, fact_json
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.rootDropId,
      event.branchId,
      event.seq,
      event.factId,
      event.createdAt,
      JSON.stringify(event),
    )
    .run();
};

interface BranchRuntimeFactHead {
  version: 1;
  rootDropId: string;
  branchId: string;
  headSeq: number;
  pending?: DropBranchRuntimeFact;
}

const isBranchRuntimeFactHead = (
  value: unknown,
): value is BranchRuntimeFactHead => {
  if (!value || typeof value !== "object") return false;
  const head = value as Partial<BranchRuntimeFactHead>;
  return (
    head.version === 1 &&
    typeof head.rootDropId === "string" &&
    typeof head.branchId === "string" &&
    Number.isInteger(head.headSeq) &&
    head.headSeq! >= -1 &&
    (head.pending === undefined || isDropBranchRuntimeFact(head.pending))
  );
};

const readR2RuntimeFactHead = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
): Promise<BranchRuntimeFactHead | null> =>
  readR2Json(
    bucket,
    createBranchRuntimeFactHeadKey(rootDropId, branchId),
    isBranchRuntimeFactHead,
  );

const writeR2RuntimeFactHead = async (
  bucket: BlobObjectStore,
  head: BranchRuntimeFactHead,
): Promise<void> => {
  await writeR2Json(
    bucket,
    createBranchRuntimeFactHeadKey(head.rootDropId, head.branchId),
    head,
  );
};

const readR2HeadRuntimeFactSeq = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
  afterSeq = -1,
): Promise<number> => {
  const prefix = createBranchRuntimeFactEventPrefix(rootDropId, branchId);
  const storedHead = await readR2RuntimeFactHead(bucket, rootDropId, branchId);
  let cursor: string | undefined;
  let headSeq = Math.max(afterSeq, storedHead?.headSeq ?? -1);
  let startAfter =
    headSeq >= 0
      ? createBranchRuntimeFactEventKey(rootDropId, branchId, headSeq)
      : undefined;
  while (true) {
    const listed = await bucket.list({
      prefix,
      cursor,
      startAfter,
      limit: 1000,
    });
    listed.objects.forEach((entry) => {
      const suffix = entry.key.slice(prefix.length).replace(/\.json$/, "");
      const seq = Number.parseInt(suffix, 10);
      if (Number.isInteger(seq)) headSeq = Math.max(headSeq, seq);
    });
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
    startAfter = undefined;
  }
  return headSeq;
};

const writeR2RuntimeFactSequence = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
  event: DropBranchRuntimeFact,
): Promise<void> => {
  const key = createBranchRuntimeFactEventKey(rootDropId, branchId, event.seq);
  const written = await bucket.put(key, JSON.stringify(event), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written) return;
  const existing = await readR2Json(bucket, key, isDropBranchRuntimeFact);
  if (existing?.factId === event.factId) return;
  throw new Error("runtime_fact_sequence_conflict");
};

const repairPendingR2RuntimeFact = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
): Promise<void> => {
  const head = await readR2RuntimeFactHead(bucket, rootDropId, branchId);
  if (!head?.pending) return;
  await writeR2RuntimeFactSequence(
    bucket,
    rootDropId,
    branchId,
    head.pending,
  );
  await writeR2Json(
    bucket,
    createBranchRuntimeFactEventIdKey(
      rootDropId,
      branchId,
      head.pending.factId,
    ),
    head.pending,
  );
  await writeR2RuntimeFactHead(bucket, { ...head, pending: undefined });
};

/** Reads one runtime fact through the D1-primary/R2-fallback identity index. */
export const readBranchRuntimeFactById = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
  factId: string,
  db?: SqlMetadataStore,
): Promise<DropBranchRuntimeFact | null> => {
  const fromSql = await readD1FactById(db, rootDropId, branchId, factId);
  if (fromSql?.factId === factId) return fromSql;
  const fromBlob = await readR2Json(
    bucket,
    createBranchRuntimeFactEventIdKey(rootDropId, branchId, factId),
    isDropBranchRuntimeFact,
  );
  if (fromBlob?.factId === factId) return fromBlob;
  const head = await readR2RuntimeFactHead(bucket, rootDropId, branchId);
  return head?.pending?.factId === factId ? head.pending : null;
};

/** Resolves the highest stored runtime-fact sequence for one branch. */
export const readBranchHeadRuntimeFactSeq = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
  db?: SqlMetadataStore,
): Promise<number> => {
  const sqlHeadSeq = await readD1HeadRuntimeFactSeq(db, rootDropId, branchId);
  return readR2HeadRuntimeFactSeq(
    bucket,
    rootDropId,
    branchId,
    sqlHeadSeq,
  );
};

/** Appends a runtime fact under the existing branch mutation lock. */
export const appendBranchRuntimeFact = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
  fact: DropBranchRuntimeFact["fact"],
  db?: SqlMetadataStore,
): Promise<{ event: DropBranchRuntimeFact; appended: boolean }> => {
  return withBranchMutationLock(bucket, rootDropId, branchId, async (lock) => {
    await lock.beginCommit();
    return await appendBranchRuntimeFactUnderLock(
      bucket,
      rootDropId,
      branchId,
      fact,
      db,
    );
  });
};

/** Appends a runtime fact without reacquiring the branch lock. */
export const appendBranchRuntimeFactUnderLock = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
  fact: DropBranchRuntimeFact["fact"],
  db?: SqlMetadataStore,
): Promise<{ event: DropBranchRuntimeFact; appended: boolean }> => {
  await repairPendingR2RuntimeFact(bucket, rootDropId, branchId);
  const factId = nullplugUiRuntimeFactId(fact);
  const existing = await readBranchRuntimeFactById(
    bucket,
    rootDropId,
    branchId,
    factId,
    db,
  );
  if (existing) {
    await writeD1RuntimeFact(db, existing);
    await writeR2RuntimeFactSequence(
      bucket,
      rootDropId,
      branchId,
      existing,
    );
    await writeR2Json(
      bucket,
      createBranchRuntimeFactEventIdKey(rootDropId, branchId, factId),
      existing,
    );
    await writeR2RuntimeFactHead(bucket, {
      version: 1,
      rootDropId,
      branchId,
      headSeq: Math.max(
        existing.seq,
        await readR2HeadRuntimeFactSeq(bucket, rootDropId, branchId),
      ),
    });
    return { event: existing, appended: false };
  }

  const event: DropBranchRuntimeFact = {
    version: 1,
    rootDropId,
    branchId,
    seq:
      (await readBranchHeadRuntimeFactSeq(bucket, rootDropId, branchId, db)) + 1,
    factId,
    createdAt: Date.now(),
    fact,
  };

  await writeD1RuntimeFact(db, event);

  await writeR2RuntimeFactHead(bucket, {
    version: 1,
    rootDropId,
    branchId,
    headSeq: event.seq,
    pending: event,
  });
  await writeR2RuntimeFactSequence(bucket, rootDropId, branchId, event);
  await writeR2Json(
    bucket,
    createBranchRuntimeFactEventIdKey(rootDropId, branchId, event.factId),
    event,
  );
  await writeR2RuntimeFactHead(bucket, {
    version: 1,
    rootDropId,
    branchId,
    headSeq: event.seq,
  });
  return { event, appended: true };
};

/** Polls runtime facts after a branch-local cursor with D1-primary/R2 fallback. */
export const pollBranchRuntimeFactsSince = async (
  bucket: BlobObjectStore,
  rootDropId: string,
  branchId: string,
  afterSeq: number,
  limit: number,
  db?: SqlMetadataStore,
): Promise<{
  facts: DropBranchRuntimeFact[];
  nextCursor: number | null;
  headSeq: number;
}> => {
  const normalizedAfter = normalizeAfterSeq(afterSeq);
  const normalizedLimit = normalizeLimit(limit);
  if (db) {
    const rows = await db
      .prepare(
        `SELECT fact_json
         FROM branch_runtime_facts
         WHERE root_drop_id = ? AND branch_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .bind(rootDropId, branchId, normalizedAfter, normalizedLimit)
      .all<{ fact_json: string }>();
    const sqlFacts = (rows.results ?? [])
      .map((row) => parseJsonColumn(row.fact_json, isDropBranchRuntimeFact))
      .filter((entry): entry is DropBranchRuntimeFact => Boolean(entry));
    const r2Result = await pollBranchRuntimeFactsSince(
      bucket,
      rootDropId,
      branchId,
      normalizedAfter,
      normalizedLimit,
    );
    const sqlFactIds = new Set(sqlFacts.map((fact) => fact.factId));
    const mergedBySeq = new Map<number, DropBranchRuntimeFact>();
    r2Result.facts.forEach((fact) => {
      if (!sqlFactIds.has(fact.factId)) mergedBySeq.set(fact.seq, fact);
    });
    sqlFacts.forEach((fact) => mergedBySeq.set(fact.seq, fact));
    const r2SafeHorizon =
      r2Result.nextCursor !== null && r2Result.nextCursor < r2Result.headSeq
        ? r2Result.nextCursor
        : Number.POSITIVE_INFINITY;
    const facts = [...mergedBySeq.values()]
      .filter((fact) => fact.seq <= r2SafeHorizon)
      .sort((left, right) => left.seq - right.seq)
      .slice(0, normalizedLimit);
    const sqlHeadSeq = await readD1HeadRuntimeFactSeq(db, rootDropId, branchId);
    return {
      facts,
      nextCursor: facts.length ? facts[facts.length - 1]!.seq : null,
      headSeq: Math.max(sqlHeadSeq, r2Result.headSeq),
    };
  }

  const prefix = createBranchRuntimeFactEventPrefix(rootDropId, branchId);
  const r2PageLimit = Math.min(normalizedLimit, 40);
  const startAfter =
    normalizedAfter >= 0
      ? createBranchRuntimeFactEventKey(rootDropId, branchId, normalizedAfter)
      : undefined;
  const facts: DropBranchRuntimeFact[] = [];
  let cursor: string | undefined;
  let nextStartAfter = startAfter;
  let headSeq = normalizedAfter;
  while (facts.length < r2PageLimit) {
    const listed = await bucket.list({
      prefix,
      cursor,
      startAfter: nextStartAfter,
      limit: r2PageLimit,
    });
    if (!listed.objects.length) break;
    const chunk = await Promise.all(
      listed.objects.map((entry) =>
        readR2Json(bucket, entry.key, isDropBranchRuntimeFact),
      ),
    );
    for (const fact of chunk) {
      if (!fact) continue;
      headSeq = Math.max(headSeq, fact.seq);
      if (fact.seq <= normalizedAfter) continue;
      facts.push(fact);
      if (facts.length >= r2PageLimit) break;
    }
    if (facts.length >= r2PageLimit || !listed.truncated || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
    nextStartAfter = undefined;
  }

  const storedHead = await readR2RuntimeFactHead(bucket, rootDropId, branchId);
  if (
    storedHead?.pending &&
    storedHead.pending.seq > normalizedAfter &&
    !facts.some((fact) => fact.seq === storedHead.pending!.seq)
  ) {
    facts.push(storedHead.pending);
    facts.sort((left, right) => left.seq - right.seq);
    facts.splice(r2PageLimit);
  }
  const storedHeadSeq = await readBranchHeadRuntimeFactSeq(
    bucket,
    rootDropId,
    branchId,
  );
  return {
    facts,
    nextCursor: facts.length ? facts[facts.length - 1]!.seq : null,
    headSeq: Math.max(headSeq, storedHeadSeq),
  };
};

/** Creates a runtime-fact timeline repository bound to composed storage ports. */
export const createBranchRuntimeFactLogRepository = ({
  blobs,
  sql,
}: BranchRuntimeFactLogRepositoryPorts): BranchRuntimeFactLogRepository => ({
  readBranchHeadRuntimeFactSeq: (rootDropId, branchId) =>
    readBranchHeadRuntimeFactSeq(blobs, rootDropId, branchId, sql),
  readBranchRuntimeFactById: (rootDropId, branchId, factId) =>
    readBranchRuntimeFactById(blobs, rootDropId, branchId, factId, sql),
  appendBranchRuntimeFact: (rootDropId, branchId, fact) =>
    appendBranchRuntimeFact(blobs, rootDropId, branchId, fact, sql),
  appendBranchRuntimeFactUnderLock: (rootDropId, branchId, fact) =>
    appendBranchRuntimeFactUnderLock(blobs, rootDropId, branchId, fact, sql),
  pollBranchRuntimeFactsSince: (rootDropId, branchId, afterSeq, limit) =>
    pollBranchRuntimeFactsSince(blobs, rootDropId, branchId, afterSeq, limit, sql),
});
