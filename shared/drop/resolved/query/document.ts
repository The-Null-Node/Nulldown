import {
  dropDiffOpToDiff,
  type DropDiffEvent,
} from "../../diff";
import { decodeText } from "../../../nulledit/textDiff";
import { DiffOp } from "../../../nulledit/types";
import type {
  ResolvedDiffEventRef,
  ResolvedDocumentNode,
  ResolvedDocumentNodeKind,
  ResolvedDocumentNodeQueryResult,
  ResolvedDocumentQuery,
  ResolvedNulldownState,
  ResolvedSourceRange,
} from "../types";

const tokenPattern = /[a-z0-9]+/g;
const priorityFactScoreMultiplier = 4;
const documentNodeSearchTextCache = new WeakMap<ResolvedDocumentNode, string>();

const tokenizeQueryText = (value: string | undefined): string[] => {
  if (!value) return [];
  const tokens = value.toLowerCase().match(tokenPattern) ?? [];
  return [...new Set(tokens)].filter((entry) => entry.length > 1);
};

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

const documentNodeSearchText = (node: ResolvedDocumentNode): string => {
  const cached = documentNodeSearchTextCache.get(node);
  if (cached !== undefined) return cached;

  const searchable = [
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
  documentNodeSearchTextCache.set(node, searchable);
  return searchable;
};

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

const mergeSourceRanges = (
  ranges: readonly ResolvedSourceRange[],
): ResolvedSourceRange[] => {
  if (ranges.length < 2) return [...ranges];

  const ordered = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: ResolvedSourceRange[] = [];

  ordered.forEach((range) => {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      return;
    }

    previous.end = Math.max(previous.end, range.end);
  });

  return merged;
};

type SourceRangeOverlapChecker = (range: ResolvedSourceRange) => boolean;

const createSourceRangeOverlapChecker = (
  ranges: readonly ResolvedSourceRange[],
): SourceRangeOverlapChecker => {
  if (!ranges.length) return () => false;

  return (range) => {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ranges[middle].end < range.start) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    // Large sections may overlap more than one changed range. Most nodes exit on
    // the first candidate, while the source-order cutoff keeps the rest bounded.
    for (let index = low; index < ranges.length && ranges[index].start <= range.end; index += 1) {
      if (sourceRangesOverlap(range, ranges[index])) return true;
    }
    return false;
  };
};

const eventRefsForNode = (
  node: ResolvedDocumentNode,
  events: readonly ResolvedDiffEventRef[],
): ResolvedDiffEventRef[] =>
  events.filter((event) =>
    event.changedRanges.some((range) => sourceRangesOverlap(node.sourceRange, range)),
  );

const priorityFromDiffRefs = (
  refs: readonly ResolvedDiffEventRef[],
  priorityByDiffEventId: Record<string, number> | undefined,
): number => {
  if (!priorityByDiffEventId) return 0;
  return refs.reduce(
    (total, ref) => total + (priorityByDiffEventId[ref.eventId] ?? 0),
    0,
  );
};

const scoreDocumentNode = (
  state: ResolvedNulldownState,
  node: ResolvedDocumentNode,
  queryTokens: readonly string[],
  changedRangeOverlapsNode: SourceRangeOverlapChecker,
  priority: number,
): { score: number; reasons: string[]; changed: boolean } => {
  const reasons: string[] = [];
  let score = node.importance ?? state.importance?.[node.id] ?? importanceForNodeKind(node.kind, node.depth, node.checked);
  if (score > 0) reasons.push("importance");

  if (priority !== 0) {
    score += priority * priorityFactScoreMultiplier;
    reasons.push("priority-fact");
  }

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

  const changed = changedRangeOverlapsNode(node.sourceRange);
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

interface ScoredDocumentNode {
  node: ResolvedDocumentNode;
  score: number;
  reasons: string[];
  changed: boolean;
  eventRefs: ResolvedDiffEventRef[];
}

const compareScoredDocumentNodes = (
  left: ScoredDocumentNode,
  right: ScoredDocumentNode,
): number =>
  right.score - left.score ||
  left.node.sourceRange.start - right.node.sourceRange.start;

const retainTopDocumentNode = (
  candidates: ScoredDocumentNode[],
  candidate: ScoredDocumentNode,
  limit: number,
): void => {
  if (
    candidates.length === limit &&
    compareScoredDocumentNodes(candidate, candidates[candidates.length - 1]) >= 0
  ) {
    return;
  }

  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareScoredDocumentNodes(candidate, candidates[middle]) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  candidates.splice(low, 0, candidate);
  if (candidates.length > limit) candidates.pop();
};

export const queryResolvedDocumentNodes = (
  state: ResolvedNulldownState,
  query: ResolvedDocumentQuery = {},
): ResolvedDocumentNodeQueryResult[] => {
  const nodes = state.documentNodes ?? [];
  const queryTokens = tokenizeQueryText(query.q);
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 10)));
  const kindSet = query.kinds?.length ? new Set(query.kinds) : null;
  const eventRefs = query.events ?? [];
  const changedRanges = mergeSourceRanges([
    ...(query.changedRanges ?? []),
    ...eventRefs.flatMap((event) => event.changedRanges),
  ]);
  const changedRangeOverlapsNode = createSourceRangeOverlapChecker(changedRanges);
  const candidates: ScoredDocumentNode[] = [];

  nodes.forEach((node) => {
    if (kindSet && !kindSet.has(node.kind)) return;

    const nodeEventRefs = eventRefsForNode(node, eventRefs);
    const priority =
      (query.heapPriority ?? 0) +
      (query.priorityByNodeId?.[node.id] ?? 0) +
      priorityFromDiffRefs(nodeEventRefs, query.priorityByDiffEventId);
    const scoredNode = scoreDocumentNode(
      state,
      node,
      queryTokens,
      changedRangeOverlapsNode,
      priority,
    );
    if (query.changedOnly && !scoredNode.changed) return;
    if (
      queryTokens.length > 0 &&
      !scoredNode.reasons.includes("query-match") &&
      !scoredNode.changed
    ) {
      return;
    }

    retainTopDocumentNode(
      candidates,
      {
        node,
        score: scoredNode.score,
        reasons: scoredNode.reasons,
        changed: scoredNode.changed,
        eventRefs: nodeEventRefs,
      },
      limit,
    );
  });

  const selected = candidates.map(({ changed: _changed, ...entry }) => ({
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
