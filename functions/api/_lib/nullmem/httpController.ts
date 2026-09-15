import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../accounts/session/auth";
import { createBranchRepository } from "../branches/storage/repository";
import {
  jsonErrorResponse,
  jsonResponse,
  readRequestTextWithLimit,
  resolveParam,
} from "../core/http/responses";
import { createDropIdentityRepository } from "../drops/identity/id";
import { createNullMemService } from "./applicationService";
import {
  type NullMemFactRecord,
  type NullMemProcedureRecord,
  type NullMemRecord,
  type NullMemSourceRef,
} from "../../../../shared/nullmem/types";
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
  recordId?: string | string[];
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

interface NullMemHttpServices {
  memory: VoidMemory;
}

const NULLMEM_BODY_MAX_BYTES = 256_000;
const PUBLIC_MEMORY_LABEL = "public-memory";

interface NullMemAccess {
  isAnonymous: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const parseJsonBody = async (request: Request): Promise<unknown | null> => {
  const rawBody = await readRequestTextWithLimit(
    request,
    NULLMEM_BODY_MAX_BYTES,
  );
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
};

const parseFactRequest = (value: unknown): NullMemFactRequest | null => {
  if (!isRecord(value)) return null;
  if (value.recordId !== undefined && !isString(value.recordId)) return null;
  if (value.targetKind !== undefined && !isString(value.targetKind))
    return null;
  if (value.targetId !== undefined && !isString(value.targetId)) return null;
  if (value.title !== undefined && !isString(value.title)) return null;
  if (value.text !== undefined && !isString(value.text)) return null;
  if (value.labels !== undefined && !isStringArray(value.labels)) return null;
  if (value.priority !== undefined && !isNumber(value.priority)) return null;
  if (value.confidence !== undefined && !isNumber(value.confidence))
    return null;
  return value as NullMemFactRequest;
};

const parseProcedureRequest = (
  value: unknown,
): NullMemProcedureRequest | null => {
  if (!isRecord(value)) return null;
  if (value.recordId !== undefined && !isString(value.recordId)) return null;
  if (value.goal !== undefined && !isString(value.goal)) return null;
  if (value.summary !== undefined && !isString(value.summary)) return null;
  if (
    value.outcome !== undefined &&
    !["success", "partial", "failed"].includes(String(value.outcome))
  ) {
    return null;
  }
  if (value.reusableAs !== undefined && !isString(value.reusableAs))
    return null;
  if (value.labels !== undefined && !isStringArray(value.labels)) return null;
  if (value.priority !== undefined && !isNumber(value.priority)) return null;
  if (value.confidence !== undefined && !isNumber(value.confidence))
    return null;
  return value as NullMemProcedureRequest;
};

const parseLabelsParam = (value: string | null): string[] =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

const decodePathParam = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const parseLimit = (
  value: string | null,
  fallback: number,
  max: number,
): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
};

const parseOptionalNumber = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseOptionalBoolean = (value: string | null): boolean | undefined => {
  if (value === null) return undefined;
  return value === "true" ? true : value === "false" ? false : undefined;
};

const resolveNullMemTarget = async (
  env: NullMemEnv,
  params: NullMemParams,
): Promise<ResolvedNullMemTarget | { error: Response }> => {
  const requestedRootId = resolveParam(params.rootId);
  const requestedBranchId = resolveParam(params.branchId);
  if (!requestedRootId || !requestedBranchId) {
    return {
      error: jsonErrorResponse(
        400,
        "validation_failed",
        "rootId and branchId are required.",
      ),
    };
  }

  const dropIdentityRepository = createDropIdentityRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const rootDropId = await dropIdentityRepository.resolveRemoteDropId(
    requestedRootId,
  );
  if (!rootDropId) {
    return {
      error: jsonErrorResponse(
        404,
        "root_drop_not_found",
        "Root drop not found.",
      ),
    };
  }

  const branchRepository = createBranchRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const branch = await branchRepository.readBranch(
    rootDropId,
    requestedBranchId,
  );
  if (!branch) {
    return {
      error: jsonErrorResponse(404, "branch_not_found", "Branch not found."),
    };
  }

  return { rootDropId, branchId: requestedBranchId, branch };
};

