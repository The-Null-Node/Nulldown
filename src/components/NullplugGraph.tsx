import React, { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  drag,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  select,
  zoom,
  type D3DragEvent,
  type D3ZoomEvent,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3";
import { useTheme } from "../theme/themeContext";

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

interface GraphNodeDatum extends GraphNode, SimulationNodeDatum {}

interface GraphLinkDatum extends SimulationLinkDatum<GraphNodeDatum> {
  label?: string;
}

interface NullplugGraphProps {
  encodedGraph: string;
}

const WIDTH = 760;
const HEIGHT = 440;

const decodeGraphData = (encodedGraph: string): GraphData | null => {
  try {
    const parsed = JSON.parse(decodeURIComponent(encodedGraph)) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as GraphData).nodes)
    ) {
      return null;
    }

    const data = parsed as GraphData;
    if (
      !data.nodes.every(
        (node) => typeof node === "object" && typeof node.id === "string",
      )
    ) {
      return null;
    }

    return {
      ...data,
      edges: Array.isArray(data.edges) ? data.edges : [],
    };
  } catch {
    return null;
  }
};

const cssVar = (name: string, fallback: string): string => {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
};

const shortLabel = (value: string): string =>
  value.length > 22 ? `${value.slice(0, 20)}...` : value;

const nodeKindColor = (kind: string | undefined, accent: string): string => {
  if (kind === "root") return accent;
  if (kind === "child") return "#3b82f6";
  if (kind === "version") return "#10b981";
  return "#8b949e";
};

const navigateToHref = (href: string, navigate: ReturnType<typeof useNavigate>) => {
  if (href.startsWith("/")) {
    navigate(href);
    return;
  }

  window.location.assign(href);
};

