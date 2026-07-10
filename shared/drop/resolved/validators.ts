import {
  isDropDiffEventMetadata,
  type JsonValue,
} from "../diff";
import {
  RESOLVED_HEAP_DELTA_RECORD_VERSION,
  RESOLVED_NODE_REF_RECORD_VERSION,
  RESOLVED_PRIORITY_FACT_RECORD_VERSION,
} from "./constants";
import { isNulldownSourceHash } from "./hash";
import type {
  NulldownContextQueryHint,
  NulldownContextQueryKind,
  NulldownContextToken,
  ResolvedChecklistItem,
  ResolvedDiffEventRef,
  ResolvedDocumentNode,
  ResolvedDocumentNodeKind,
  ResolvedHeapDeltaRecord,
  ResolvedHeapRef,
  ResolvedNulldownState,
  ResolvedNodeDeltaOp,
  ResolvedNodeRefRecord,
  ResolvedPluginRef,
  ResolvedPolicyFact,
  ResolvedPriorityFactRecord,
  ResolvedRuntimeNode,
  ResolvedRuntimeNodeKind,
  ResolvedSourceRange,
  ResolvedSourceSeqRange,
  ResolvedUiResponseRef,
} from "./types";
import type { NullplugUiSource } from "../../nullplug/ui";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  isNumber(value) && Number.isInteger(value) && value >= 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isJsonValue = (value: unknown, depth = 0): value is JsonValue => {
  if (depth > 24) return false;
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
};

const isJsonRecord = (value: unknown): value is Record<string, JsonValue> =>
  isRecord(value) &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => isJsonValue(entry));

const isNulldownContextQueryKind = (
  value: unknown,
): value is NulldownContextQueryKind =>
  value === "checklist.next" ||
  value === "plan.status" ||
  value === "dependency.edges" ||
  value === "policy.pending";

const isNulldownContextQueryHint = (
  value: unknown,
): value is NulldownContextQueryHint => {
  if (!isRecord(value)) return false;
  return isString(value.dropId) && isNulldownContextQueryKind(value.kind);
};

export const isNulldownContextToken = (
  value: unknown,
): value is NulldownContextToken => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isString(value.rootDropId)) return false;
  if (value.branchId !== undefined && !isString(value.branchId)) return false;
  if (value.snapshotId !== undefined && !isNonNegativeInteger(value.snapshotId)) {
    return false;
  }
  if (
    value.checklistDropId !== undefined &&
    !isString(value.checklistDropId)
  ) {
    return false;
  }
  if (
    !Array.isArray(value.resolvedHeapIds) ||
    !value.resolvedHeapIds.every((entry) => isString(entry))
  ) {
    return false;
  }
  if (!isRecord(value.sourceHashes)) return false;
  if (!Object.values(value.sourceHashes).every(isNulldownSourceHash)) {
    return false;
  }
  if (
    !Array.isArray(value.queryHints) ||
    !value.queryHints.every(isNulldownContextQueryHint)
  ) {
    return false;
  }
  return true;
};

const isResolvedSourceRange = (value: unknown): value is ResolvedSourceRange => {
  if (!isRecord(value)) return false;
  return isNonNegativeInteger(value.start) && isNonNegativeInteger(value.end);
};

const isResolvedSourceSeqRange = (
  value: unknown,
): value is ResolvedSourceSeqRange => {
  if (!isRecord(value)) return false;
  return isNonNegativeInteger(value.from) && isNonNegativeInteger(value.to);
};

const isResolvedChecklistItem = (
  value: unknown,
): value is ResolvedChecklistItem => {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isString(value.text)) return false;
  if (typeof value.checked !== "boolean") return false;
  if (value.phase !== undefined && !isString(value.phase)) return false;
  if (value.importance !== undefined && !isNumber(value.importance)) return false;
  if (value.sourceRange !== undefined && !isResolvedSourceRange(value.sourceRange)) {
    return false;
  }
  return isNulldownSourceHash(value.sourceHash);
};

const isResolvedPluginRef = (value: unknown): value is ResolvedPluginRef => {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isString(value.pluginId)) return false;
  if (value.dropId !== undefined && !isString(value.dropId)) return false;
  if (value.sourceRange !== undefined && !isResolvedSourceRange(value.sourceRange)) {
    return false;
  }
  return isNulldownSourceHash(value.sourceHash);
};

