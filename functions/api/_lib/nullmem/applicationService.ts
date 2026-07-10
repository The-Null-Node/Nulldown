import { createNullMemCatalogSource } from "./catalogSource";
import { createNullMemFreshnessService } from "./freshnessService";
import { createNullMemRepository } from "./repository";
import {
  nullMemRecordText,
  nullMemRecordToCapsule,
} from "../../../../shared/nullmem/capsule";
import {
  isNullMemFactRecord,
  isNullMemProcedureRecord,
} from "../../../../shared/nullmem/schemas";
import {
  NULLMEM_RECORD_VERSION,
  type NullMemCapsule,
  type NullMemFactRecord,
  type NullMemProcedureRecord,
  type NullMemProcedureStepProjection,
  type NullMemRecord,
} from "../../../../shared/nullmem/types";
import type {
  VoidBlobStore,
  VoidDataStore,
  VoidSqlStore,
} from "../../../../src/server/ports";
import type {
  VoidMemory,
  VoidMemoryDeleteRequest,
} from "../../../../src/server/provider";

/** Dependencies required to compose the NullMem application service. */
export interface CreateNullMemServiceOptions {
  /** Blob store used to read optional capability source catalogs. */
  blobs: VoidBlobStore;
  /** SQL metadata store used to read and write memory records. */
  sql?: VoidSqlStore;
  /** Data store used for derived freshness watermarks. */
  data?: VoidDataStore;
}

/** Application service that orchestrates NullMem records, catalogs, and freshness. */
export type NullMemApplicationService = VoidMemory;

const recordLabels = (record: NullMemRecord): string[] => record.labels ?? [];

const recordPriority = (record: NullMemRecord): number => record.priority ?? 0;

const recordCreatedAt = (record: NullMemRecord): number => record.createdAt;

const queryTokens = (value: string | undefined): string[] =>
  value
    ?.toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((entry) => entry.length > 1) ?? [];

const recordMatches = (
  record: NullMemRecord,
  tokens: readonly string[],
  labels: readonly string[],
): boolean => {
  const text = nullMemRecordText(record).toLowerCase();
  const recordLabelSet = new Set(recordLabels(record));
  return (
    tokens.every((token) => text.includes(token)) &&
    labels.every((label) => recordLabelSet.has(label))
  );
};

const recordScore = (
  record: NullMemRecord,
  tokens: readonly string[],
): number => {
  const text = nullMemRecordText(record).toLowerCase();
  const tokenScore = tokens.reduce(
    (score, token) => score + (text.includes(token) ? 1 : 0),
    0,
  );
  return tokenScore + recordPriority(record);
};

const sortRecords = (
  records: NullMemRecord[],
  tokens: readonly string[],
): NullMemRecord[] =>
  [...records].sort((left, right) => {
    const scoreDiff = recordScore(right, tokens) - recordScore(left, tokens);
    if (scoreDiff !== 0) return scoreDiff;
    const createdDiff = recordCreatedAt(right) - recordCreatedAt(left);
    if (createdDiff !== 0) return createdDiff;
    return left.recordId.localeCompare(right.recordId);
  });

const projectProcedureSteps = (
  records: readonly NullMemRecord[],
  procedureId: string | undefined,
  afterStep: number | undefined,
  stepLimit: number,
): NullMemProcedureStepProjection[] => {
  const procedures = records.filter(
    (record): record is NullMemProcedureRecord =>
      record.kind === "procedure" &&
      (!procedureId || record.recordId === procedureId),
  );
  const selected = procedureId ? procedures.slice(0, 1) : procedures.slice(0, 1);
  const cursor = typeof afterStep === "number" ? afterStep : Number.NEGATIVE_INFINITY;

  return selected.flatMap((procedure) => {
    const ordered = [...procedure.steps].sort((left, right) => left.index - right.index);
    return ordered
      .filter((step) => step.index > cursor)
      .slice(0, stepLimit)
      .map((step) => {
        const remainingSteps = ordered.filter((candidate) => candidate.index > step.index).length;
        return {
          procedureId: procedure.recordId,
          goal: procedure.goal,
          summary: procedure.summary,
          step,
          nextCursor: remainingSteps > 0 ? step.index : undefined,
          remainingSteps,
        };
      });
  });
};

/** Creates the composed NullMem application service backed by focused seams. */
export const createNullMemService = ({
  blobs,
  sql,
  data,
}: CreateNullMemServiceOptions): NullMemApplicationService => {
  const repository = createNullMemRepository({ sql });
  const catalogSource = createNullMemCatalogSource({ blobs });
  const freshnessService = createNullMemFreshnessService({ blobs, sql, data });

  return {
    query: async ({
      rootDropId,
      branchId,
      q,
      kind,
      labels = [],
      limit = 20,
      includeFreshness,
      currentSnapshotId,
      procedureId,
      afterStep,
      stepLimit,
      includeRecords,
    }) => {
      if (!sql)
        throw new Error("SQL metadata store is required to query memory.");
      const tokens = queryTokens(q);
      const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      const wantsProcedureSteps = Boolean(
        procedureId || typeof afterStep === "number" || typeof stepLimit === "number",
      );
      const shouldIncludeRecords = includeRecords ?? !wantsProcedureSteps;
      const normalizedStepLimit = Math.max(1, Math.min(20, Math.floor(stepLimit ?? 1)));
      const effectiveKind = wantsProcedureSteps ? "procedure" : kind;
      const stored = await repository.readRecords(rootDropId, branchId, {
        kind: effectiveKind,
        limit: 500,
      });
      const catalogRecords = await catalogSource.readRecords({ kind: effectiveKind });
      const records = sortRecords([...catalogRecords, ...stored], tokens)
        .filter(
          (record) =>
            !procedureId ||
            (record.kind === "procedure" && record.recordId === procedureId),
        )
        .filter((record) => recordMatches(record, tokens, labels))
        .slice(0, normalizedLimit);
      const capsules: NullMemCapsule[] = records.map(nullMemRecordToCapsule);
      const procedureSteps = wantsProcedureSteps
        ? projectProcedureSteps(records, procedureId, afterStep, normalizedStepLimit)
        : undefined;

      const freshness = includeFreshness
        ? await freshnessService.evaluate({
            rootDropId,
            branchId,
            records,
            currentSnapshotId,
          })
        : undefined;

      return {
        rootDropId,
        branchId,
        query: {
          q,
          kind: effectiveKind,
          labels,
          limit: normalizedLimit,
          procedureId,
          afterStep,
          stepLimit: wantsProcedureSteps ? normalizedStepLimit : undefined,
        },
        capsules,
        records: shouldIncludeRecords ? records : [],
        procedureSteps,
        freshness,
      };
    },
    createFact: async ({ rootDropId, branchId, fact }) => {
      if (!sql)
        throw new Error("SQL metadata store is required to create memory facts.");
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
      if (!sql)
        throw new Error(
          "SQL metadata store is required to create memory procedures.",
        );
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
    delete: async ({ rootDropId, branchId, recordId }: VoidMemoryDeleteRequest) => {
      if (!sql)
        throw new Error("SQL metadata store is required to delete memory records.");
      await repository.deleteRecord(rootDropId, branchId, recordId);
      return { rootDropId, branchId, recordId };
    },
  };
};
