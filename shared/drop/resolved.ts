import { serializeCanonicalJson } from "./types";
import { dropResolvedHeapKey } from "./sidecar";
import {
  dropDiffOpToDiff,
  type DropDiffEvent,
  type DropDiffEventMetadata,
} from "./diff";
import { decodeText } from "../nulledit/textDiff";
import { DiffOp } from "../nulledit/types";
import type {
  NullplugUiPrimitive,
  NullplugUiResponseFact,
  NullplugUiSource,
  NullplugUiStatePatchFact,
  NullplugUiStateSnapshot,
} from "../nullplug/ui";

export const NULLDOWN_CONTEXT_TOKEN_PREFIX = "ndctx.v1.";
export const NULLDOWN_SOURCE_HASH_PREFIX = "sha256:";
export const RESOLVED_CHECKLIST_RESOLVER_ID = "nulldown.resolved.checklist";
export const RESOLVED_CHECKLIST_RESOLVER_VERSION = "1";
export const RESOLVED_DOCUMENT_RESOLVER_ID = "nulldown.resolved.document";
export const RESOLVED_DOCUMENT_RESOLVER_VERSION = "1";
export const RESOLVED_RUNTIME_REFS_RESOLVER_ID = "nulldown.resolved.runtime-refs";
export const RESOLVED_RUNTIME_REFS_RESOLVER_VERSION = "1";

export type NulldownSourceHash = `${typeof NULLDOWN_SOURCE_HASH_PREFIX}${string}`;

export type NulldownContextQueryKind =
  | "checklist.next"
  | "plan.status"
  | "dependency.edges"
  | "policy.pending";

export interface NulldownContextQueryHint {
  dropId: string;
  kind: NulldownContextQueryKind;
}

export interface NulldownContextToken {
  version: 1;
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  checklistDropId?: string;
  resolvedHeapIds: string[];
  sourceHashes: Record<string, NulldownSourceHash>;
  queryHints: NulldownContextQueryHint[];
}

export interface ResolvedSourceRange {
  start: number;
  end: number;
}

export interface ResolvedSourceSeqRange {
  from: number;
  to: number;
}

export interface ResolvedChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  phase?: string;
  importance?: number;
  sourceRange?: ResolvedSourceRange;
  sourceHash: NulldownSourceHash;
}

export interface ResolvedPluginRef {
  id: string;
  pluginId: string;
  dropId?: string;
  sourceRange?: ResolvedSourceRange;
  sourceHash: NulldownSourceHash;
}

export interface ResolvedPolicyFact {
  id: string;
  kind: string;
  text: string;
  sourceRange?: ResolvedSourceRange;
  sourceHash: NulldownSourceHash;
  importance?: number;
}

export interface ResolvedUiResponseRef {
  id: string;
  primitiveId: string;
  source: NullplugUiSource;
  createdAt: number;
  proposedDiffEventCount?: number;
  responseHash: NulldownSourceHash;
}

export type ResolvedRuntimeNodeKind =
  | "nullplug.ref"
  | "ui.primitive"
  | "ui.state"
  | "ui.response";

export interface ResolvedRuntimeNode {
  id: string;
  kind: ResolvedRuntimeNodeKind;
  text: string;
  sourceHash: NulldownSourceHash;
  sourceRange?: ResolvedSourceRange;
  source?: NullplugUiSource;
  pluginId?: string;
  dropId?: string;
  callId?: string;
  primitiveId?: string;
  createdAt?: number;
  importance?: number;
}

export type ResolvedDocumentNodeKind =
  | "document.title"
  | "section"
  | "heading"
  | "paragraph"
  | "list.item"
  | "checklist.item"
  | "code.block"
  | "nullplug.ref"
  | "link.ref"
  | "diff.region";

export interface ResolvedDocumentNode {
  id: string;
  kind: ResolvedDocumentNodeKind;
  text: string;
  sourceRange: ResolvedSourceRange;
  sourceHash: NulldownSourceHash;
  headingPath?: string[];
  sectionId?: string;
  parentId?: string;
  depth?: number;
  pluginId?: string;
  dropId?: string;
  href?: string;
  language?: string;
  checked?: boolean;
  importance?: number;
}

export interface ResolvedDiffEventRef {
  seq: number;
  eventId: string;
  sourceClientId?: string;
  createdAt?: number;
  metadata?: DropDiffEventMetadata;
  changedRanges: ResolvedSourceRange[];
}

export interface ResolvedDocumentQuery {
  q?: string;
  kinds?: ResolvedDocumentNodeKind[];
  limit?: number;
  changedRanges?: ResolvedSourceRange[];
  events?: ResolvedDiffEventRef[];
  changedOnly?: boolean;
  includeAncestors?: boolean;
}

export interface ResolvedDocumentNodeQueryResult {
  node: ResolvedDocumentNode;
  score: number;
  reasons: string[];
  eventRefs?: ResolvedDiffEventRef[];
}

export interface ResolvedRuntimeQuery {
  q?: string;
  kinds?: ResolvedRuntimeNodeKind[];
  limit?: number;
  pluginId?: string;
  callId?: string;
  primitiveId?: string;
}

export interface ResolvedRuntimeNodeQueryResult {
  node: ResolvedRuntimeNode;
  score: number;
  reasons: string[];
}

export interface ResolvedNulldownState {
  version: 1;
  id: string;
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  sourceRevision?: string;
  sourceSeqRange?: ResolvedSourceSeqRange;
  sourceContentHash: NulldownSourceHash;
  resolverId: string;
  resolverVersion: string;
  resolvedAt: number;
  title?: string;
  summary?: string;
  checklistItems?: ResolvedChecklistItem[];
  pluginRefs?: ResolvedPluginRef[];
  policyFacts?: ResolvedPolicyFact[];
  responseRefs?: ResolvedUiResponseRef[];
  documentNodes?: ResolvedDocumentNode[];
  runtimeNodes?: ResolvedRuntimeNode[];
  importance?: Record<string, number>;
}

