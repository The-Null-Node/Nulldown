import {
  nullMemRecordText,
  nullMemRecordToCapsule,
  type NullMemCapsule,
} from "../../../../shared/nullmem/capsule";
import type {
  NullMemProcedureRecord,
  NullMemRecord,
} from "../../../../shared/nullmem/records";
import type { NullMemProcedureStepProjection } from "../../../../shared/nullmem/procedure";
import type {
  BranchMemoryQueryRequest,
  BranchMemoryQueryResult,
} from "../../../../src/server/runtime";
import type { NullMemCatalogSource } from "./catalog";
import type { NullMemFreshnessService } from "./freshness";
import type { NullMemRepository } from "./repository";

/** Dependencies used by branch-scoped NullMem retrieval. */
export interface NullMemQueryPorts {
  repository: NullMemRepository;
  catalog: NullMemCatalogSource;
  freshness: NullMemFreshnessService;
}

/** Branch-scoped query operation composed for one service lifetime. */
export type QueryNullMem = (
  request: BranchMemoryQueryRequest,
) => Promise<BranchMemoryQueryResult>;

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
  const selected = procedureId
    ? procedures.slice(0, 1)
    : procedures.slice(0, 1);
  const cursor =
    typeof afterStep === "number" ? afterStep : Number.NEGATIVE_INFINITY;

  return selected.flatMap((procedure) => {
    const ordered = [...procedure.steps].sort(
      (left, right) => left.index - right.index,
    );
    return ordered
      .filter((step) => step.index > cursor)
      .slice(0, stepLimit)
      .map((step) => {
        const remainingSteps = ordered.filter(
          (candidate) => candidate.index > step.index,
        ).length;
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

/** Creates the branch memory query operation from its focused dependencies. */
export const createNullMemQuery =
  ({ repository, catalog, freshness }: NullMemQueryPorts): QueryNullMem =>
  async ({
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
    const tokens = queryTokens(q);
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const wantsProcedureSteps = Boolean(
      procedureId ||
      typeof afterStep === "number" ||
      typeof stepLimit === "number",
    );
    const shouldIncludeRecords = includeRecords ?? !wantsProcedureSteps;
    const normalizedStepLimit = Math.max(
      1,
      Math.min(20, Math.floor(stepLimit ?? 1)),
    );
    const effectiveKind = wantsProcedureSteps ? "procedure" : kind;
    const stored = await repository.readRecords(rootDropId, branchId, {
      kind: effectiveKind,
      limit: 500,
    });
    const catalogRecords = await catalog.readRecords({ kind: effectiveKind });
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
      ? projectProcedureSteps(
          records,
          procedureId,
          afterStep,
          normalizedStepLimit,
        )
      : undefined;

    const freshnessReports = includeFreshness
      ? await freshness.evaluate({
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
      freshness: freshnessReports,
    };
  };
