import { nullplug } from "../registry";
import type { NullplugContext, NullplugHandler, PluginBlock } from "../types";
import { isDropIdToken } from "../../../../shared/drop/id";
import { getMarkdownTitle } from "../../markdownText";

interface GraphNode {
  id: string;
  label?: string;
  kind?: string;
  group?: number;
  linkHref?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  label?: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  title?: string;
  directional?: boolean;
  error?: string;
}

const DROP_URL_PATTERN = /\/d\/([A-Za-z0-9_-]+)/;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const parseGraphData = (content: string): GraphData | null => {
  try {
    const parsed = JSON.parse(content.trim()) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as GraphData).nodes) &&
      (parsed as GraphData).nodes.every(
        (node: unknown) =>
          typeof node === "object" &&
          node !== null &&
          typeof (node as GraphNode).id === "string",
      )
    ) {
      return {
        ...(parsed as GraphData),
        edges: Array.isArray((parsed as GraphData).edges)
          ? (parsed as GraphData).edges
          : [],
      };
    }
    return null;
  } catch {
    return null;
  }
};

const unwrapQuotedValue = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }

  return trimmed;
};

const firstMeaningfulBodyValue = (blockContent: string): string => {
  const line = blockContent
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);

  if (!line) return "";

  const idMatch = /^id\s*=\s*(.+)$/i.exec(line);
  return unwrapQuotedValue(idMatch?.[1] ?? line);
};

const extractDropId = (value: string): string => {
  const trimmed = unwrapQuotedValue(value);
  if (!trimmed) return "";

  const urlMatch = DROP_URL_PATTERN.exec(trimmed);
  if (urlMatch?.[1]) return urlMatch[1];

  return trimmed;
};

const graphContainer = (data: GraphData): string => {
  const encoded = encodeURIComponent(JSON.stringify(data));
  return `<div class="nulldown-graph" data-graph="${encoded}"></div>`;
};

const statusCard = (title: string, detail: string): string =>
  `<div class="nd-card rounded-md border border-border bg-card/80 p-3 text-xs text-muted"><div class="mb-1 font-medium text-foreground">${escapeHtml(
    title,
  )}</div><div>${escapeHtml(detail)}</div></div>`;

const buildLineageGraph = async (
  ctx: NullplugContext,
  dropId: string,
  depth: number,
): Promise<GraphData> => {
  if (!ctx.resolveDrop) {
    return {
      nodes: [],
      edges: [],
      title: `Lineage of ${dropId}`,
      error: "This render surface does not expose drop resolution.",
    };
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const visited = new Set<string>();
  let current: string | null = dropId;
  let level = 0;
  let lastMissingId: string | null = null;

  while (current && !visited.has(current) && level < Math.max(1, depth)) {
    visited.add(current);
    const payload = await ctx.resolveDrop(current);
    if (!payload) {
      lastMissingId = current;
      break;
    }

    const title = getMarkdownTitle(payload.content) ?? current;
    nodes.push({
      id: current,
      label: title,
      kind: level === 0 ? "root" : "child",
      linkHref: current.startsWith("offline_") ? undefined : `/d/${current}`,
    });

    const parent = payload.metadata?.baseDropId ?? payload.metadata?.rootDropId;
    if (
      typeof parent === "string" &&
      parent !== current &&
      !visited.has(parent)
    ) {
      edges.push({ source: parent, target: current, label: "base" });
      current = parent;
    } else {
      break;
    }
    level++;
  }

  return {
    nodes: nodes.reverse(),
    edges,
    title: `Lineage of ${dropId}`,
    directional: true,
    error:
      nodes.length === 0 && lastMissingId
        ? `Could not resolve drop ${lastMissingId}.`
        : undefined,
  };
};

const graph: NullplugHandler & { pluginId: string } = Object.assign(
  async (
    ctx: NullplugContext,
    blockContent: string,
    _block: PluginBlock,
  ) => {
    const staticGraph = parseGraphData(blockContent);
    if (staticGraph) {
      return { text: graphContainer(staticGraph) };
    }

    const targetDropId = extractDropId(firstMeaningfulBodyValue(blockContent));
    if (targetDropId && isDropIdToken(targetDropId)) {
      const lineage = await buildLineageGraph(ctx, targetDropId, 6);
      if (lineage.nodes.length > 0 || lineage.error) {
        return { text: graphContainer(lineage) };
      }
    }

    return {
      text: statusCard(
        "Invalid graph block",
        `Use a drop ID or a JSON graph object. Example: ${'{"nodes":[{"id":"a","label":"Root"}],"edges":[]}'}`,
      ),
    };
  },
  { pluginId: "graph" },
);

nullplug(graph);