const isResolvedPolicyFact = (value: unknown): value is ResolvedPolicyFact => {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isString(value.kind) || !isString(value.text)) {
    return false;
  }
  if (value.sourceRange !== undefined && !isResolvedSourceRange(value.sourceRange)) {
    return false;
  }
  if (!isNulldownSourceHash(value.sourceHash)) return false;
  if (value.importance !== undefined && !isNumber(value.importance)) return false;
  return true;
};

const isNullplugUiSourceShape = (value: unknown): value is NullplugUiSource => {
  if (!isRecord(value)) return false;
  if (!isString(value.rootDropId)) return false;
  if (value.branchId !== undefined && !isString(value.branchId)) return false;
  if (value.snapshotId !== undefined && !isNonNegativeInteger(value.snapshotId)) {
    return false;
  }
  if (value.eventId !== undefined && !isString(value.eventId)) return false;
  if (value.callId !== undefined && !isString(value.callId)) return false;
  return true;
};

const isResolvedUiResponseRef = (
  value: unknown,
): value is ResolvedUiResponseRef => {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isString(value.primitiveId)) return false;
  if (!isNullplugUiSourceShape(value.source)) return false;
  if (!isNonNegativeInteger(value.createdAt)) return false;
  if (
    value.proposedDiffEventCount !== undefined &&
    !isNonNegativeInteger(value.proposedDiffEventCount)
  ) {
    return false;
  }
  return isNulldownSourceHash(value.responseHash);
};

const isResolvedRuntimeNodeKind = (
  value: unknown,
): value is ResolvedRuntimeNodeKind =>
  value === "nullplug.ref" ||
  value === "ui.primitive" ||
  value === "ui.state" ||
  value === "ui.response";

const isResolvedRuntimeNode = (value: unknown): value is ResolvedRuntimeNode => {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isResolvedRuntimeNodeKind(value.kind)) return false;
  if (!isString(value.text)) return false;
  if (!isNulldownSourceHash(value.sourceHash)) return false;
  if (value.sourceRange !== undefined && !isResolvedSourceRange(value.sourceRange)) {
    return false;
  }
  if (value.source !== undefined && !isNullplugUiSourceShape(value.source)) return false;
  if (value.pluginId !== undefined && !isString(value.pluginId)) return false;
  if (value.dropId !== undefined && !isString(value.dropId)) return false;
  if (value.callId !== undefined && !isString(value.callId)) return false;
  if (value.primitiveId !== undefined && !isString(value.primitiveId)) return false;
  if (value.createdAt !== undefined && !isNonNegativeInteger(value.createdAt)) {
    return false;
  }
  if (value.importance !== undefined && !isNumber(value.importance)) return false;
  return true;
};

const isResolvedDocumentNodeKind = (
  value: unknown,
): value is ResolvedDocumentNodeKind =>
  value === "document.title" ||
  value === "section" ||
  value === "heading" ||
  value === "paragraph" ||
  value === "list.item" ||
  value === "checklist.item" ||
  value === "code.block" ||
  value === "nullplug.ref" ||
  value === "link.ref" ||
  value === "diff.region";

const isResolvedDocumentNode = (value: unknown): value is ResolvedDocumentNode => {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isResolvedDocumentNodeKind(value.kind)) return false;
  if (!isString(value.text)) return false;
  if (!isResolvedSourceRange(value.sourceRange)) return false;
  if (!isNulldownSourceHash(value.sourceHash)) return false;
  if (value.headingPath !== undefined && !isStringArray(value.headingPath)) return false;
  if (value.sectionId !== undefined && !isString(value.sectionId)) return false;
  if (value.parentId !== undefined && !isString(value.parentId)) return false;
  if (value.depth !== undefined && !isNumber(value.depth)) return false;
  if (value.pluginId !== undefined && !isString(value.pluginId)) return false;
  if (value.dropId !== undefined && !isString(value.dropId)) return false;
  if (value.href !== undefined && !isString(value.href)) return false;
  if (value.language !== undefined && !isString(value.language)) return false;
  if (value.checked !== undefined && typeof value.checked !== "boolean") return false;
  if (value.importance !== undefined && !isNumber(value.importance)) return false;
  return true;
};