const renderGraph = (
  mount: HTMLDivElement,
  graph: GraphData,
  navigate: ReturnType<typeof useNavigate>,
) => {
  const background = cssVar("--card", "#121212");
  const foreground = cssVar("--foreground", "#e5e5e5");
  const muted = cssVar("--muted-foreground", "#9a9a9a");
  const border = cssVar("--border", "#333333");
  const accent = cssVar("--accent", "#39ff14");

  const nodes: GraphNodeDatum[] = graph.nodes.map((node, index) => ({
    ...node,
    x: WIDTH / 2 + Math.cos(index) * 120,
    y: HEIGHT / 2 + Math.sin(index) * 120,
  }));

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links: GraphLinkDatum[] = graph.edges
    .filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target))
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      label: edge.label,
    }));

  select(mount).selectAll("*").remove();
  const markerId = `nulldown-graph-arrow-${Math.random().toString(36).slice(2)}`;

  const tooltip = select(mount)
    .append("div")
    .attr(
      "class",
      "pointer-events-none absolute z-20 max-w-xs rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground opacity-0 shadow-lg transition-opacity",
    )
    .style("left", "0")
    .style("top", "0");

  const svg = select(mount)
    .append("svg")
    .attr("viewBox", `0 0 ${WIDTH} ${HEIGHT}`)
    .attr("role", "img")
    .attr("aria-label", graph.title ?? "Nulldown graph")
    .style("display", "block")
    .style("height", "min(60vh, 440px)")
    .style("width", "100%")
    .style("background", background)
    .style("border-radius", "0.75rem");

  svg
    .append("defs")
    .append("marker")
    .attr("id", markerId)
    .attr("viewBox", "0 0 10 10")
    .attr("refX", 12)
    .attr("refY", 5)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M 0 0 L 10 5 L 0 10 z")
    .attr("fill", muted);

  const frame = svg.append("g");
  frame
    .append("rect")
    .attr("x", 12)
    .attr("y", 12)
    .attr("width", WIDTH - 24)
    .attr("height", HEIGHT - 24)
    .attr("rx", 18)
    .attr("fill", "transparent")
    .attr("stroke", border)
    .attr("stroke-width", 1);

  const linkLayer = frame.append("g").attr("stroke", muted);
  const nodeLayer = frame.append("g");
  const labelLayer = frame.append("g");

  const link = linkLayer
    .selectAll<SVGLineElement, GraphLinkDatum>("line")
    .data(links)
    .join("line")
    .attr("stroke-opacity", 0.55)
    .attr("stroke-width", 1.5)
    .attr("marker-end", graph.directional ? `url(#${markerId})` : null);

  const linkLabel = labelLayer
    .selectAll<SVGTextElement, GraphLinkDatum>("text")
    .data(links.filter((entry) => entry.label))
    .join("text")
    .attr("fill", muted)
    .attr("font-size", 10)
    .attr("text-anchor", "middle")
    .text((entry) => entry.label ?? "");

  const node = nodeLayer
    .selectAll<SVGGElement, GraphNodeDatum>("g")
    .data(nodes)
    .join("g")
    .attr("tabindex", 0)
    .attr("role", (entry) => (entry.linkHref ? "link" : "img"))
    .style("cursor", (entry) => (entry.linkHref ? "pointer" : "grab"));

  node
    .append("circle")
    .attr("r", (entry) => (entry.kind === "root" ? 18 : 14))
    .attr("fill", (entry) => nodeKindColor(entry.kind, accent))
    .attr("fill-opacity", 0.16)
    .attr("stroke", (entry) => nodeKindColor(entry.kind, accent))
    .attr("stroke-width", 2);

  node
    .append("text")
    .attr("y", (entry) => (entry.kind === "root" ? 34 : 30))
    .attr("fill", foreground)
    .attr("font-size", 11)
    .attr("text-anchor", "middle")
    .text((entry) => shortLabel(entry.label ?? entry.id));

  node
    .on("mouseenter", (event: MouseEvent, entry) => {
      tooltip.selectAll("*").remove();
      tooltip.append("div").attr("class", "font-medium").text(entry.label ?? entry.id);
      tooltip
        .append("div")
        .attr("class", "text-muted")
        .text(`${entry.kind ?? "drop"} · ${entry.id}`);
      tooltip
        .style("opacity", "1");
      tooltip.style("left", `${event.offsetX + 12}px`).style("top", `${event.offsetY + 12}px`);
    })
    .on("mousemove", (event: MouseEvent) => {
      tooltip.style("left", `${event.offsetX + 12}px`).style("top", `${event.offsetY + 12}px`);
    })
    .on("mouseleave", () => {
      tooltip.style("opacity", "0");
    })
    .on("click", (event: MouseEvent, entry) => {
      event.stopPropagation();
      if (entry.linkHref) navigateToHref(entry.linkHref, navigate);
    })
    .on("keydown", (event: KeyboardEvent, entry) => {
      if ((event.key === "Enter" || event.key === " ") && entry.linkHref) {
        event.preventDefault();
        navigateToHref(entry.linkHref, navigate);
      }
    });

  const simulation = forceSimulation<GraphNodeDatum>(nodes)
    .force(
      "link",
      forceLink<GraphNodeDatum, GraphLinkDatum>(links)
        .id((entry) => entry.id)
        .distance(130),
    )
    .force("charge", forceManyBody().strength(-460))
    .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
    .force("collide", forceCollide<GraphNodeDatum>().radius(48));

  const dragBehavior = drag<SVGGElement, GraphNodeDatum>()
    .on("start", (event: D3DragEvent<SVGGElement, GraphNodeDatum, GraphNodeDatum>, entry) => {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      entry.fx = entry.x;
      entry.fy = entry.y;
    })
    .on("drag", (event: D3DragEvent<SVGGElement, GraphNodeDatum, GraphNodeDatum>, entry) => {
      entry.fx = event.x;
      entry.fy = event.y;
    })
    .on("end", (event: D3DragEvent<SVGGElement, GraphNodeDatum, GraphNodeDatum>, entry) => {
      if (!event.active) simulation.alphaTarget(0);
      entry.fx = null;
      entry.fy = null;
    });

  node.call(dragBehavior);

  const zoomBehavior = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.35, 4])
    .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      frame.attr("transform", event.transform.toString());
    });

  svg.call(zoomBehavior);

  simulation.on("tick", () => {
    link
      .attr("x1", (entry) => (entry.source as GraphNodeDatum).x ?? 0)
      .attr("y1", (entry) => (entry.source as GraphNodeDatum).y ?? 0)
      .attr("x2", (entry) => (entry.target as GraphNodeDatum).x ?? 0)
      .attr("y2", (entry) => (entry.target as GraphNodeDatum).y ?? 0);

    linkLabel
      .attr(
        "x",
        (entry) =>
          (((entry.source as GraphNodeDatum).x ?? 0) +
            ((entry.target as GraphNodeDatum).x ?? 0)) /
          2,
      )
      .attr(
        "y",
        (entry) =>
          (((entry.source as GraphNodeDatum).y ?? 0) +
            ((entry.target as GraphNodeDatum).y ?? 0)) /
          2,
      );

    node.attr(
      "transform",
      (entry) => `translate(${entry.x ?? WIDTH / 2},${entry.y ?? HEIGHT / 2})`,
    );
  });

  return () => {
    simulation.stop();
    select(mount).selectAll("*").remove();
  };
};

const NullplugGraph: React.FC<NullplugGraphProps> = ({ encodedGraph }) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const { theme } = useTheme();
  const graph = useMemo(() => decodeGraphData(encodedGraph), [encodedGraph]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !graph || graph.nodes.length === 0) return undefined;
    return renderGraph(mount, graph, navigate);
  }, [graph, navigate, theme.id, theme.mode]);

  if (!graph) {
    return (
      <div className="not-prose my-4 rounded-xl border border-border bg-card p-4 text-sm text-muted">
        Invalid graph data.
      </div>
    );
  }

  return (
    <div className="not-prose relative my-4 rounded-xl border border-border bg-card/80 p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <div className="font-medium uppercase tracking-[0.2em] text-foreground">
          {graph.title ?? "Nulldown Graph"}
        </div>
        <div>Drag nodes. Scroll or pinch to zoom.</div>
      </div>
      {graph.error && (
        <div className="mb-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-error-light">
          {graph.error}
        </div>
      )}
      {graph.nodes.length > 0 ? (
        <div ref={mountRef} className="relative min-h-[260px] overflow-hidden" />
      ) : (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted">
          No graph nodes available.
        </div>
      )}
    </div>
  );
};

export default NullplugGraph;
