import type { NullplugUiRuntimeFact } from "../../../../shared/nullplug/ui";
import { sanitizeBranchId } from "../../../../shared/drop/branch-identity";
import { BranchStateError } from "../../../../shared/drop/branch-state";
import { createBranchStatePlane } from "../../../../src/server/state-plane/gateway";
import { branchStateErrorResponse } from "../branches/http/state-plane-errors";
import { createDropIdentityRepository } from "../drops/identity/id";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  jsonResponse,
} from "../core/http/responses";
import { toLogRef, type RequestLogger } from "../core/logging/logger";
import type { ResolvedHeapEnv } from "../resolved/heap/types";
import { readAccountLibraryEntry } from "../accounts/library/repository";

/** Handles one authenticated local UI-fact request; durable authority owns commit-time checks and retries. */
export async function storeLocalUiFact(
  env: ResolvedHeapEnv,
  fact: NullplugUiRuntimeFact,
  actorAccountId: string,
  logger: RequestLogger,
): Promise<Response> {
  try {
    if (!env.localBranchApplication?.runtimeFacts)
      throw new BranchStateError("capability_unsupported");
    const branchId = sanitizeBranchId(fact.source.branchId);
    if (!branchId) {
      logger.logEnd(400, { reason: "branch_required" });
      return jsonErrorResponse(
        400,
        "branch_required",
        "Nullplug UI facts must target a branch.",
      );
    }
    const rootDropId = await createDropIdentityRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    }).resolveRemoteDropIdForReadRequest(fact.source.rootDropId, logger);
    if (!rootDropId) {
      logger.logEnd(404, { reason: "root_drop_not_found" });
      return jsonErrorResponse(
        404,
        "root_drop_not_found",
        "Root drop not found.",
      );
    }
    const plane = createBranchStatePlane({
      blobs: env.R2_BUCKET,
      sql: env.DB,
      localBranchApplication: env.localBranchApplication,
    });
    if (!plane.runtimeFacts)
      throw new BranchStateError("capability_unsupported");
    const entry = env.DB
      ? await readAccountLibraryEntry(env.DB, rootDropId)
      : null;
    if (
      entry &&
      (entry.deleted_at !== null ||
        !["public", "unlisted", "private"].includes(entry.visibility) ||
        (entry.visibility === "private" &&
          entry.account_id !== actorAccountId &&
          (await plane.branches.readBranch(rootDropId, branchId))
            ?.writerAccountId !== actorAccountId))
    ) {
      logger.logEnd(404, { reason: "root_drop_not_found" });
      return jsonErrorResponse(
        404,
        "root_drop_not_found",
        "Root drop not found.",
      );
    }
    const result = await plane.runtimeFacts.storeUiFact({
      rootDropId,
      branchId,
      actorAccountId,
      fact: {
        ...fact,
        source: { ...fact.source, rootDropId, branchId },
        metadata: { ...fact.metadata, actorAccountId },
      },
    });
    logger.logEnd(200, {
      rootDropRef: toLogRef(rootDropId),
      branchRef: toLogRef(branchId),
      kind: result.fact.kind,
      appended: result.runtimeFact.appended,
      indexed: false,
    });
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof BranchStateError) {
      logger.logEnd(error.toRecord().status, {
        reason: error.code,
        outcome: error.toRecord().outcome,
      });
      return branchStateErrorResponse(error);
    }
    if (isApiHttpError(error)) return apiHttpErrorResponse(error);
    throw error;
  }
}