/** Returns true when a value is a valid semantic heap reference. */
export const isResolvedHeapRef = (value: unknown): value is ResolvedHeapRef => {
  if (!isRecord(value)) return false;
  if (!isString(value.rootDropId) || !isString(value.branchId)) return false;
  if (!isNonNegativeInteger(value.snapshotId)) return false;
  return isString(value.resolverId);
};

/** Returns true when a value is a valid compact semantic node reference record. */
export const isResolvedNodeRefRecord = (
  value: unknown,
): value is ResolvedNodeRefRecord => {
  if (!isRecord(value)) return false;
  if (value.version !== RESOLVED_NODE_REF_RECORD_VERSION) return false;
  if (!isString(value.nodeId)) return false;
  if (
    !isResolvedDocumentNodeKind(value.kind) &&
    !isResolvedRuntimeNodeKind(value.kind)
  ) {
    return false;
  }
  if (!isNulldownSourceHash(value.nodeHash)) return false;
  if (!isNulldownSourceHash(value.sourceHash)) return false;
  if (value.sourceRange !== undefined && !isResolvedSourceRange(value.sourceRange)) {
    return false;
  }
  if (value.parentId !== undefined && !isString(value.parentId)) return false;
  if (value.text !== undefined && !isString(value.text)) return false;
  if (value.importance !== undefined && !isNumber(value.importance)) return false;
  return true;
};

/** Returns true when a value is a valid compact semantic node delta operation. */
export const isResolvedNodeDeltaOp = (
  value: unknown,
): value is ResolvedNodeDeltaOp => {
  if (!isRecord(value)) return false;
  if (value.op === "upsert") {
    return isResolvedNodeRefRecord(value.ref);
  }
  if (value.op === "delete") {
    if (!isString(value.nodeId)) return false;
    return (
      value.previousNodeHash === undefined ||
      isNulldownSourceHash(value.previousNodeHash)
    );
  }
  return false;
};

const isResolvedDiffEventRef = (value: unknown): value is ResolvedDiffEventRef => {
  if (!isRecord(value)) return false;
  if (!isNonNegativeInteger(value.seq) || !isString(value.eventId)) return false;
  if (value.sourceClientId !== undefined && !isString(value.sourceClientId)) return false;
  if (value.createdAt !== undefined && !isNumber(value.createdAt)) return false;
  if (
    value.metadata !== undefined &&
    !isDropDiffEventMetadata(value.metadata)
  ) {
    return false;
  }
  return (
    Array.isArray(value.changedRanges) &&
    value.changedRanges.every(isResolvedSourceRange)
  );
};

