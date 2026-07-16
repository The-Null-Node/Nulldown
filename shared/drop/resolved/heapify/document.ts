import {
  NULLDOWN_SOURCE_HASH_PREFIX,
  RESOLVED_CHECKLIST_RESOLVER_ID,
  RESOLVED_CHECKLIST_RESOLVER_VERSION,
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_DOCUMENT_RESOLVER_VERSION,
} from "../constants";
import { hashMarkdownSource } from "../hash";
import type {
  NulldownSourceHash,
  ResolvedChecklistItem,
  ResolvedChecklistSource,
  ResolvedDocumentNode,
  ResolvedDocumentNodeKind,
  ResolvedDocumentSource,
  ResolvedNulldownState,
} from "../types";

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
  parentId?: string;
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
  let hasDocumentTitle = false;
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
        parentId: headingStack[headingStack.length - 1]?.id,
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
        parentId: heading.parentId,
        depth,
        importance: importanceForNodeKind("heading", depth),
      });
      if (!hasDocumentTitle && depth === 1) {
        hasDocumentTitle = true;
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

  // Walk backward once so each section closes at the nearest later heading of
  // equal or lesser depth without rescanning the heading list for every node.
  const nextHeadingStarts = Array<number>(7).fill(content.length);
  const sections: ResolvedDocumentNode[] = Array(headings.length);
  for (let headingIndex = headings.length - 1; headingIndex >= 0; headingIndex -= 1) {
    const heading = headings[headingIndex];
    let end = content.length;
    for (let depth = 1; depth <= heading.depth; depth += 1) {
      end = Math.min(end, nextHeadingStarts[depth]);
    }
    nextHeadingStarts[heading.depth] = heading.start;
    sections[headingIndex] = {
      id: documentNodeId("section", sourceContentHash, heading.start, end),
      kind: "section",
      text: content.slice(heading.start, end).trim().slice(0, 1600),
      sourceRange: { start: heading.start, end },
      sourceHash: sourceContentHash,
      headingPath: heading.path,
      parentId: heading.parentId,
      depth: heading.depth,
      importance: importanceForNodeKind("section", heading.depth),
    };
  }
  nodes.push(...sections);

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
    title,
    checklistItems,
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
