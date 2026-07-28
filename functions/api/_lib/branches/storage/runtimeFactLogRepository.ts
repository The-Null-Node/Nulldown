import {
  isDropBranchRuntimeFact,
  type DropBranchRuntimeFact,
} from "../../../../../shared/drop/diff";
import {
  nullplugUiRuntimeFactId,
  type NullplugUiRuntimeFact,
} from "../../../../../shared/nullplug/ui";
import type {
  VoidBlobStore,
  VoidSqlStore,
} from "../../../../../src/server/ports";
import { parseJsonColumn } from "../../core/d1/metadata";
import {
  createBranchRuntimeFactEventIdKey,
  createBranchRuntimeFactEventKey,
  createBranchRuntimeFactEventPrefix,
} from "./keys";
import { readR2Json, writeR2Json } from "./repository";
import { withBranchMutationLock } from "./mutationLock";

/** Ports used by the branch runtime-fact timeline repository. */
export interface BranchRuntimeFactLogRepositoryPorts {
  /** Blob store containing cursor-addressable fallback fact records. */
  blobs: VoidBlobStore;
  /** Optional SQL store containing queryable fact records. */
  sql?: VoidSqlStore;
}

/** Cursor-addressable repository for immutable branch runtime facts. */
export interface BranchRuntimeFactLogRepository {
  /** Resolves the latest branch-local runtime-fact sequence. */
  readBranchHeadRuntimeFactSeq(
    rootDropId: string,
    branchId: string,
  ): Promise<number>;
  /** Appends a fact once, returning its existing event for an idempotent retry. */
  appendBranchRuntimeFact(
    rootDropId: string,
    branchId: string,
    fact: NullplugUiRuntimeFact,
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
  db: VoidSqlStore | undefined,
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

const readExistingFact = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  factId: string,
  db?: VoidSqlStore,
): Promise<DropBranchRuntimeFact | null> =>
  (await readD1FactById(db, rootDropId, branchId, factId)) ??
  readR2Json(
    bucket,
    createBranchRuntimeFactEventIdKey(rootDropId, branchId, factId),
    isDropBranchRuntimeFact,
  );

/** Resolves the highest stored runtime-fact sequence for one branch. */
export const readBranchHeadRuntimeFactSeq = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  db?: VoidSqlStore,
): Promise<number> => {
  if (db) {
    const row = await db
      .prepare(
        `SELECT MAX(seq) AS max_seq
         FROM branch_runtime_facts
         WHERE root_drop_id = ? AND branch_id = ?`,
      )
      .bind(rootDropId, branchId)
      .first<{ max_seq: number | null }>();
    if (typeof row?.max_seq === "number") return row.max_seq;
  }

  const prefix = createBranchRuntimeFactEventPrefix(rootDropId, branchId);
  let cursor: string | undefined;
  let headSeq = -1;
  while (true) {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    const facts = await Promise.all(
      listed.objects.map((entry) =>
        readR2Json(bucket, entry.key, isDropBranchRuntimeFact),
      ),
    );
    facts.forEach((fact) => {
      if (fact) headSeq = Math.max(headSeq, fact.seq);
    });
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return headSeq;
};

/** Appends a runtime fact under the existing branch mutation lock. */
export const appendBranchRuntimeFact = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  fact: NullplugUiRuntimeFact,
  db?: VoidSqlStore,
): Promise<{ event: DropBranchRuntimeFact; appended: boolean }> => {
  const factId = nullplugUiRuntimeFactId(fact);
  return withBranchMutationLock(bucket, rootDropId, branchId, async () => {
    const existing = await readExistingFact(
      bucket,
      rootDropId,
      branchId,
      factId,
      db,
    );
    if (existing) {
      await Promise.all([
        writeR2Json(
          bucket,
          createBranchRuntimeFactEventKey(rootDropId, branchId, existing.seq),
          existing,
        ),
        writeR2Json(
          bucket,
          createBranchRuntimeFactEventIdKey(rootDropId, branchId, factId),
          existing,
        ),
      ]);
      return { event: existing, appended: false };
    }

    const event: DropBranchRuntimeFact = {
      version: 1,
      rootDropId,
      branchId,
      seq: (await readBranchHeadRuntimeFactSeq(bucket, rootDropId, branchId, db)) + 1,
      factId,
      createdAt: Date.now(),
      fact,
    };

    if (db) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO branch_runtime_facts (
             root_drop_id, branch_id, seq, fact_id, created_at, fact_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          rootDropId,
          branchId,
          event.seq,
          event.factId,
          event.createdAt,
          JSON.stringify(event),
        )
        .run();
    }

    await Promise.all([
      writeR2Json(
        bucket,
        createBranchRuntimeFactEventKey(rootDropId, branchId, event.seq),
        event,
      ),
      writeR2Json(
        bucket,
        createBranchRuntimeFactEventIdKey(rootDropId, branchId, event.factId),
        event,
      ),
    ]);
    return { event, appended: true };
  });
};

/** Polls runtime facts after a branch-local cursor with D1-primary/R2 fallback. */
export const pollBranchRuntimeFactsSince = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  afterSeq: number,
  limit: number,
  db?: VoidSqlStore,
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
    const facts = (rows.results ?? [])
      .map((row) => parseJsonColumn(row.fact_json, isDropBranchRuntimeFact))
      .filter((entry): entry is DropBranchRuntimeFact => Boolean(entry));
    const headSeq = await readBranchHeadRuntimeFactSeq(
      bucket,
      rootDropId,
      branchId,
      db,
    );
    return {
      facts,
      nextCursor: facts.length ? facts[facts.length - 1]!.seq : null,
      headSeq,
    };
  }

  const prefix = createBranchRuntimeFactEventPrefix(rootDropId, branchId);
  const startAfter =
    normalizedAfter >= 0
      ? createBranchRuntimeFactEventKey(rootDropId, branchId, normalizedAfter)
      : undefined;
  const facts: DropBranchRuntimeFact[] = [];
  let cursor: string | undefined;
  let nextStartAfter = startAfter;
  let headSeq = normalizedAfter;
  while (facts.length < normalizedLimit) {
    const listed = await bucket.list({
      prefix,
      cursor,
      startAfter: nextStartAfter,
      limit: Math.min(1000, Math.max(64, normalizedLimit * 4)),
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
      if (facts.length >= normalizedLimit) break;
    }
    if (facts.length >= normalizedLimit || !listed.truncated || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
    nextStartAfter = undefined;
  }

  return {
    facts,
    nextCursor: facts.length ? facts[facts.length - 1]!.seq : null,
    headSeq,
  };
};

/** Creates a runtime-fact timeline repository bound to composed storage ports. */
export const createBranchRuntimeFactLogRepository = ({
  blobs,
  sql,
}: BranchRuntimeFactLogRepositoryPorts): BranchRuntimeFactLogRepository => ({
  readBranchHeadRuntimeFactSeq: (rootDropId, branchId) =>
    readBranchHeadRuntimeFactSeq(blobs, rootDropId, branchId, sql),
  appendBranchRuntimeFact: (rootDropId, branchId, fact) =>
    appendBranchRuntimeFact(blobs, rootDropId, branchId, fact, sql),
  pollBranchRuntimeFactsSince: (rootDropId, branchId, afterSeq, limit) =>
    pollBranchRuntimeFactsSince(blobs, rootDropId, branchId, afterSeq, limit, sql),
});