/** Returns true when a value is a valid semantic heap delta record. */
export const isResolvedHeapDeltaRecord = (
  value: unknown,
): value is ResolvedHeapDeltaRecord => {
  if (!isResolvedHeapRef(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  if (record.version !== RESOLVED_HEAP_DELTA_RECORD_VERSION) return false;
  if (!isString(record.resolverVersion)) return false;
  if (record.parent !== undefined && !isResolvedHeapRef(record.parent)) return false;
  if (!isNulldownSourceHash(record.sourceContentHash)) return false;
  if (
    record.sourceSeqRange !== undefined &&
    !isResolvedSourceSeqRange(record.sourceSeqRange)
  ) {
    return false;
  }
  if (!isNumber(record.resolvedAt) || typeof record.checkpointed !== "boolean") {
    return false;
  }
  const hasNodeRefs = Array.isArray(record.nodeRefs);
  const hasNodeOps = Array.isArray(record.nodeOps);
  if (record.checkpointed && !hasNodeRefs) return false;
  if (!record.checkpointed && !hasNodeOps) return false;
  if (
    hasNodeRefs &&
    !(record.nodeRefs as unknown[]).every(isResolvedNodeRefRecord)
  ) {
    return false;
  }
  if (hasNodeOps && !(record.nodeOps as unknown[]).every(isResolvedNodeDeltaOp)) {
    return false;
  }
  if (record.diffRefs !== undefined) {
    if (!Array.isArray(record.diffRefs) || !record.diffRefs.every(isResolvedDiffEventRef)) {
      return false;
    }
  }
  if (record.priorityFactIds !== undefined && !isStringArray(record.priorityFactIds)) {
    return false;
  }
  if (record.title !== undefined && !isString(record.title)) return false;
  if (record.summary !== undefined && !isString(record.summary)) return false;
  return true;
};

const isResolvedPriorityTargetKind = (
  value: unknown,
): value is ResolvedPriorityFactRecord["targetKind"] =>
  value === "diff" || value === "node" || value === "heap";

/** Returns true when a value is a valid agent priority overlay fact record. */
export const isResolvedPriorityFactRecord = (
  value: unknown,
): value is ResolvedPriorityFactRecord => {
  if (!isRecord(value)) return false;
  if (value.version !== RESOLVED_PRIORITY_FACT_RECORD_VERSION) return false;
  if (!isString(value.factId) || !isString(value.rootDropId)) return false;
  if (value.branchId !== undefined && !isString(value.branchId)) return false;
  if (value.resolverId !== undefined && !isString(value.resolverId)) return false;
  if (!isResolvedPriorityTargetKind(value.targetKind)) return false;
  if (!isString(value.targetId) || !isNumber(value.priority)) return false;
  if (!isNonNegativeInteger(value.createdAt)) return false;
  if (value.sourceSeq !== undefined && !isNonNegativeInteger(value.sourceSeq)) {
    return false;
  }
  if (value.sourceEventId !== undefined && !isString(value.sourceEventId)) return false;
  if (value.reason !== undefined && !isString(value.reason)) return false;
  if (value.labels !== undefined && !isStringArray(value.labels)) return false;
  if (value.metadata !== undefined && !isJsonRecord(value.metadata)) return false;
  return true;
};

const isImportanceRecord = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every(isNumber);

export const isResolvedNulldownState = (
  value: unknown,
): value is ResolvedNulldownState => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isString(value.id) || !isString(value.rootDropId)) return false;
  if (value.branchId !== undefined && !isString(value.branchId)) return false;
  if (value.snapshotId !== undefined && !isNonNegativeInteger(value.snapshotId)) {
    return false;
  }
  if (value.sourceRevision !== undefined && !isString(value.sourceRevision)) {
    return false;
  }
  if (
    value.sourceSeqRange !== undefined &&
    !isResolvedSourceSeqRange(value.sourceSeqRange)
  ) {
    return false;
  }
  if (!isNulldownSourceHash(value.sourceContentHash)) return false;
  if (!isString(value.resolverId) || !isString(value.resolverVersion)) return false;
  if (!isNumber(value.resolvedAt)) return false;
  if (value.title !== undefined && !isString(value.title)) return false;
  if (value.summary !== undefined && !isString(value.summary)) return false;
  if (
    value.checklistItems !== undefined &&
    (!Array.isArray(value.checklistItems) ||
      !value.checklistItems.every(isResolvedChecklistItem))
  ) {
    return false;
  }
  if (
    value.pluginRefs !== undefined &&
    (!Array.isArray(value.pluginRefs) ||
      !value.pluginRefs.every(isResolvedPluginRef))
  ) {
    return false;
  }
  if (
    value.policyFacts !== undefined &&
    (!Array.isArray(value.policyFacts) ||
      !value.policyFacts.every(isResolvedPolicyFact))
  ) {
    return false;
  }
  if (
    value.responseRefs !== undefined &&
    (!Array.isArray(value.responseRefs) ||
      !value.responseRefs.every(isResolvedUiResponseRef))
  ) {
    return false;
  }
  if (
    value.documentNodes !== undefined &&
    (!Array.isArray(value.documentNodes) ||
      !value.documentNodes.every(isResolvedDocumentNode))
  ) {
    return false;
  }
  if (
    value.runtimeNodes !== undefined &&
    (!Array.isArray(value.runtimeNodes) ||
      !value.runtimeNodes.every(isResolvedRuntimeNode))
  ) {
    return false;
  }
  if (value.importance !== undefined && !isImportanceRecord(value.importance)) {
    return false;
  }
  return true;
};
