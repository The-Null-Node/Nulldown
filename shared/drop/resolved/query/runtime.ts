import type {
  ResolvedNulldownState,
  ResolvedRuntimeNode,
  ResolvedRuntimeNodeKind,
  ResolvedRuntimeNodeQueryResult,
  ResolvedRuntimeQuery,
} from "../types";

const tokenPattern = /[a-z0-9]+/g;
const priorityFactScoreMultiplier = 4;

const tokenizeQueryText = (value: string | undefined): string[] => {
  if (!value) return [];
  const tokens = value.toLowerCase().match(tokenPattern) ?? [];
  return [...new Set(tokens)].filter((entry) => entry.length > 1);
};

const runtimeImportanceForKind = (kind: ResolvedRuntimeNodeKind): number => {
  if (kind === "ui.state") return 3;
  if (kind === "ui.response") return 2.8;
  if (kind === "ui.primitive") return 2.4;
  return 2.2;
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
  priority: number,
): { score: number; reasons: string[] } => {
  const reasons: string[] = [];
  let score = node.importance ?? state.importance?.[node.id] ?? runtimeImportanceForKind(node.kind);
  if (score > 0) reasons.push("importance");

  if (priority !== 0) {
    score += priority * priorityFactScoreMultiplier;
    reasons.push("priority-fact");
  }

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
      const priority =
        (query.heapPriority ?? 0) + (query.priorityByNodeId?.[node.id] ?? 0);
      const scoredNode = scoreRuntimeNode(state, node, queryTokens, priority);
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