export interface BranchSnapshotSource {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  content: string;
}

export interface ResolvedChecklistSource {
  id?: string;
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  sourceRevision?: string;
  sourceSeqRange?: ResolvedSourceSeqRange;
  content: string;
  resolverId?: string;
  resolverVersion?: string;
  resolvedAt?: number;
}

export interface ResolvedRuntimeRefsSource extends ResolvedChecklistSource {
  uiPrimitives?: NullplugUiPrimitive[];
  uiResponseFacts?: NullplugUiResponseFact[];
  uiStatePatchFacts?: NullplugUiStatePatchFact[];
  uiStateSnapshots?: NullplugUiStateSnapshot[];
}

export type ResolvedDocumentSource = ResolvedChecklistSource;

export interface ResolvedHeapJsonObject {
  json(): Promise<unknown>;
}

export interface ResolvedHeapJsonStore {
  get(key: string): Promise<ResolvedHeapJsonObject | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

const sourceHashPattern = /^sha256:[A-Za-z0-9_-]{43}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  isNumber(value) && Number.isInteger(value) && value >= 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

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

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    return null;
  }

  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export const isNulldownSourceHash = (
  value: unknown,
): value is NulldownSourceHash => isString(value) && sourceHashPattern.test(value);

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

export const encodeNulldownContextToken = (
  token: NulldownContextToken,
): string => {
  if (!isNulldownContextToken(token)) {
    throw new Error("Invalid Nulldown context token.");
  }

  const encoded = new TextEncoder().encode(serializeCanonicalJson(token));
  return `${NULLDOWN_CONTEXT_TOKEN_PREFIX}${toBase64Url(encoded)}`;
};

