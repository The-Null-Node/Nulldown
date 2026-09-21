import {
  NULLMEM_RECORD_VERSION,
  type NullMemFactRecord,
  type NullMemProcedureRecord,
} from "../../../../shared/nullmem/records";
import {
  isNullMemFactRecord,
  isNullMemProcedureRecord,
} from "../../../../shared/nullmem/validation";
import type {
  BranchMemoryDeleteRequest,
  BranchMemoryDeleteResult,
  BranchMemoryFactRequest,
  BranchMemoryProcedureRequest,
  BranchMemoryWriteResult,
} from "../../../../src/server/runtime";
import type { NullMemRepository } from "./repository";

/** Branch-scoped NullMem write operations composed for one service lifetime. */
export interface NullMemMutationService {
  createFact(
    request: BranchMemoryFactRequest,
  ): Promise<BranchMemoryWriteResult<NullMemFactRecord>>;
  createProcedure(
    request: BranchMemoryProcedureRequest,
  ): Promise<BranchMemoryWriteResult<NullMemProcedureRecord>>;
  delete(request: BranchMemoryDeleteRequest): Promise<BranchMemoryDeleteResult>;
}

/** Creates validated branch memory mutations over the persisted repository. */
export const createNullMemMutationService = (
  repository: NullMemRepository,
): NullMemMutationService => ({
  createFact: async ({ rootDropId, branchId, fact }) => {
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

    await repository.writeRecord(record);
    return { rootDropId, branchId, record };
  },
  createProcedure: async ({ rootDropId, branchId, procedure }) => {
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
      sourceRefs: procedure.sourceRefs ?? [
        { kind: "branch", rootDropId, branchId },
      ],
      createdAt: now,
      metadata: procedure.metadata,
    };

    if (!isNullMemProcedureRecord(record)) {
      throw new Error("Memory procedure payload is invalid.");
    }

    await repository.writeRecord(record);
    return { rootDropId, branchId, record };
  },
  delete: async ({ rootDropId, branchId, recordId }) => {
    await repository.deleteRecord(rootDropId, branchId, recordId);
    return { rootDropId, branchId, recordId };
  },
});
