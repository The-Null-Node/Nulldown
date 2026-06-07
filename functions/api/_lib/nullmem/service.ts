import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../accounts/session/auth";
import { readBranch } from "../branches/storage/repository";
import {
  jsonErrorResponse,
  jsonResponse,
  readRequestTextWithLimit,
  resolveParam,
} from "../core/http/responses";
import { parseJsonColumn } from "../core/d1/metadata";
import { resolveRemoteDropId } from "../drops/identity/id";
import {
  NULLMEM_RECORD_VERSION,
  createRemoteNullplugCapabilityRecord,
  createBuiltInNullMemCapabilities,
  isNullMemFactRecord,
  isNullMemProcedureRecord,
  isNullMemRecord,
  nullMemRecordText,
  nullMemRecordToCapsule,
  type NullMemCapsule,
  type NullMemFactRecord,
  type NullMemProcedureRecord,
  type NullMemRecord,
  type NullMemSourceRef,
} from "../../../../shared/nullmem";
import {
  NULLPLUG_REGISTRY_LATEST_KEY_PREFIX,
  isRemoteNullplugRegistryRecord,
} from "../../../../shared/nullplug/registry";
import type { JsonValue } from "../../../../shared/nullplug/types";
import type { VoidBlobStore, VoidSqlStore } from "../../../../src/server/ports";
import type {
  VoidMemory,
  VoidMemoryFactInput,
  VoidMemoryProcedureInput,
} from "../../../../src/server/provider";

/** Environment required by branch-scoped NullMem services. */
export interface NullMemEnv extends AccountAuthEnv {
  R2_BUCKET: VoidBlobStore;
  DB?: VoidSqlStore;
}

/** Route params for branch-scoped NullMem operations. */
export interface NullMemParams {
  rootId: string | string[];
  branchId: string | string[];
}

interface ResolvedNullMemTarget {
  rootDropId: string;
  branchId: string;
  branch: { ownerAccountId?: string | null; writerAccountId?: string | null };
}

interface NullMemFactRequest {
  recordId?: string;
  targetKind?: NullMemFactRecord["targetKind"];
  targetId?: string;
  title?: string;
  text?: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  metadata?: Record<string, JsonValue>;
}

interface NullMemProcedureRequest {
  recordId?: string;
  goal?: string;
  summary?: string;
  steps?: NullMemProcedureRecord["steps"];
  outcome?: NullMemProcedureRecord["outcome"];
  reusableAs?: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  metadata?: Record<string, JsonValue>;
}

/** Dependencies required to compose the NullMem service. */
export interface CreateNullMemServiceOptions {
  /** Blob store used to read optional capability source catalogs. */
  blobs: VoidBlobStore;
  /** SQL metadata store used to read and write memory records. */
  sql?: VoidSqlStore;
}

interface NullMemHttpServices {
  memory: VoidMemory;
}

const NULLMEM_BODY_MAX_BYTES = 256_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const parseJsonBody = async (request: Request): Promise<unknown | null> => {
  const rawBody = await readRequestTextWithLimit(request, NULLMEM_BODY_MAX_BYTES);
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
};

const parseFactRequest = (value: unknown): NullMemFactRequest | null => {
  if (!isRecord(value)) return null;
  if (value.recordId !== undefined && !isString(value.recordId)) return null;
  if (value.targetKind !== undefined && !isString(value.targetKind)) return null;
  if (value.targetId !== undefined && !isString(value.targetId)) return null;
  if (value.title !== undefined && !isString(value.title)) return null;
  if (value.text !== undefined && !isString(value.text)) return null;
  if (value.labels !== undefined && !isStringArray(value.labels)) return null;
  if (value.priority !== undefined && !isNumber(value.priority)) return null;
  if (value.confidence !== undefined && !isNumber(value.confidence)) return null;
  return value as NullMemFactRequest;
};

const parseProcedureRequest = (value: unknown): NullMemProcedureRequest | null => {
  if (!isRecord(value)) return null;
  if (value.recordId !== undefined && !isString(value.recordId)) return null;
  if (value.goal !== undefined && !isString(value.goal)) return null;
  if (value.summary !== undefined && !isString(value.summary)) return null;
  if (value.outcome !== undefined && !["success", "partial", "failed"].includes(String(value.outcome))) {
    return null;
  }
  if (value.reusableAs !== undefined && !isString(value.reusableAs)) return null;
  if (value.labels !== undefined && !isStringArray(value.labels)) return null;
  if (value.priority !== undefined && !isNumber(value.priority)) return null;
  if (value.confidence !== undefined && !isNumber(value.confidence)) return null;
  return value as NullMemProcedureRequest;
};