export const decodeNulldownContextToken = (
  value: string,
): NulldownContextToken | null => {
  if (!value.startsWith(NULLDOWN_CONTEXT_TOKEN_PREFIX)) return null;

  const payload = value.slice(NULLDOWN_CONTEXT_TOKEN_PREFIX.length);
  const bytes = fromBase64Url(payload);
  if (!bytes) return null;

  try {
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return isNulldownContextToken(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

export const buildMarkdownSourceHashKey = (dropId: string): string =>
  `drop:${dropId}:content`;

export const buildBranchSnapshotSourceHashKey = ({
  rootDropId,
  branchId,
  snapshotId,
}: Omit<BranchSnapshotSource, "content">): string =>
  `branch:${rootDropId}:${branchId}:snapshot:${snapshotId}:content`;

export const hashNulldownSourceContent = async (
  content: string,
): Promise<NulldownSourceHash> => {
  const bytes = new TextEncoder().encode(`nulldown.source-content.v1\n${content}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `${NULLDOWN_SOURCE_HASH_PREFIX}${toBase64Url(new Uint8Array(digest))}`;
};

export const hashMarkdownSource = (content: string): Promise<NulldownSourceHash> =>
  hashNulldownSourceContent(content);

export const hashBranchSnapshotSource = ({
  content,
}: BranchSnapshotSource): Promise<NulldownSourceHash> =>
  hashNulldownSourceContent(content);

const headingPattern = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const checklistPattern = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])]\s+(.*)$/;
const fenceOpenPattern = /^\s{0,3}(`{3,}|~{3,})([^`~]*)$/;

const parsePluginInfo = (info: string): { id: string; args: string | null } | null => {
  const trimmed = info.trim();
  if (!trimmed) return null;
  const match = /^([A-Za-z][\w.-]*)(?:\((.*)\))?$/.exec(trimmed);
  if (!match) return null;
  return { id: match[1].toLowerCase(), args: match[2]?.trim() || null };
};

const firstBodyLine = (value: string): string | null =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;

const extractArgValue = (args: string | null, name: string): string | null => {
  if (!args) return null;
  const pattern = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^,\\s)]+))`);
  const match = pattern.exec(args);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
};

const stripMarkdownHeadingText = (value: string): string =>
  value.replace(/\s+#*\s*$/, "").trim();

const buildResolvedChecklistId = ({
  rootDropId,
  branchId,
  snapshotId,
  sourceRevision,
  sourceHash,
  resolverId,
  resolverVersion,
}: {
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  sourceRevision?: string;
  sourceHash: NulldownSourceHash;
  resolverId: string;
  resolverVersion: string;
}): string =>
  [
    "resolved",
    rootDropId,
    branchId ?? "drop",
    snapshotId ?? sourceRevision ?? sourceHash.slice(NULLDOWN_SOURCE_HASH_PREFIX.length, 19),
    resolverId,
    resolverVersion,
  ].join(":");

const forEachMarkdownLine = (
  content: string,
  callback: (line: string, start: number, end: number) => void,
): void => {
  let lineStart = 0;

  while (lineStart <= content.length) {
    let lineEnd = lineStart;
    while (
      lineEnd < content.length &&
      content[lineEnd] !== "\n" &&
      content[lineEnd] !== "\r"
    ) {
      lineEnd += 1;
    }

    callback(content.slice(lineStart, lineEnd), lineStart, lineEnd);

    if (lineEnd >= content.length) break;

    lineStart =
      content[lineEnd] === "\r" && content[lineEnd + 1] === "\n"
        ? lineEnd + 2
        : lineEnd + 1;
  }
};

interface MarkdownLineSpan {
  line: string;
  start: number;
  end: number;
  nextStart: number;
}

interface HeadingSpan {
  id: string;
  text: string;
  depth: number;
  start: number;
  end: number;
  path: string[];
}

const collectMarkdownLines = (content: string): MarkdownLineSpan[] => {
  const lines: MarkdownLineSpan[] = [];
  let lineStart = 0;

  while (lineStart <= content.length) {
    let lineEnd = lineStart;
    while (
      lineEnd < content.length &&
      content[lineEnd] !== "\n" &&
      content[lineEnd] !== "\r"
    ) {
      lineEnd += 1;
    }

    const nextStart =
      lineEnd < content.length
        ? content[lineEnd] === "\r" && content[lineEnd + 1] === "\n"
          ? lineEnd + 2
          : lineEnd + 1
        : lineEnd;

    lines.push({
      line: content.slice(lineStart, lineEnd),
      start: lineStart,
      end: lineEnd,
      nextStart,
    });

    if (lineEnd >= content.length) break;
    lineStart = nextStart;
  }

  return lines;
};

const documentNodeId = (
  kind: ResolvedDocumentNodeKind,
  sourceHash: NulldownSourceHash,
  start: number,
  end: number,
  suffix?: string,
): string =>
  [
    kind,
    sourceHash.slice(NULLDOWN_SOURCE_HASH_PREFIX.length, 19),
    start,
    end,
    suffix,
  ]
    .filter((entry) => entry !== undefined && entry !== "")
    .join(":");

const importanceForNodeKind = (
  kind: ResolvedDocumentNodeKind,
  depth?: number,
  checked?: boolean,
): number => {
  if (kind === "document.title") return 5;
  if (kind === "heading") return Math.max(1.5, 4 - (depth ?? 1) * 0.35);
  if (kind === "section") return Math.max(1, 3 - (depth ?? 1) * 0.25);
  if (kind === "checklist.item") return checked ? 0.6 : 2.5;
  if (kind === "nullplug.ref") return 2.2;
  if (kind === "link.ref") return 1.4;
  if (kind === "list.item") return 1.2;
  if (kind === "paragraph") return 1;
  return 0.8;
};

const linkPattern = /\[([^\]]+)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const listItemPattern = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const knownNullplugFenceIds = new Set(["nd", "embed", "form", "action", "card"]);

const isLikelyNullplugInvocation = (invocation: {
  id: string;
  args: string | null;
}): boolean => knownNullplugFenceIds.has(invocation.id) || invocation.args !== null;

const findContainingSectionId = (
  headings: readonly HeadingSpan[],
  start: number,
): string | undefined => {
  let sectionId: string | undefined;
  for (const heading of headings) {
    if (heading.start > start) break;
    sectionId = heading.id;
  }
  return sectionId;
};

const addLinkRefNodes = (
  nodes: ResolvedDocumentNode[],
  input: {
    line: string;
    lineStart: number;
    sourceHash: NulldownSourceHash;
    headingPath: string[];
    sectionId?: string;
  },
): void => {
  let match: RegExpExecArray | null;
  linkPattern.lastIndex = 0;
  while ((match = linkPattern.exec(input.line))) {
    const start = input.lineStart + match.index;
    const end = start + match[0].length;
    nodes.push({
      id: documentNodeId("link.ref", input.sourceHash, start, end, match[2]),
      kind: "link.ref",
      text: match[1].trim() || match[2],
      href: match[2],
      sourceRange: { start, end },
      sourceHash: input.sourceHash,
      headingPath: input.headingPath,
      sectionId: input.sectionId,
      importance: importanceForNodeKind("link.ref"),
    });
  }
};

export const heapifyResolvedDocument = async ({
  id,
  rootDropId,
  branchId,
  snapshotId,
  sourceRevision,
  sourceSeqRange,
  content,
  resolverId = RESOLVED_DOCUMENT_RESOLVER_ID,
  resolverVersion = RESOLVED_DOCUMENT_RESOLVER_VERSION,
  resolvedAt = Date.now(),
}: ResolvedDocumentSource): Promise<ResolvedNulldownState> => {
  const sourceContentHash = await hashMarkdownSource(content);
  const lines = collectMarkdownLines(content);
  const nodes: ResolvedDocumentNode[] = [];
  const headings: HeadingSpan[] = [];
  const headingStack: HeadingSpan[] = [];
  let title: string | undefined;
  let index = 0;

  const currentHeadingPath = (): string[] => headingStack.map((entry) => entry.text);
  const currentSectionId = (): string | undefined =>
    headingStack[headingStack.length - 1]?.id;

  while (index < lines.length) {
    const span = lines[index];
    const headingMatch = headingPattern.exec(span.line);
    if (headingMatch) {
      const depth = Math.min(6, Math.max(1, span.line.trimStart().match(/^#+/)?.[0].length ?? 1));
      const text = stripMarkdownHeadingText(headingMatch[1]);
      while (headingStack.length && headingStack[headingStack.length - 1].depth >= depth) {
        headingStack.pop();
      }
      const heading: HeadingSpan = {
        id: documentNodeId("heading", sourceContentHash, span.start, span.end),
        text,
        depth,
        start: span.start,
        end: span.end,
        path: [...headingStack.map((entry) => entry.text), text],
      };
      headingStack.push(heading);
      headings.push(heading);
      title ??= text;
      nodes.push({
        id: heading.id,
        kind: "heading",
        text,
        sourceRange: { start: span.start, end: span.end },
        sourceHash: sourceContentHash,
        headingPath: heading.path,
        parentId: headingStack[headingStack.length - 2]?.id,
        depth,
        importance: importanceForNodeKind("heading", depth),
      });
      if (!nodes.some((node) => node.kind === "document.title") && depth === 1) {
        nodes.push({
          id: documentNodeId("document.title", sourceContentHash, span.start, span.end),
          kind: "document.title",
          text,
          sourceRange: { start: span.start, end: span.end },
          sourceHash: sourceContentHash,
          headingPath: heading.path,
          parentId: heading.id,
          depth,
          importance: importanceForNodeKind("document.title"),
        });
      }
      index += 1;
      continue;
    }

    const fenceOpen = fenceOpenPattern.exec(span.line);
    if (fenceOpen) {
      const invocation = parsePluginInfo(fenceOpen[2]);
      const language = fenceOpen[2]?.trim().split(/\s+/)[0]?.toLowerCase() || undefined;
      const fenceChar = fenceOpen[1][0];
      const closePattern = new RegExp(`^\\s{0,3}${fenceChar}{${fenceOpen[1].length},}\\s*$`);
      let closeIndex = index;
      while (closeIndex + 1 < lines.length) {
        closeIndex += 1;
        if (closePattern.test(lines[closeIndex].line)) break;
      }
      const closeSpan = lines[closeIndex] ?? span;
      const end = closeSpan.end;
      const bodyStart = span.nextStart;
      const bodyEnd = closeIndex > index ? lines[closeIndex].start : span.end;
      const body = content.slice(bodyStart, bodyEnd);
      const headingPath = currentHeadingPath();
      const sectionId = currentSectionId();
      nodes.push({
        id: documentNodeId("code.block", sourceContentHash, span.start, end),
        kind: "code.block",
        text: body.trim().slice(0, 800),
        language,
        sourceRange: { start: span.start, end },
        sourceHash: sourceContentHash,
        headingPath,
        sectionId,
        parentId: sectionId,
        importance: importanceForNodeKind("code.block"),
      });
      if (invocation && isLikelyNullplugInvocation(invocation)) {
        const dropId =
          invocation.id === "nd"
            ? extractArgValue(invocation.args, "id") ?? firstBodyLine(body) ?? undefined
            : undefined;
        nodes.push({
          id: documentNodeId("nullplug.ref", sourceContentHash, span.start, end, invocation.id),
          kind: "nullplug.ref",
          text: [invocation.id, dropId, firstBodyLine(body)].filter(Boolean).join(" "),
          pluginId: invocation.id,
          dropId,
          sourceRange: { start: span.start, end },
          sourceHash: sourceContentHash,
          headingPath,
          sectionId,
          parentId: sectionId,
          importance: importanceForNodeKind("nullplug.ref"),
        });
      }
      index = closeIndex + 1;
      continue;
    }

    const checklistMatch = checklistPattern.exec(span.line);
    const listMatch = checklistMatch ? null : listItemPattern.exec(span.line);
    if (checklistMatch || listMatch) {
      const checked = checklistMatch
        ? checklistMatch[1].toLowerCase() === "x"
        : undefined;
      const text = (checklistMatch?.[2] ?? listMatch?.[1] ?? "").trim();
      const kind: ResolvedDocumentNodeKind = checklistMatch ? "checklist.item" : "list.item";
      const headingPath = currentHeadingPath();
      const sectionId = currentSectionId();
      nodes.push({
        id: documentNodeId(kind, sourceContentHash, span.start, span.end),
        kind,
        text,
        checked,
        sourceRange: { start: span.start, end: span.end },
        sourceHash: sourceContentHash,
        headingPath,
        sectionId,
        parentId: sectionId,
        importance: importanceForNodeKind(kind, undefined, checked),
      });
      addLinkRefNodes(nodes, {
        line: span.line,
        lineStart: span.start,
        sourceHash: sourceContentHash,
        headingPath,
        sectionId,
      });
      index += 1;
      continue;
    }

    if (!span.line.trim()) {
      index += 1;
      continue;
    }

    const paragraphStart = span.start;
    let paragraphEnd = span.end;
    const paragraphLines: MarkdownLineSpan[] = [];
    while (index < lines.length) {
      const candidate = lines[index];
      if (!candidate.line.trim()) break;
      if (headingPattern.test(candidate.line) || fenceOpenPattern.test(candidate.line)) break;
      if (checklistPattern.test(candidate.line) || listItemPattern.test(candidate.line)) break;
      paragraphLines.push(candidate);
      paragraphEnd = candidate.end;
      index += 1;
    }
    const text = content.slice(paragraphStart, paragraphEnd).trim();
    if (text) {
      const headingPath = currentHeadingPath();
      const sectionId = currentSectionId();
      nodes.push({
        id: documentNodeId("paragraph", sourceContentHash, paragraphStart, paragraphEnd),
        kind: "paragraph",
        text,
        sourceRange: { start: paragraphStart, end: paragraphEnd },
        sourceHash: sourceContentHash,
        headingPath,
        sectionId,
        parentId: sectionId,
        importance: importanceForNodeKind("paragraph"),
      });
      paragraphLines.forEach((paragraphLine) =>
        addLinkRefNodes(nodes, {
          line: paragraphLine.line,
          lineStart: paragraphLine.start,
          sourceHash: sourceContentHash,
          headingPath,
          sectionId,
        }),
      );
    }
  }

  headings.forEach((heading, headingIndex) => {
    let end = content.length;
    for (let nextIndex = headingIndex + 1; nextIndex < headings.length; nextIndex += 1) {
      if (headings[nextIndex].depth <= heading.depth) {
        end = headings[nextIndex].start;
        break;
      }
    }
    nodes.push({
      id: documentNodeId("section", sourceContentHash, heading.start, end),
      kind: "section",
      text: content.slice(heading.start, end).trim().slice(0, 1600),
      sourceRange: { start: heading.start, end },
      sourceHash: sourceContentHash,
      headingPath: heading.path,
      parentId: headings
        .slice(0, headingIndex)
        .reverse()
        .find((candidate) => candidate.depth < heading.depth)?.id,
      depth: heading.depth,
      importance: importanceForNodeKind("section", heading.depth),
    });
  });

  return {
    version: 1,
    id:
      id ??
      buildResolvedChecklistId({
        rootDropId,
        branchId,
        snapshotId,
        sourceRevision,
        sourceHash: sourceContentHash,
        resolverId,
        resolverVersion,
      }),
    rootDropId,
    branchId,
    snapshotId,
    sourceRevision,
    sourceSeqRange,
    sourceContentHash,
    resolverId,
    resolverVersion,
    resolvedAt,
    title,
    documentNodes: nodes,
  };
};

export const heapifyResolvedChecklist = async ({
  id,
  rootDropId,
  branchId,
  snapshotId,
  sourceRevision,
  sourceSeqRange,
  content,
  resolverId = RESOLVED_CHECKLIST_RESOLVER_ID,
  resolverVersion = RESOLVED_CHECKLIST_RESOLVER_VERSION,
  resolvedAt = Date.now(),
}: ResolvedChecklistSource): Promise<ResolvedNulldownState> => {
  const sourceContentHash = await hashMarkdownSource(content);
  const checklistItems: ResolvedChecklistItem[] = [];
  let title: string | undefined;
  let currentPhase: string | undefined;

  forEachMarkdownLine(content, (line, start, end) => {
    const headingMatch = headingPattern.exec(line);
    if (headingMatch) {
      currentPhase = stripMarkdownHeadingText(headingMatch[1]);
      title ??= currentPhase;
      return;
    }

    const checklistMatch = checklistPattern.exec(line);
    if (!checklistMatch) return;

    const checked = checklistMatch[1].toLowerCase() === "x";
    const text = checklistMatch[2].trim();
    const idSuffix = sourceContentHash.slice(NULLDOWN_SOURCE_HASH_PREFIX.length, 19);
    checklistItems.push({
      id: `checklist:${idSuffix}:${start}:${end}`,
      text,
      checked,
      phase: currentPhase,
      sourceRange: { start, end },
      sourceHash: sourceContentHash,
    });
  });

  return {
    version: 1,
    id:
      id ??
      buildResolvedChecklistId({
        rootDropId,
        branchId,
        snapshotId,
        sourceRevision,
        sourceHash: sourceContentHash,
        resolverId,
        resolverVersion,
      }),
    rootDropId,
    branchId,
    snapshotId,
    sourceRevision,
    sourceSeqRange,
    sourceContentHash,
    resolverId,
    resolverVersion,
    resolvedAt,
    title,
    checklistItems,
  };
};

const parsePluginRefs = async (
  content: string,
  sourceContentHash: NulldownSourceHash,
): Promise<ResolvedPluginRef[]> => {
  const refs: ResolvedPluginRef[] = [];
  let offset = 0;

  while (offset < content.length) {
    const lineEnd = content.indexOf("\n", offset);
    const openEnd = lineEnd === -1 ? content.length : lineEnd;
    const line = content.slice(offset, openEnd).replace(/\r$/, "");
    const open = fenceOpenPattern.exec(line);
    if (!open) {
      offset = lineEnd === -1 ? content.length : lineEnd + 1;
      continue;
    }

    const invocation = parsePluginInfo(open[2]);
    const fenceChar = open[1][0];
    const closePattern = new RegExp(`^\\s{0,3}${fenceChar}{${open[1].length},}\\s*$`);
    let bodyStart = lineEnd === -1 ? content.length : lineEnd + 1;
    let scan = bodyStart;
    let closeStart = content.length;
    let closeEnd = content.length;

    while (scan < content.length) {
      const nextEnd = content.indexOf("\n", scan);
      const candidateEnd = nextEnd === -1 ? content.length : nextEnd;
      const candidate = content.slice(scan, candidateEnd).replace(/\r$/, "");
      if (closePattern.test(candidate)) {
        closeStart = scan;
        closeEnd = candidateEnd;
        break;
      }
      scan = nextEnd === -1 ? content.length : nextEnd + 1;
    }

    if (invocation) {
      const body = content.slice(bodyStart, closeStart);
      refs.push({
        id: `plugin:${sourceContentHash.slice(NULLDOWN_SOURCE_HASH_PREFIX.length, 19)}:${offset}:${closeEnd}`,
        pluginId: invocation.id,
        dropId:
          invocation.id === "nd"
            ? extractArgValue(invocation.args, "id") ?? firstBodyLine(body) ?? undefined
            : undefined,
        sourceRange: { start: offset, end: closeEnd },
        sourceHash: sourceContentHash,
      });
    }

    offset = closeEnd >= content.length ? content.length : closeEnd + 1;
  }

  return refs;
};

const indexUiResponses = async (
  facts: readonly NullplugUiResponseFact[] = [],
): Promise<ResolvedUiResponseRef[]> =>
  Promise.all(
    facts.map(async (fact) => ({
      id: fact.id,
      primitiveId: fact.primitiveId,
      source: fact.source,
      createdAt: fact.createdAt,
      proposedDiffEventCount: fact.proposedDiffs?.events.length,
      responseHash: await hashNulldownSourceContent(serializeCanonicalJson(fact)),
    })),
  );

const runtimeImportanceForKind = (kind: ResolvedRuntimeNodeKind): number => {
  if (kind === "ui.state") return 3;
  if (kind === "ui.response") return 2.8;
  if (kind === "ui.primitive") return 2.4;
  return 2.2;
};

const hashSuffix = (hash: NulldownSourceHash): string =>
  hash.slice(NULLDOWN_SOURCE_HASH_PREFIX.length, 19);

const jsonSearchText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(jsonSearchText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, entry]) => [key, jsonSearchText(entry)])
      .filter(Boolean)
      .join(" ");
  }
  return "";
};

const primitiveSearchText = (primitive: NullplugUiPrimitive): string => {
  if (primitive.kind === "form") {
    return [
      primitive.id,
      primitive.title,
      primitive.description,
      primitive.submitLabel,
      ...primitive.fields.flatMap((field) => [
        field.name,
        field.label,
        field.type,
        jsonSearchText(field.defaultValue),
        ...(field.options ?? []).flatMap((option) => [
          option.label,
          jsonSearchText(option.value),
        ]),
      ]),
    ]
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .join(" ");
  }

  if (primitive.kind === "action") {
    return [primitive.id, primitive.label, primitive.intent, jsonSearchText(primitive.value)]
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .join(" ");
  }

  return [
    primitive.id,
    primitive.title,
    primitive.body,
    ...(primitive.actions ?? []).map((action) => primitiveSearchText(action)),
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join(" ");
};

const indexRuntimeNodes = async (input: {
  pluginRefs: readonly ResolvedPluginRef[];
  uiPrimitives?: readonly NullplugUiPrimitive[];
  uiResponseFacts?: readonly NullplugUiResponseFact[];
  uiStatePatchFacts?: readonly NullplugUiStatePatchFact[];
  uiStateSnapshots?: readonly NullplugUiStateSnapshot[];
}): Promise<ResolvedRuntimeNode[]> => {
  const pluginNodes: ResolvedRuntimeNode[] = input.pluginRefs.map((ref) => ({
    id: `runtime:${ref.id}`,
    kind: "nullplug.ref",
    text: [ref.pluginId, ref.dropId].filter(Boolean).join(" "),
    pluginId: ref.pluginId,
    dropId: ref.dropId,
    sourceRange: ref.sourceRange,
    sourceHash: ref.sourceHash,
    importance: runtimeImportanceForKind("nullplug.ref"),
  }));

  const primitiveNodes = await Promise.all(
    (input.uiPrimitives ?? []).map(async (primitive) => {
      const sourceHash = await hashNulldownSourceContent(serializeCanonicalJson(primitive));
      return {
        id: `ui.primitive:${hashSuffix(sourceHash)}:${primitive.id}`,
        kind: "ui.primitive" as const,
        text: primitiveSearchText(primitive),
        sourceHash,
        source: primitive.source,
        callId: primitive.source?.callId,
        primitiveId: primitive.id,
        importance: runtimeImportanceForKind("ui.primitive"),
      } satisfies ResolvedRuntimeNode;
    }),
  );

  const responseNodes = await Promise.all(
    (input.uiResponseFacts ?? []).map(async (fact) => {
      const sourceHash = await hashNulldownSourceContent(serializeCanonicalJson(fact));
      return {
        id: `ui.response:${hashSuffix(sourceHash)}:${fact.id}`,
        kind: "ui.response" as const,
        text: [fact.primitiveId, jsonSearchText(fact.data)].filter(Boolean).join(" "),
        sourceHash,
        source: fact.source,
        callId: fact.source.callId,
        primitiveId: fact.primitiveId,
        createdAt: fact.createdAt,
        importance: runtimeImportanceForKind("ui.response"),
      } satisfies ResolvedRuntimeNode;
    }),
  );

  const patchNodes = await Promise.all(
    (input.uiStatePatchFacts ?? []).map(async (fact) => {
      const sourceHash = await hashNulldownSourceContent(serializeCanonicalJson(fact));
      const patchText = fact.patch
        .map((operation) => [operation.op, operation.path.join("."), jsonSearchText(operation.value)].filter(Boolean).join(" "))
        .join(" ");
      return {
        id: `ui.state.patch:${hashSuffix(sourceHash)}:${fact.id}`,
        kind: "ui.state" as const,
        text: [fact.callId, fact.reason, patchText].filter(Boolean).join(" "),
        sourceHash,
        source: fact.source,
        callId: fact.callId,
        createdAt: fact.createdAt,
        importance: runtimeImportanceForKind("ui.state"),
      } satisfies ResolvedRuntimeNode;
    }),
  );

  const snapshotNodes = await Promise.all(
    (input.uiStateSnapshots ?? []).map(async (snapshot) => {
      const sourceHash = await hashNulldownSourceContent(serializeCanonicalJson(snapshot));
      return {
        id: `ui.state.snapshot:${hashSuffix(sourceHash)}:${snapshot.id}`,
        kind: "ui.state" as const,
        text: [snapshot.callId, jsonSearchText(snapshot.state)].filter(Boolean).join(" "),
        sourceHash,
        source: snapshot.source,
        callId: snapshot.callId,
        createdAt: snapshot.createdAt,
        importance: runtimeImportanceForKind("ui.state"),
      } satisfies ResolvedRuntimeNode;
    }),
  );

  return [...pluginNodes, ...primitiveNodes, ...responseNodes, ...patchNodes, ...snapshotNodes];
};

export const heapifyResolvedRuntimeRefs = async ({
  id,
  rootDropId,
  branchId,
  snapshotId,
  sourceRevision,
  sourceSeqRange,
  content,
  resolverId = RESOLVED_RUNTIME_REFS_RESOLVER_ID,
  resolverVersion = RESOLVED_RUNTIME_REFS_RESOLVER_VERSION,
  resolvedAt = Date.now(),
  uiPrimitives,
  uiResponseFacts,
  uiStatePatchFacts,
  uiStateSnapshots,
}: ResolvedRuntimeRefsSource): Promise<ResolvedNulldownState> => {
  const sourceContentHash = await hashMarkdownSource(content);
  const pluginRefs = await parsePluginRefs(content, sourceContentHash);
  const responseRefs = await indexUiResponses(uiResponseFacts);
  const runtimeNodes = await indexRuntimeNodes({
    pluginRefs,
    uiPrimitives,
    uiResponseFacts,
    uiStatePatchFacts,
    uiStateSnapshots,
  });

  return {
    version: 1,
    id:
      id ??
      buildResolvedChecklistId({
        rootDropId,
        branchId,
        snapshotId,
        sourceRevision,
        sourceHash: sourceContentHash,
        resolverId,
        resolverVersion,
      }),
    rootDropId,
    branchId,
    snapshotId,
    sourceRevision,
    sourceSeqRange,
    sourceContentHash,
    resolverId,
    resolverVersion,
    resolvedAt,
    pluginRefs,
    responseRefs,
    runtimeNodes,
  };
};

export const getNextResolvedChecklistItem = (
  state: ResolvedNulldownState,
): ResolvedChecklistItem | null => {
  const items = state.checklistItems ?? [];
  const candidates = items.filter((item) => !item.checked);
  if (candidates.length === 0) return null;

  return [...candidates].sort((left, right) => {
    const leftImportance = left.importance ?? state.importance?.[left.id] ?? 0;
    const rightImportance = right.importance ?? state.importance?.[right.id] ?? 0;
    if (rightImportance !== leftImportance) {
      return rightImportance - leftImportance;
    }

    const leftStart = left.sourceRange?.start ?? Number.MAX_SAFE_INTEGER;
    const rightStart = right.sourceRange?.start ?? Number.MAX_SAFE_INTEGER;
    return leftStart - rightStart;
  })[0];
};

const tokenPattern = /[a-z0-9]+/g;

const tokenizeQueryText = (value: string | undefined): string[] => {
  if (!value) return [];
  const tokens = value.toLowerCase().match(tokenPattern) ?? [];
  return [...new Set(tokens)].filter((entry) => entry.length > 1);
};

const documentNodeSearchText = (node: ResolvedDocumentNode): string =>
  [
    node.text,
    ...(node.headingPath ?? []),
    node.pluginId,
    node.dropId,
    node.href,
    node.language,
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join(" ")
    .toLowerCase();

const sourceRangesOverlap = (
  left: ResolvedSourceRange,
  right: ResolvedSourceRange,
): boolean => {
  if (right.start === right.end) {
    return left.start <= right.start && right.start <= left.end;
  }
  if (left.start === left.end) {
    return right.start <= left.start && left.start <= right.end;
  }
  return left.start < right.end && right.start < left.end;
};

const eventRefsForNode = (
  node: ResolvedDocumentNode,
  events: readonly ResolvedDiffEventRef[],
): ResolvedDiffEventRef[] =>
  events.filter((event) =>
    event.changedRanges.some((range) => sourceRangesOverlap(node.sourceRange, range)),
  );

const scoreDocumentNode = (
  state: ResolvedNulldownState,
  node: ResolvedDocumentNode,
  queryTokens: readonly string[],
  changedRanges: readonly ResolvedSourceRange[],
): { score: number; reasons: string[]; changed: boolean } => {
  const reasons: string[] = [];
  let score = node.importance ?? state.importance?.[node.id] ?? importanceForNodeKind(node.kind, node.depth, node.checked);
  if (score > 0) reasons.push("importance");

  if (node.kind === "document.title" || node.kind === "heading") {
    score += 2;
    reasons.push("heading-boost");
  } else if (node.kind === "section") {
    score += 1;
    reasons.push("section-boost");
  }
  if (node.kind === "checklist.item" && node.checked === false) {
    score += 1.5;
    reasons.push("open-checklist-boost");
  }
  if (node.kind === "nullplug.ref") {
    score += 1.25;
    reasons.push("nullplug-boost");
  }

  if (queryTokens.length > 0) {
    const searchable = documentNodeSearchText(node);
    const matches = queryTokens.filter((token) => searchable.includes(token));
    if (matches.length > 0) {
      score += (matches.length / queryTokens.length) * 6;
      reasons.push("query-match");
    } else {
      score -= 1;
    }
  }

  const changed = changedRanges.some((range) => sourceRangesOverlap(node.sourceRange, range));
  if (changed) {
    score += 4;
    reasons.push("changed-range-overlap");
  }

  return { score, reasons, changed };
};

export const changedRangesFromDropDiffEvents = (
  events: readonly DropDiffEvent[],
): ResolvedDiffEventRef[] =>
  events.map((event) => {
    const changedRanges = event.ops.flatMap((op) => {
      const diff = dropDiffOpToDiff(op);
      if (!diff) return [];
      const range = diff.range ?? { start: 0, end: 0 };
      if (diff.op === DiffOp.INSERT) {
        const inserted = decodeText(diff.data);
        return [{ start: range.start, end: range.start + inserted.length }];
      }
      if (diff.op === DiffOp.DELETE) {
        return [{ start: range.start, end: range.start }];
      }
      return [];
    });

    return {
      seq: event.seq,
      eventId: event.eventId,
      sourceClientId: event.sourceClientId,
      createdAt: event.createdAt,
      metadata: event.metadata,
      changedRanges,
    };
  });

export const queryResolvedDocumentNodes = (
  state: ResolvedNulldownState,
  query: ResolvedDocumentQuery = {},
): ResolvedDocumentNodeQueryResult[] => {
  const nodes = state.documentNodes ?? [];
  const queryTokens = tokenizeQueryText(query.q);
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 10)));
  const kindSet = query.kinds?.length ? new Set(query.kinds) : null;
  const eventRefs = query.events ?? [];
  const changedRanges = [
    ...(query.changedRanges ?? []),
    ...eventRefs.flatMap((event) => event.changedRanges),
  ];

  const scored = nodes
    .filter((node) => !kindSet || kindSet.has(node.kind))
    .map((node) => {
      const scoredNode = scoreDocumentNode(state, node, queryTokens, changedRanges);
      return {
        node,
        score: scoredNode.score,
        reasons: scoredNode.reasons,
        changed: scoredNode.changed,
        eventRefs: eventRefsForNode(node, eventRefs),
      };
    })
    .filter((entry) => !query.changedOnly || entry.changed)
    .filter((entry) => queryTokens.length === 0 || entry.reasons.includes("query-match") || entry.changed)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.node.sourceRange.start - right.node.sourceRange.start;
    });

  const selected = scored.slice(0, limit).map(({ changed: _changed, ...entry }) => ({
    ...entry,
    eventRefs: entry.eventRefs.length ? entry.eventRefs : undefined,
  }));

  if (!query.includeAncestors || selected.length === 0) {
    return selected;
  }

  const selectedIds = new Set(selected.map((entry) => entry.node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const ancestors: ResolvedDocumentNodeQueryResult[] = [];

  selected.forEach((entry) => {
    let parentId = entry.node.parentId ?? entry.node.sectionId;
    while (parentId) {
      if (selectedIds.has(parentId)) break;
      const parent = nodeById.get(parentId);
      if (!parent) break;
      selectedIds.add(parent.id);
      ancestors.push({
        node: parent,
        score: Math.max(0, entry.score - 0.01),
        reasons: ["ancestor"],
      });
      parentId = parent.parentId ?? parent.sectionId;
    }
  });

  return [...selected, ...ancestors].sort((left, right) => {
    const leftStart = left.node.sourceRange.start;
    const rightStart = right.node.sourceRange.start;
    return leftStart - rightStart;
  });
};

const runtimeNodeSearchText = (node: ResolvedRuntimeNode): string =>
  [
    node.text,
    node.pluginId,
    node.dropId,
    node.callId,
    node.primitiveId,
    node.source?.rootDropId,
    node.source?.branchId,
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join(" ")
    .toLowerCase();

const scoreRuntimeNode = (
  state: ResolvedNulldownState,
  node: ResolvedRuntimeNode,
  queryTokens: readonly string[],
): { score: number; reasons: string[] } => {
  const reasons: string[] = [];
  let score = node.importance ?? state.importance?.[node.id] ?? runtimeImportanceForKind(node.kind);
  if (score > 0) reasons.push("importance");

  if (node.kind === "ui.state") {
    score += 1.2;
    reasons.push("state-boost");
  } else if (node.kind === "ui.response") {
    score += 1;
    reasons.push("response-boost");
  } else if (node.kind === "ui.primitive") {
    score += 0.8;
    reasons.push("primitive-boost");
  } else if (node.kind === "nullplug.ref") {
    score += 0.7;
    reasons.push("nullplug-boost");
  }

  if (queryTokens.length > 0) {
    const searchable = runtimeNodeSearchText(node);
    const matches = queryTokens.filter((token) => searchable.includes(token));
    if (matches.length > 0) {
      score += (matches.length / queryTokens.length) * 6;
      reasons.push("query-match");
    } else {
      score -= 1;
    }
  }

  return { score, reasons };
};

export const queryResolvedRuntimeNodes = (
  state: ResolvedNulldownState,
  query: ResolvedRuntimeQuery = {},
): ResolvedRuntimeNodeQueryResult[] => {
  const nodes = state.runtimeNodes ?? [];
  const queryTokens = tokenizeQueryText(query.q);
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 10)));
  const kindSet = query.kinds?.length ? new Set(query.kinds) : null;

  return nodes
    .filter((node) => !kindSet || kindSet.has(node.kind))
    .filter((node) => !query.pluginId || node.pluginId === query.pluginId)
    .filter((node) => !query.callId || node.callId === query.callId)
    .filter((node) => !query.primitiveId || node.primitiveId === query.primitiveId)
    .map((node) => {
      const scoredNode = scoreRuntimeNode(state, node, queryTokens);
      return {
        node,
        score: scoredNode.score,
        reasons: scoredNode.reasons,
      };
    })
    .filter((entry) => queryTokens.length === 0 || entry.reasons.includes("query-match"))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftCreated = left.node.createdAt ?? Number.MAX_SAFE_INTEGER;
      const rightCreated = right.node.createdAt ?? Number.MAX_SAFE_INTEGER;
      if (leftCreated !== rightCreated) return leftCreated - rightCreated;
      return left.node.id.localeCompare(right.node.id);
    })
    .slice(0, limit);
};

export const readResolvedNulldownState = async (
  store: ResolvedHeapJsonStore,
  rootDropId: string,
  branchId: string,
  resolverId: string,
  snapshotId: number,
): Promise<ResolvedNulldownState | null> => {
  const object = await store.get(
    dropResolvedHeapKey(rootDropId, branchId, resolverId, snapshotId),
  );
  if (!object) return null;
  try {
    const parsed = await object.json();
    return isResolvedNulldownState(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeResolvedNulldownState = async (
  store: ResolvedHeapJsonStore,
  state: ResolvedNulldownState,
): Promise<string> => {
  if (!isResolvedNulldownState(state)) {
    throw new Error("Invalid resolved Nulldown state.");
  }
  if (!state.branchId || state.snapshotId === undefined) {
    throw new Error("Resolved heap storage requires branchId and snapshotId.");
  }

  const key = dropResolvedHeapKey(
    state.rootDropId,
    state.branchId,
    state.resolverId,
    state.snapshotId,
  );
  await store.put(key, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  });
  return key;
};
