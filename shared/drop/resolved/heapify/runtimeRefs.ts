import { serializeCanonicalJson } from "../../types";
import {
  NULLDOWN_SOURCE_HASH_PREFIX,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_VERSION,
} from "../constants";
import { hashMarkdownSource, hashNulldownSourceContent } from "../hash";
import type {
  NulldownSourceHash,
  ResolvedNulldownState,
  ResolvedPluginRef,
  ResolvedRuntimeNode,
  ResolvedRuntimeNodeKind,
  ResolvedRuntimeRefsSource,
  ResolvedUiResponseRef,
} from "../types";
import type {
  NullplugUiPrimitive,
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
  NullplugUiStateSnapshot,
} from "../../../nullplug/ui";

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

const buildResolvedStateId = ({
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
    const bodyStart = lineEnd === -1 ? content.length : lineEnd + 1;
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
      buildResolvedStateId({
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
