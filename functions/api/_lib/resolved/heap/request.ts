import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../../../../../shared/drop/resolved/constants";
import type {
  ResolvedDocumentNodeKind,
  ResolvedPriorityFactRecord,
  ResolvedRuntimeNodeKind,
} from "../../../../../shared/drop/resolved/types";
import {
  isNullplugUiPrimitive,
  isNullplugUiResponseFact,
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
} from "../../../../../shared/nullplug/ui";
import type {
  ResolvedPriorityFactRequest,
  ResolvedUpdateRequest,
} from "./types";

const DOCUMENT_NODE_KINDS = new Set<ResolvedDocumentNodeKind>([
  "document.title",
  "section",
  "heading",
  "paragraph",
  "list.item",
  "checklist.item",
  "code.block",
  "nullplug.ref",
  "link.ref",
  "diff.region",
]);

const RUNTIME_NODE_KINDS = new Set<ResolvedRuntimeNodeKind>([
  "nullplug.ref",
  "ui.primitive",
  "ui.state",
  "ui.response",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  isNumber(value) && Number.isInteger(value) && value >= 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isJsonValue = (value: unknown, depth = 0): boolean => {
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

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry));

/** Parses a positive integer query param with a fallback. */
export const parsePositiveInteger = (
  value: string | null,
  fallback: number,
): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Parses an optional non-negative event sequence query param. */
export const parseOptionalSeq = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/** Parses boolean-like query params accepted by resolved heap routes. */
export const parseBoolean = (value: string | null): boolean =>
  value === "1" || value === "true" || value === "yes";

/** Parses document node kind filters from a comma-delimited query param. */
export const parseDocumentKinds = (
  value: string | null,
): ResolvedDocumentNodeKind[] | undefined => {
  if (!value) return undefined;
  const kinds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ResolvedDocumentNodeKind =>
      DOCUMENT_NODE_KINDS.has(entry as ResolvedDocumentNodeKind),
    );
  return kinds.length ? kinds : undefined;
};

/** Parses runtime node kind filters from a comma-delimited query param. */
export const parseRuntimeKinds = (
  value: string | null,
): ResolvedRuntimeNodeKind[] | undefined => {
  if (!value) return undefined;
  const kinds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ResolvedRuntimeNodeKind =>
      RUNTIME_NODE_KINDS.has(entry as ResolvedRuntimeNodeKind),
    );
  return kinds.length ? kinds : undefined;
};

/** Parses and validates a resolved heap rebuild request body. */
export const parseResolvedUpdateBody = (
  rawBody: string,
): ResolvedUpdateRequest | null => {
  if (!rawBody.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const resolverId = parsed.resolverId;
  if (
    resolverId !== undefined &&
    resolverId !== "all" &&
    resolverId !== RESOLVED_DOCUMENT_RESOLVER_ID &&
    resolverId !== RESOLVED_RUNTIME_REFS_RESOLVER_ID
  ) {
    return null;
  }
  if (
    parsed.snapshotId !== undefined &&
    parsed.snapshotId !== "latest" &&
    !(typeof parsed.snapshotId === "number" &&
      Number.isInteger(parsed.snapshotId) &&
      parsed.snapshotId >= 0)
  ) {
    return null;
  }
  if (
    parsed.uiPrimitives !== undefined &&
    (!Array.isArray(parsed.uiPrimitives) ||
      !parsed.uiPrimitives.every(isNullplugUiPrimitive))
  ) {
    return null;
  }
  if (
    parsed.uiResponseFacts !== undefined &&
    (!Array.isArray(parsed.uiResponseFacts) ||
      !parsed.uiResponseFacts.every(isNullplugUiResponseFact))
  ) {
    return null;
  }
  if (
    parsed.uiStatePatchFacts !== undefined &&
    (!Array.isArray(parsed.uiStatePatchFacts) ||
      !parsed.uiStatePatchFacts.every(isNullplugUiStatePatchFact))
  ) {
    return null;
  }
  if (
    parsed.uiStateSnapshots !== undefined &&
    (!Array.isArray(parsed.uiStateSnapshots) ||
      !parsed.uiStateSnapshots.every(isNullplugUiStateSnapshot))
  ) {
    return null;
  }

  return parsed as ResolvedUpdateRequest;
};

/** Checks whether an unknown value is a resolved priority target kind. */
export const isPriorityTargetKind = (
  value: unknown,
): value is ResolvedPriorityFactRecord["targetKind"] =>
  value === "diff" || value === "node" || value === "heap";

/** Parses and validates a resolved priority fact create request body. */
export const parseResolvedPriorityFactBody = (
  rawBody: string,
): ResolvedPriorityFactRequest | null => {
  if (!rawBody.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed.factId !== undefined && !isString(parsed.factId)) return null;
  if (parsed.resolverId !== undefined && !isString(parsed.resolverId)) {
    return null;
  }
  if (!isPriorityTargetKind(parsed.targetKind)) return null;
  if (parsed.targetId !== undefined && !isString(parsed.targetId)) return null;
  if (!isNumber(parsed.priority)) return null;
  if (
    parsed.sourceSeq !== undefined &&
    !isNonNegativeInteger(parsed.sourceSeq)
  ) {
    return null;
  }
  if (parsed.sourceEventId !== undefined && !isString(parsed.sourceEventId)) {
    return null;
  }
  if (parsed.reason !== undefined && !isString(parsed.reason)) return null;
  if (parsed.labels !== undefined && !isStringArray(parsed.labels)) return null;
  if (parsed.metadata !== undefined && !isJsonRecord(parsed.metadata)) {
    return null;
  }

  return parsed as ResolvedPriorityFactRequest;
};

/** Builds the default heap priority target id for heap-scoped priority facts. */
export const defaultPriorityTargetId = (
  rootDropId: string,
  branchId: string,
  resolverId: string | undefined,
  targetKind: ResolvedPriorityFactRecord["targetKind"],
): string =>
  targetKind === "heap" ? `${rootDropId}/${branchId}/${resolverId ?? ""}` : "";

/** Decodes a route parameter while preserving undecodable values. */
export const decodeRouteParam = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
