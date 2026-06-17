import { clearNullplugRegistry, resolveNullplug } from "../registry";

// Import triggers side-effect registration
import "./graph";

beforeAll(() => {
  // Ensure the module imported triggers registration
});

afterAll(() => {
  clearNullplugRegistry();
});

const readGraphFromContainer = (text: string) => {
  const match = /data-graph="([^"]+)"/.exec(text);
  expect(match?.[1]).toBeDefined();
  return JSON.parse(decodeURIComponent(match![1]));
};

describe("graph nullplug", () => {
  it("registers as graph", () => {
    const handler = resolveNullplug("graph");
    expect(handler).toBeDefined();
  });

  it("renders valid graph JSON as an interactive graph container", async () => {
    const handler = resolveNullplug("graph");
    if (!handler) throw new Error("Handler not registered");

    const graphData = {
      nodes: [
        { id: "a", label: "Alpha", kind: "root" },
        { id: "b", label: "Beta", kind: "child" },
        { id: "c", label: "Gamma", kind: "version" },
      ],
      edges: [
        { source: "a", target: "b", label: "child" },
        { source: "b", target: "c", label: "version" },
      ],
      title: "Test Graph",
    };

    const ctx = {
      allowedNetworkHosts: new Set<string>(),
      toTrustedEmbedUrl: (_url: string) => null,
      caller: {},
      maxDepth: 4,
      visitedDropIds: new Set<string>(),
    };

    const block = {
      id: "graph",
      args: null,
      start: 0,
      end: 100,
      content: JSON.stringify(graphData),
      info: "graph",
    };

    const result = await handler(ctx, block.content, block);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    if (result && typeof result === "object" && "text" in result) {
      const text = result.text as string;
      expect(text).toContain('class="nulldown-graph"');
      const graph = readGraphFromContainer(text);
      expect(graph.title).toBe("Test Graph");
      expect(graph.nodes.map((node: { label?: string }) => node.label)).toEqual([
        "Alpha",
        "Beta",
        "Gamma",
      ]);
    } else {
      throw new Error("Expected text result");
    }
  });

  it("shows help for empty content", async () => {
    const handler = resolveNullplug("graph");
    if (!handler) throw new Error("Handler not registered");

    const ctx = {
      allowedNetworkHosts: new Set<string>(),
      toTrustedEmbedUrl: (_url: string) => null,
      caller: {},
      maxDepth: 4,
      visitedDropIds: new Set<string>(),
    };

    const block = {
      id: "graph",
      args: null,
      start: 0,
      end: 100,
      content: "",
      info: "graph",
    };

    const result = await handler(ctx, block.content, block);
    expect(result).toBeDefined();
    if (result && typeof result === "object" && "text" in result) {
      expect(result.text).toContain("Invalid graph block");
    }
  });

  it("handles minimal graph with no edges", async () => {
    const handler = resolveNullplug("graph");
    if (!handler) throw new Error("Handler not registered");

    const ctx = {
      allowedNetworkHosts: new Set<string>(),
      toTrustedEmbedUrl: (_url: string) => null,
      caller: {},
      maxDepth: 4,
      visitedDropIds: new Set<string>(),
    };

    const block = {
      id: "graph",
      args: null,
      start: 0,
      end: 100,
      content: JSON.stringify({ nodes: [{ id: "solo" }], edges: [] }),
      info: "graph",
    };

    const result = await handler(ctx, block.content, block);
    if (result && typeof result === "object" && "text" in result) {
      const text = result.text as string;
      const graph = readGraphFromContainer(text);
      expect(graph.nodes).toEqual([{ id: "solo" }]);
    }
  });

  it("resolves a drop ID into a lineage graph", async () => {
    const handler = resolveNullplug("graph");
    if (!handler) throw new Error("Handler not registered");

    const ctx = {
      allowedNetworkHosts: new Set<string>(),
      toTrustedEmbedUrl: (_url: string) => null,
      caller: {},
      maxDepth: 4,
      visitedDropIds: new Set<string>(),
      resolveDrop: async (id: string) => {
        if (id === "child") {
          return {
            content: "# Child Drop",
            metadata: { baseDropId: "root" },
          };
        }
        if (id === "root") {
          return {
            content: "# Root Drop",
            metadata: {},
          };
        }
        return null;
      },
    };

    const block = {
      id: "graph",
      args: null,
      start: 0,
      end: 100,
      content: "child",
      info: "graph",
    };

    const result = await handler(ctx, block.content, block);
    if (result && typeof result === "object" && "text" in result) {
      const graph = readGraphFromContainer(result.text as string);
      expect(graph.title).toBe("Lineage of child");
      expect(graph.nodes.map((node: { label?: string }) => node.label)).toEqual([
        "Root Drop",
        "Child Drop",
      ]);
      expect(graph.edges).toEqual([{ source: "root", target: "child", label: "base" }]);
    }
  });

  it("accepts nd-style id lines and drop URLs", async () => {
    const handler = resolveNullplug("graph");
    if (!handler) throw new Error("Handler not registered");

    const seenIds: string[] = [];
    const ctx = {
      allowedNetworkHosts: new Set<string>(),
      toTrustedEmbedUrl: (_url: string) => null,
      caller: {},
      maxDepth: 4,
      visitedDropIds: new Set<string>(),
      resolveDrop: async (id: string) => {
        seenIds.push(id);
        return {
          content: `# ${id}`,
          metadata: {},
        };
      },
    };

    const makeBlock = (content: string) => ({
      id: "graph",
      args: null,
      start: 0,
      end: 100,
      content,
      info: "graph",
    });

    await handler(ctx, "id=1wrhjx8Wzk67", makeBlock("id=1wrhjx8Wzk67"));
    await handler(
      ctx,
      "https://nulldown.app/d/1wrhjx8Wzk67",
      makeBlock("https://nulldown.app/d/1wrhjx8Wzk67"),
    );

    expect(seenIds).toEqual(["1wrhjx8Wzk67", "1wrhjx8Wzk67"]);
  });
});
