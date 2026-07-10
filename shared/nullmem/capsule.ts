import type { NullMemCapsule, NullMemRecord } from "./types";

/** Builds searchable text for a NullMem record without copying full source content. */
export const nullMemRecordText = (record: NullMemRecord): string => {
  if (record.kind === "capability") {
    return [
      record.title,
      record.capabilityKind,
      record.capabilityId,
      record.description,
      ...(record.whenToUse ?? []),
      ...(record.whenNotToUse ?? []),
      ...(record.examples ?? []).map((example) =>
        [example.title, example.summary].filter(Boolean).join(" "),
      ),
      ...(record.labels ?? []),
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (record.kind === "procedure") {
    return [
      record.goal,
      record.summary,
      record.reusableAs,
      ...record.steps.map((step) =>
        [
          step.kind,
          step.name,
          step.description,
          step.argsSummary,
          step.callHint?.target,
          step.callHint?.name,
          step.callHint?.argsSummary,
          step.exitCondition,
          step.minStep ? "min-step" : undefined,
          step.resultSummary,
          step.status,
        ]
          .filter(Boolean)
          .join(" "),
      ),
      ...(record.labels ?? []),
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    record.title,
    record.text,
    record.targetKind,
    record.targetId,
    ...(record.labels ?? []),
  ]
    .filter(Boolean)
    .join(" ");
};

/** Converts a full NullMem record into the compact capsule returned by queries. */
export const nullMemRecordToCapsule = (
  record: NullMemRecord,
): NullMemCapsule => {
  if (record.kind === "capability") {
    return {
      recordId: record.recordId,
      kind: record.kind,
      title: record.title ?? record.capabilityId,
      summary: record.description,
      labels: record.labels,
      priority: record.priority,
      confidence: record.confidence,
      sourceRefs: record.sourceRefs,
      record,
    };
  }
  if (record.kind === "procedure") {
    return {
      recordId: record.recordId,
      kind: record.kind,
      title: record.goal,
      summary: record.summary,
      labels: record.labels,
      priority: record.priority,
      confidence: record.confidence,
      sourceRefs: record.sourceRefs,
      record,
    };
  }
  return {
    recordId: record.recordId,
    kind: record.kind,
    title: record.title,
    summary: record.text,
    labels: record.labels,
    priority: record.priority,
    confidence: record.confidence,
    sourceRefs: record.sourceRefs,
    record,
  };
};