const authorizeNullMemAccess = async (
  request: Request,
  env: NullMemEnv,
  branch: { ownerAccountId?: string | null; writerAccountId?: string | null },
  action: "query" | "create" | "delete",
): Promise<NullMemAccess | Response> => {
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) {
    if (action === "query") {
      return { isAnonymous: true };
    }
    return jsonErrorResponse(
      401,
      "account_required",
      "Authenticated account session is required.",
    );
  }

  if (
    accountId !== branch.ownerAccountId &&
    accountId !== branch.writerAccountId
  ) {
    return jsonErrorResponse(
      403,
      "forbidden",
      `You are not allowed to ${action} memory for this branch.`,
    );
  }

  return { isAnonymous: false };
};

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
    const access = await authorizeNullMemAccess(
      request,
      env,
      target.branch,
      "query",
    );
    if (access instanceof Response) return access;

    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") as NullMemRecord["kind"] | null;
    if (
      kind !== null &&
      kind !== "capability" &&
      kind !== "procedure" &&
      kind !== "fact"
    ) {
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Invalid memory record kind.",
      );
    }
    const q =
      url.searchParams.get("q") ?? url.searchParams.get("query") ?? undefined;
    const requestedLabels = parseLabelsParam(
      url.searchParams.get("labels") ?? url.searchParams.get("label"),
    );
    const labels = access.isAnonymous
      ? [...new Set([...requestedLabels, PUBLIC_MEMORY_LABEL])]
      : requestedLabels;
    const limit = parseLimit(url.searchParams.get("limit"), 20, 100);
    const procedureId =
      url.searchParams.get("procedureId") ??
      url.searchParams.get("procedure") ??
      url.searchParams.get("recordId") ??
      undefined;
    const afterStep = parseOptionalNumber(
      url.searchParams.get("afterStep") ?? url.searchParams.get("after_step"),
    );
    const stepLimit = parseOptionalNumber(
      url.searchParams.get("stepLimit") ?? url.searchParams.get("step_limit"),
    );
    const includeRecords = parseOptionalBoolean(
      url.searchParams.get("includeRecords") ?? url.searchParams.get("include_records"),
    );
    const includeFreshness =
      url.searchParams.get("includeFreshness") === "true" ||
      url.searchParams.get("include_freshness") === "true" ||
      url.searchParams.get("freshness") === "true";
    const wantsProcedureSteps = Boolean(
      procedureId || typeof afterStep === "number" || typeof stepLimit === "number",
    );

    const result = await memoryServices.memory.query({
      rootDropId: target.rootDropId,
      branchId: target.branchId,
      q,
      kind: kind ?? undefined,
      labels,
      limit,
      includeFreshness,
      procedureId,
      afterStep,
      stepLimit,
      includeRecords: includeRecords ?? !wantsProcedureSteps,
    });

    return jsonResponse({
      ...result,
      query: {
        q,
        kind: result.query.kind,
        labels,
        limit,
        procedureId,
        afterStep,
        stepLimit: result.query.stepLimit,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(
      500,
      "nullmem_query_failed",
      `Failed to query memory: ${message}`,
    );
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
    const access = await authorizeNullMemAccess(
      request,
      env,
      target.branch,
      "create",
    );
    if (access instanceof Response) return access;

    const parsed = parseFactRequest(await parseJsonBody(request));
    if (!parsed?.text) {
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Memory fact payload must include text.",
      );
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
    return jsonErrorResponse(
      500,
      "nullmem_fact_failed",
      `Failed to create memory fact: ${message}`,
    );
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
    const access = await authorizeNullMemAccess(
      request,
      env,
      target.branch,
      "create",
    );
    if (access instanceof Response) return access;

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

/** Deletes a branch-scoped NullMem record by stable record id. */
export const deleteNullMemRecord = async (
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
    const access = await authorizeNullMemAccess(
      request,
      env,
      target.branch,
      "delete",
    );
    if (access instanceof Response) return access;

    const encodedRecordId = resolveParam(params.recordId);
    const recordId = encodedRecordId ? decodePathParam(encodedRecordId) : null;
    if (!recordId) {
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Memory record id is required.",
      );
    }

    const result = await memoryServices.memory.delete({
      rootDropId: target.rootDropId,
      branchId: target.branchId,
      recordId,
    });
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(
      500,
      "nullmem_delete_failed",
      `Failed to delete memory record: ${message}`,
    );
  }
};
