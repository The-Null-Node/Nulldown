import { parseJsonColumn } from "../../core/d1/metadata";
import type { VoidSqlStore } from "../../../../../src/server/ports";
import type { ResolvedPriorityFactRecord } from "../../../../../shared/drop/resolved/types";
import { isResolvedPriorityFactRecord } from "../../../../../shared/drop/resolved/validators";

/** Priority overlays applied during resolved heap queries. */
export interface ResolvedPriorityScoring {
  /** Priority values keyed by resolved node id. */
  priorityByNodeId?: Record<string, number>;
  /** Priority values keyed by source diff event id. */
  priorityByDiffEventId?: Record<string, number>;
  /** Priority value applied to the whole resolved heap. */
  heapPriority?: number;
}

/** Filters for listing branch-scoped resolved priority facts. */
export interface ResolvedPriorityFactListOptions {
  /** Optional resolver id filter. */
  resolverId?: string;
  /** Optional priority target kind filter. */
  targetKind?: ResolvedPriorityFactRecord["targetKind"];
  /** Optional priority target id filter. */
  targetId?: string;
  /** Optional exact fact id filter. */
  factId?: string;
  /** Maximum number of facts to return. */
  limit?: number;
}

const readResolvedPriorityFactsFromD1 = async (
  db: VoidSqlStore | undefined,
  rootDropId: string,
  branchId: string,
  resolverId: string,
): Promise<ResolvedPriorityFactRecord[]> => {
  if (!db) return [];

  const { results = [] } = await db
    .prepare(
      `SELECT fact_json
       FROM resolved_priority_facts
       WHERE root_drop_id = ?
         AND (branch_id = '' OR branch_id = ?)
         AND (resolver_id = '' OR resolver_id = ?)
       ORDER BY created_at DESC`,
    )
    .bind(rootDropId, branchId, resolverId)
    .all<{ fact_json: string }>();

  return results
    .map((row) => parseJsonColumn(row.fact_json, isResolvedPriorityFactRecord))
    .filter((fact): fact is ResolvedPriorityFactRecord => fact !== null);
};

/** Upserts one resolved priority fact into SQL metadata storage. */
export const writeResolvedPriorityFactToD1 = async (
  db: VoidSqlStore,
  fact: ResolvedPriorityFactRecord,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO resolved_priority_facts (
         root_drop_id, branch_id, resolver_id, target_kind, target_id,
         fact_id, priority, created_at, source_seq, source_event_id, fact_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_drop_id, branch_id, resolver_id, target_kind, target_id, fact_id)
       DO UPDATE SET
         priority = excluded.priority,
         created_at = excluded.created_at,
         source_seq = excluded.source_seq,
         source_event_id = excluded.source_event_id,
         fact_json = excluded.fact_json`,
    )
    .bind(
      fact.rootDropId,
      fact.branchId ?? "",
      fact.resolverId ?? "",
      fact.targetKind,
      fact.targetId,
      fact.factId,
      fact.priority,
      fact.createdAt,
      fact.sourceSeq ?? null,
      fact.sourceEventId ?? null,
      JSON.stringify(fact),
    )
    .run();
};

/** Upserts a resolved priority fact into SQL metadata storage when D1 exists. */
export const syncResolvedPriorityFactToD1 = async (
  db: VoidSqlStore | undefined,
  fact: ResolvedPriorityFactRecord,
): Promise<void> => {
  if (!db) return;
  await writeResolvedPriorityFactToD1(db, fact);
};

/** Lists branch-scoped resolved priority facts from SQL metadata storage. */
export const listBranchResolvedPriorityFactsFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  options: ResolvedPriorityFactListOptions = {},
): Promise<ResolvedPriorityFactRecord[]> => {
  const limit = Math.max(1, Math.min(250, Math.floor(options.limit ?? 100)));
  const conditions = ["root_drop_id = ?", "branch_id = ?"];
  const bindings: (string | number)[] = [rootDropId, branchId];
  if (options.resolverId) {
    conditions.push("resolver_id = ?");
    bindings.push(options.resolverId);
  }
  if (options.targetKind) {
    conditions.push("target_kind = ?");
    bindings.push(options.targetKind);
  }
  if (options.targetId) {
    conditions.push("target_id = ?");
    bindings.push(options.targetId);
  }
  if (options.factId) {
    conditions.push("fact_id = ?");
    bindings.push(options.factId);
  }
  bindings.push(limit);

  const { results = [] } = await db
    .prepare(
      `SELECT fact_json
       FROM resolved_priority_facts
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<{ fact_json: string }>();

  return results
    .map((row) => parseJsonColumn(row.fact_json, isResolvedPriorityFactRecord))
    .filter((fact): fact is ResolvedPriorityFactRecord => fact !== null);
};

/** Reads one branch-scoped resolved priority fact by fact id. */
export const readBranchResolvedPriorityFactFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  factId: string,
): Promise<ResolvedPriorityFactRecord | null> => {
  const row = await db
    .prepare(
      `SELECT fact_json
       FROM resolved_priority_facts
       WHERE root_drop_id = ? AND branch_id = ? AND fact_id = ?
       LIMIT 1`,
    )
    .bind(rootDropId, branchId, factId)
    .first<{ fact_json: string }>();
  return row
    ? parseJsonColumn(row.fact_json, isResolvedPriorityFactRecord)
    : null;
};

/** Deletes one branch-scoped resolved priority fact by fact id. */
export const deleteBranchResolvedPriorityFactFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  factId: string,
): Promise<void> => {
  await db
    .prepare(
      `DELETE FROM resolved_priority_facts
       WHERE root_drop_id = ? AND branch_id = ? AND fact_id = ?`,
    )
    .bind(rootDropId, branchId, factId)
    .run();
};

const priorityScoringFromFacts = (
  facts: readonly ResolvedPriorityFactRecord[],
): ResolvedPriorityScoring => {
  const priorityByNodeId: Record<string, number> = {};
  const priorityByDiffEventId: Record<string, number> = {};
  let heapPriority: number | undefined;

  for (const fact of facts) {
    if (fact.targetKind === "node") {
      if (
        !Object.prototype.hasOwnProperty.call(priorityByNodeId, fact.targetId)
      ) {
        priorityByNodeId[fact.targetId] = fact.priority;
      }
    } else if (fact.targetKind === "diff") {
      if (
        !Object.prototype.hasOwnProperty.call(
          priorityByDiffEventId,
          fact.targetId,
        )
      ) {
        priorityByDiffEventId[fact.targetId] = fact.priority;
      }
    } else if (fact.targetKind === "heap" && heapPriority === undefined) {
      heapPriority = fact.priority;
    }
  }

  return {
    priorityByNodeId: Object.keys(priorityByNodeId).length
      ? priorityByNodeId
      : undefined,
    priorityByDiffEventId: Object.keys(priorityByDiffEventId).length
      ? priorityByDiffEventId
      : undefined,
    heapPriority,
  };
};

/** Reads priority overlays for one resolved heap query from SQL metadata. */
export const readResolvedPriorityScoring = async (
  db: VoidSqlStore | undefined,
  rootDropId: string,
  branchId: string,
  resolverId: string,
): Promise<ResolvedPriorityScoring> => {
  const facts = await readResolvedPriorityFactsFromD1(
    db,
    rootDropId,
    branchId,
    resolverId,
  );
  return priorityScoringFromFacts(facts);
};