const resolveNullMemTarget = async (
  env: NullMemEnv,
  params: NullMemParams,
): Promise<ResolvedNullMemTarget | { error: Response }> => {
  const requestedRootId = resolveParam(params.rootId);
  const requestedBranchId = resolveParam(params.branchId);
  if (!requestedRootId || !requestedBranchId) {
    return { error: jsonErrorResponse(400, "validation_failed", "rootId and branchId are required.") };
  }

  const rootDropId = await resolveRemoteDropId(env.R2_BUCKET, requestedRootId, undefined, env.DB);
  if (!rootDropId) {
    return { error: jsonErrorResponse(404, "root_drop_not_found", "Root drop not found.") };
  }

  const branch = await readBranch(env.R2_BUCKET, rootDropId, requestedBranchId, env.DB);
  if (!branch) {
    return { error: jsonErrorResponse(404, "branch_not_found", "Branch not found.") };
  }

  return { rootDropId, branchId: requestedBranchId, branch };
};

const authorizeNullMemAccess = async (
  request: Request,
  env: NullMemEnv,
  branch: { ownerAccountId?: string | null; writerAccountId?: string | null },
  action: "query" | "create",
): Promise<Response | null> => {
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) {
    return jsonErrorResponse(
      401,
      "account_required",
      "Authenticated account session is required.",
    );
  }

  if (accountId !== branch.ownerAccountId && accountId !== branch.writerAccountId) {
    return jsonErrorResponse(
      403,
      "forbidden",
      `You are not allowed to ${action} memory for this branch.`,
    );
  }

  return null;
};

const recordLabels = (record: NullMemRecord): string[] => record.labels ?? [];

const recordPriority = (record: NullMemRecord): number => record.priority ?? 0;

const recordCreatedAt = (record: NullMemRecord): number => record.createdAt;

const writeNullMemRecordToD1 = async (
  db: VoidSqlStore,
  record: NullMemRecord,
): Promise<void> => {
  const rootDropId = "rootDropId" in record ? record.rootDropId ?? "" : "";
  const branchId = "branchId" in record ? record.branchId ?? "" : "";
  const targetKind = record.kind === "fact"
    ? record.targetKind ?? ""
    : record.kind === "capability"
      ? record.capabilityKind
      : "procedure";
  const targetId = record.kind === "fact"
    ? record.targetId ?? ""
    : record.kind === "capability"
      ? record.capabilityId
      : record.recordId;
  const createdAt = record.createdAt;
  const updatedAt = record.updatedAt ?? createdAt;

  await db
    .prepare(
      `INSERT INTO nullmem_records (
         root_drop_id, branch_id, record_kind, record_id, target_kind, target_id,
         text, labels_json, priority, confidence, created_at, updated_at, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_drop_id, branch_id, record_kind, record_id)
       DO UPDATE SET
         target_kind = excluded.target_kind,
         target_id = excluded.target_id,
         text = excluded.text,
         labels_json = excluded.labels_json,
         priority = excluded.priority,
         confidence = excluded.confidence,
         updated_at = excluded.updated_at,
         record_json = excluded.record_json`,
    )
    .bind(
      rootDropId,
      branchId,
      record.kind,
      record.recordId,
      targetKind,
      targetId,
      nullMemRecordText(record),
      JSON.stringify(recordLabels(record)),
      record.priority ?? null,
      record.confidence ?? null,
      createdAt,
      updatedAt,
      JSON.stringify(record),
    )
    .run();
};

const readNullMemRecordsFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  kind?: NullMemRecord["kind"],
  limit = 250,
): Promise<NullMemRecord[]> => {
  const conditions = ["((root_drop_id = '' AND branch_id = '') OR (root_drop_id = ? AND branch_id = ?))"];
  const bindings: (string | number)[] = [rootDropId, branchId];
  if (kind) {
    conditions.push("record_kind = ?");
    bindings.push(kind);
  }
  bindings.push(Math.max(1, Math.min(500, Math.floor(limit))));

  const { results = [] } = await db
    .prepare(
      `SELECT record_json
       FROM nullmem_records
       WHERE ${conditions.join(" AND ")}
       ORDER BY COALESCE(priority, 0) DESC, created_at DESC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<{ record_json: string }>();

  return results
    .map((row) => parseJsonColumn(row.record_json, isNullMemRecord))
    .filter((record): record is NullMemRecord => record !== null);
};

const parseLabelsParam = (value: string | null): string[] =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

const queryTokens = (value: string | undefined): string[] =>
  value?.toLowerCase().match(/[a-z0-9]+/g)?.filter((entry) => entry.length > 1) ?? [];

const parseLimit = (value: string | null, fallback: number, max: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
};

const recordMatches = (
  record: NullMemRecord,
  tokens: readonly string[],
  labels: readonly string[],
): boolean => {
  const text = nullMemRecordText(record).toLowerCase();
  const recordLabelSet = new Set(recordLabels(record));
  return tokens.every((token) => text.includes(token)) && labels.every((label) => recordLabelSet.has(label));
};

const recordScore = (record: NullMemRecord, tokens: readonly string[]): number => {
  const text = nullMemRecordText(record).toLowerCase();
  const tokenScore = tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
  return tokenScore + recordPriority(record);
};

const sortRecords = (records: NullMemRecord[], tokens: readonly string[]): NullMemRecord[] =>
  [...records].sort((left, right) => {
    const scoreDiff = recordScore(right, tokens) - recordScore(left, tokens);
    if (scoreDiff !== 0) return scoreDiff;
    const createdDiff = recordCreatedAt(right) - recordCreatedAt(left);
    if (createdDiff !== 0) return createdDiff;
    return left.recordId.localeCompare(right.recordId);
  });

const readRemoteNullplugCapabilityRecords = async (
  store: VoidBlobStore,
): Promise<NullMemRecord[]> => {
  const records: NullMemRecord[] = [];
  let cursor: string | undefined;

  do {
    const listed = await store.list({
      prefix: NULLPLUG_REGISTRY_LATEST_KEY_PREFIX,
      cursor,
      limit: 200,
    });

    const pageRecords = await Promise.all(
      listed.objects.map(async (entry) => {
        const object = await store.get(entry.key);
        if (!object) return null;
        try {
          const parsed = await object.json();
          if (!isRemoteNullplugRegistryRecord(parsed) || parsed.status !== "active") {
            return null;
          }
          return createRemoteNullplugCapabilityRecord(parsed);
        } catch {
          return null;
        }
      }),
    );

    records.push(...pageRecords.filter((record): record is NullMemRecord => record !== null));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return records;
};

/** Creates the composed VoidProvider memory facade backed by NullMem records. */
export const createNullMemService = ({
  blobs,
  sql,
}: CreateNullMemServiceOptions): VoidMemory => ({
  query: async ({ rootDropId, branchId, q, kind, labels = [], limit = 20 }) => {
    if (!sql) throw new Error("SQL metadata store is required to query memory.");
    const tokens = queryTokens(q);
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const stored = await readNullMemRecordsFromD1(
      sql,
      rootDropId,
      branchId,
      kind,
      500,
    );
    const builtIns = kind && kind !== "capability"
      ? []
      : createBuiltInNullMemCapabilities(0);
    const remoteNullplugCapabilities = kind && kind !== "capability"
      ? []
      : await readRemoteNullplugCapabilityRecords(blobs).catch(() => []);
    const records = sortRecords(
      [...builtIns, ...remoteNullplugCapabilities, ...stored],
      tokens,
    )
      .filter((record) => recordMatches(record, tokens, labels))
      .slice(0, normalizedLimit);
    const capsules: NullMemCapsule[] = records.map(nullMemRecordToCapsule);

    return {
      rootDropId,
      branchId,
      query: { q, kind, labels, limit: normalizedLimit },
      capsules,
      records,
    };
  },
  createFact: async ({ rootDropId, branchId, fact }) => {
    if (!sql) throw new Error("SQL metadata store is required to create memory facts.");
    const now = Date.now();
    const record: NullMemFactRecord = {
      version: NULLMEM_RECORD_VERSION,
      kind: "fact",
      recordId: fact.recordId ?? `memfact:${crypto.randomUUID()}`,
      rootDropId,
      branchId,
      targetKind: fact.targetKind,
      targetId: fact.targetId,
      title: fact.title,
      text: fact.text,
      labels: fact.labels,
      priority: fact.priority,
      confidence: fact.confidence,
      sourceRefs: fact.sourceRefs ?? [{ kind: "branch", rootDropId, branchId }],
      createdAt: now,
      metadata: fact.metadata,
    };

    if (!isNullMemFactRecord(record)) {
      throw new Error("Memory fact payload is invalid.");
    }

    await writeNullMemRecordToD1(sql, record);
    return { rootDropId, branchId, record };
  },
  createProcedure: async ({ rootDropId, branchId, procedure }) => {
    if (!sql) throw new Error("SQL metadata store is required to create memory procedures.");
    const now = Date.now();
    const record: NullMemProcedureRecord = {
      version: NULLMEM_RECORD_VERSION,
      kind: "procedure",
      recordId: procedure.recordId ?? `memproc:${crypto.randomUUID()}`,
      rootDropId,
      branchId,
      goal: procedure.goal,
      summary: procedure.summary,
      steps: procedure.steps ?? [],
      outcome: procedure.outcome ?? "success",
      reusableAs: procedure.reusableAs,
      labels: procedure.labels,
      priority: procedure.priority,
      confidence: procedure.confidence,
      sourceRefs: procedure.sourceRefs ?? [{ kind: "branch", rootDropId, branchId }],
      createdAt: now,
      metadata: procedure.metadata,
    };

    if (!isNullMemProcedureRecord(record)) {
      throw new Error("Memory procedure payload is invalid.");
    }

    await writeNullMemRecordToD1(sql, record);
    return { rootDropId, branchId, record };
  },
});

const createNullMemHttpServices = (
  env: NullMemEnv,
  services?: Partial<NullMemHttpServices>,
): NullMemHttpServices | { error: Response } => {
  if (!env.DB) {
    return {
      error: jsonErrorResponse(
        500,
        "sql_store_required",
        "SQL metadata store is required to use memory.",
      ),
    };
  }
  if (services?.memory) return { memory: services.memory };

  return {
    memory: createNullMemService({ blobs: env.R2_BUCKET, sql: env.DB }),
  };
};

/** Queries branch-scoped NullMem records and built-in capability memory. */
export const queryNullMem = async (
  env: NullMemEnv,
  params: NullMemParams,
  request: Request,
  services?: Partial<NullMemHttpServices>,
): Promise<Response> => {
  const memoryServices = createNullMemHttpServices(env, services);
  if ("error" in memoryServices) return memoryServices.error;

  try {
    const target = await resolveNullMemTarget(env, params);
    if ("error" in target) return target.error;
    const authError = await authorizeNullMemAccess(request, env, target.branch, "query");
    if (authError) return authError;

    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") as NullMemRecord["kind"] | null;
    if (kind !== null && kind !== "capability" && kind !== "procedure" && kind !== "fact") {
      return jsonErrorResponse(400, "validation_failed", "Invalid memory record kind.");
    }
    const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? undefined;
    const labels = parseLabelsParam(url.searchParams.get("labels") ?? url.searchParams.get("label"));
    const limit = parseLimit(url.searchParams.get("limit"), 20, 100);

    const result = await memoryServices.memory.query({
      rootDropId: target.rootDropId,
      branchId: target.branchId,
      q,
      kind: kind ?? undefined,
      labels,
      limit,
    });

    return jsonResponse({ ...result, query: { q, kind, labels, limit } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(500, "nullmem_query_failed", `Failed to query memory: ${message}`);
  }
};

/** Creates a branch-scoped NullMem fact for agent memory and annotations. */
export const createNullMemFact = async (
  env: NullMemEnv,
  params: NullMemParams,
  request: Request,
  services?: Partial<NullMemHttpServices>,
): Promise<Response> => {
  const memoryServices = createNullMemHttpServices(env, services);
  if ("error" in memoryServices) return memoryServices.error;

  try {
    const target = await resolveNullMemTarget(env, params);
    if ("error" in target) return target.error;
    const authError = await authorizeNullMemAccess(request, env, target.branch, "create");
    if (authError) return authError;

    const parsed = parseFactRequest(await parseJsonBody(request));
    if (!parsed?.text) {
      return jsonErrorResponse(400, "validation_failed", "Memory fact payload must include text.");
    }

    const result = await memoryServices.memory.createFact({
      rootDropId: target.rootDropId,
      branchId: target.branchId,
      fact: parsed as VoidMemoryFactInput,
    });
    return jsonResponse(result, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Memory fact payload is invalid.") {
      return jsonErrorResponse(400, "validation_failed", message);
    }
    return jsonErrorResponse(500, "nullmem_fact_failed", `Failed to create memory fact: ${message}`);
  }
};

/** Creates a branch-scoped NullMem procedure for reusable call sequences. */
export const createNullMemProcedure = async (
  env: NullMemEnv,
  params: NullMemParams,
  request: Request,
  services?: Partial<NullMemHttpServices>,
): Promise<Response> => {
  const memoryServices = createNullMemHttpServices(env, services);
  if ("error" in memoryServices) return memoryServices.error;

  try {
    const target = await resolveNullMemTarget(env, params);
    if ("error" in target) return target.error;
    const authError = await authorizeNullMemAccess(request, env, target.branch, "create");
    if (authError) return authError;

    const parsed = parseProcedureRequest(await parseJsonBody(request));
    if (!parsed?.goal || !parsed.summary) {
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Memory procedure payload must include goal and summary.",
      );
    }

    const result = await memoryServices.memory.createProcedure({
      rootDropId: target.rootDropId,
      branchId: target.branchId,
      procedure: parsed as VoidMemoryProcedureInput,
    });
    return jsonResponse(result, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Memory procedure payload is invalid.") {
      return jsonErrorResponse(400, "validation_failed", message);
    }
    return jsonErrorResponse(
      500,
      "nullmem_procedure_failed",
      `Failed to create memory procedure: ${message}`,
    );
  }
};
