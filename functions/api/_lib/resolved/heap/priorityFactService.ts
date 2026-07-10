import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  jsonResponse,
  readRequestTextWithLimit,
  resolveParam,
  type JsonValue,
} from "../../core/http/responses";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_PRIORITY_FACT_RECORD_VERSION,
} from "../../../../../shared/drop/resolved/constants";
import type { ResolvedPriorityFactRecord } from "../../../../../shared/drop/resolved/types";
import { isResolvedPriorityFactRecord } from "../../../../../shared/drop/resolved/validators";
import { authorizeResolvedPriorityFactWrite, resolveResolvedBranchTarget } from "./context";
import { createResolvedHeapRepository } from "./repository";
import {
  decodeRouteParam,
  defaultPriorityTargetId,
  isPriorityTargetKind,
  parsePositiveInteger,
  parseResolvedPriorityFactBody,
} from "./request";
import type {
  ResolvedHeapEnv,
  ResolvedHeapParams,
  ResolvedPriorityFactDeleteParams,
} from "./types";

const RESOLVED_PRIORITY_FACT_BODY_MAX_BYTES = 100_000;

const createResolvedPriorityFactUnsafe = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  if (!env.DB) {
    return jsonErrorResponse(
      500,
      "sql_store_required",
      "SQL metadata store is required to create resolved priority facts.",
    );
  }

  const target = await resolveResolvedBranchTarget(env, params);
  if ("error" in target) return target.error;
  const { rootDropId, branchId, branch } = target;

  const authError = await authorizeResolvedPriorityFactWrite(
    request,
    env,
    branch,
    "create",
  );
  if (authError) return authError;

  const rawBody = await readRequestTextWithLimit(
    request,
    RESOLVED_PRIORITY_FACT_BODY_MAX_BYTES,
  );
  const parsed = parseResolvedPriorityFactBody(rawBody);
  if (!parsed || parsed.priority === undefined || !parsed.targetKind) {
    return jsonErrorResponse(
      400,
      "validation_failed",
      "Priority fact payload must include targetKind and priority.",
    );
  }

  const resolverId =
    parsed.resolverId ??
    (parsed.targetKind === "node" ? RESOLVED_DOCUMENT_RESOLVER_ID : undefined);
  const targetId =
    parsed.targetId ??
    defaultPriorityTargetId(rootDropId, branchId, resolverId, parsed.targetKind);
  if (!targetId) {
    return jsonErrorResponse(
      400,
      "validation_failed",
      "targetId is required for node and diff priority facts.",
    );
  }

  const fact: ResolvedPriorityFactRecord = {
    version: RESOLVED_PRIORITY_FACT_RECORD_VERSION,
    factId: parsed.factId ?? `priority:${crypto.randomUUID()}`,
    rootDropId,
    branchId,
    resolverId,
    targetKind: parsed.targetKind,
    targetId,
    priority: parsed.priority,
    createdAt: Date.now(),
    sourceSeq: parsed.sourceSeq,
    sourceEventId: parsed.sourceEventId,
    reason: parsed.reason,
    labels: parsed.labels,
    metadata: parsed.metadata as Record<string, JsonValue> | undefined,
  };

  if (!isResolvedPriorityFactRecord(fact)) {
    return jsonErrorResponse(
      400,
      "validation_failed",
      "Priority fact payload is invalid.",
    );
  }

  await createResolvedHeapRepository({ sql: env.DB }).writePriorityFact(fact);
  return jsonResponse({ rootDropId, branchId, fact }, 201);
};

const listResolvedPriorityFactsUnsafe = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  if (!env.DB) {
    return jsonErrorResponse(
      500,
      "sql_store_required",
      "SQL metadata store is required to list resolved priority facts.",
    );
  }

  const target = await resolveResolvedBranchTarget(env, params);
  if ("error" in target) return target.error;
  const { rootDropId, branchId, branch } = target;
  const authError = await authorizeResolvedPriorityFactWrite(
    request,
    env,
    branch,
    "list",
  );
  if (authError) return authError;

  const url = new URL(request.url);
  const targetKindParam =
    url.searchParams.get("targetKind") ?? url.searchParams.get("target-kind");
  if (targetKindParam !== null && !isPriorityTargetKind(targetKindParam)) {
    return jsonErrorResponse(400, "validation_failed", "Invalid targetKind.");
  }

  const facts = await createResolvedHeapRepository({
    sql: env.DB,
  }).listBranchPriorityFacts(rootDropId, branchId, {
    resolverId:
      url.searchParams.get("resolverId") ??
      url.searchParams.get("resolver") ??
      undefined,
    targetKind: targetKindParam ?? undefined,
    targetId:
      url.searchParams.get("targetId") ??
      url.searchParams.get("target") ??
      undefined,
    factId:
      url.searchParams.get("factId") ?? url.searchParams.get("fact") ?? undefined,
    limit: parsePositiveInteger(url.searchParams.get("limit"), 100),
  });

  return jsonResponse({ rootDropId, branchId, facts });
};

const deleteResolvedPriorityFactUnsafe = async (
  env: ResolvedHeapEnv,
  params: ResolvedPriorityFactDeleteParams,
  request: Request,
): Promise<Response> => {
  if (!env.DB) {
    return jsonErrorResponse(
      500,
      "sql_store_required",
      "SQL metadata store is required to delete resolved priority facts.",
    );
  }

  const target = await resolveResolvedBranchTarget(env, params);
  if ("error" in target) return target.error;
  const { rootDropId, branchId, branch } = target;
  const authError = await authorizeResolvedPriorityFactWrite(
    request,
    env,
    branch,
    "delete",
  );
  if (authError) return authError;

  const factId = decodeRouteParam(resolveParam(params.factId));
  if (!factId) {
    return jsonErrorResponse(400, "validation_failed", "factId is required.");
  }

  const repository = createResolvedHeapRepository({ sql: env.DB });
  const existing = await repository.readBranchPriorityFact(
    rootDropId,
    branchId,
    factId,
  );
  if (!existing) {
    return jsonErrorResponse(
      404,
      "priority_fact_not_found",
      "Priority fact not found.",
    );
  }

  await repository.deleteBranchPriorityFact(rootDropId, branchId, factId);
  return jsonResponse({ rootDropId, branchId, factId, deleted: true });
};

/** Creates a branch-scoped resolved priority fact used by future heap queries. */
export const createResolvedPriorityFact = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  try {
    return await createResolvedPriorityFactUnsafe(env, params, request);
  } catch (error) {
    if (isApiHttpError(error)) {
      return apiHttpErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(
      500,
      "resolved_priority_fact_failed",
      `Failed to create resolved priority fact: ${message}`,
    );
  }
};

/** Lists branch-scoped resolved priority facts for branch writers. */
export const listResolvedPriorityFacts = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  try {
    return await listResolvedPriorityFactsUnsafe(env, params, request);
  } catch (error) {
    if (isApiHttpError(error)) {
      return apiHttpErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(
      500,
      "resolved_priority_fact_list_failed",
      `Failed to list resolved priority facts: ${message}`,
    );
  }
};

/** Deletes one branch-scoped resolved priority fact for branch writers. */
export const deleteResolvedPriorityFact = async (
  env: ResolvedHeapEnv,
  params: ResolvedPriorityFactDeleteParams,
  request: Request,
): Promise<Response> => {
  try {
    return await deleteResolvedPriorityFactUnsafe(env, params, request);
  } catch (error) {
    if (isApiHttpError(error)) {
      return apiHttpErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(
      500,
      "resolved_priority_fact_delete_failed",
      `Failed to delete resolved priority fact: ${message}`,
    );
  }
};
