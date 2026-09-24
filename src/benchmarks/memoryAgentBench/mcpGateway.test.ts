import { jest } from "@jest/globals";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { heapifyResolvedDocument } from "../../../shared/drop/resolved/heapify/document";
import { frameMemoryAgentBenchChunk } from "./framing";
import { createBenchMcpGateway, type BenchMcpBinding } from "./mcpGateway";

const schema: Tool = {
  name: "branch_query",
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(
      [
        "baseUrl",
        "accountId",
        "clientId",
        "rootId",
        "branchId",
        "snapshotId",
        "resolverId",
        "kind",
        "preview",
        "format",
        "maxTokens",
      ]
        .map((name) => [name, {}])
        .concat([
          ["query", { type: "string" }],
          ["top", { type: "integer", minimum: 1, maximum: 50 }],
        ]),
    ),
  },
};
const sample = "alpha **raw**\n[exact] 💠";

const setup = async () => {
  const binding: BenchMcpBinding = {
    baseUrl: "http://127.0.0.1:12345",
    accountId: "local-account",
    clientId: "local-client",
    rootDropId: "root",
    branchId: "branch",
    snapshotId: 1,
    content:
      "# Memory Agent Bench\n\n" + frameMemoryAgentBenchChunk(sample).sourceText,
  };
  const heap = await heapifyResolvedDocument({ ...binding });
  const payload = {
    rootDropId: binding.rootDropId,
    branchId: binding.branchId,
    snapshotId: binding.snapshotId,
    resolverId: heap.resolverId,
    sourceContentHash: heap.sourceContentHash,
    stale: false,
    nodes: (heap.documentNodes ?? [])
      .filter((node) => node.kind === "paragraph")
      .map((node) => ({ node, score: 1 })),
  };
  const client = {
    listTools: jest.fn(async () => ({
      tools: [
        schema,
        { name: "diff_apply", inputSchema: { type: "object" as const } },
      ],
    })),
    callTool: jest.fn(async (_input: unknown): Promise<unknown> => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    })),
    close: jest.fn(async () => undefined),
  };
  const gateway = await createBenchMcpGateway(client, binding);
  gateway.beginQuestion();
  return { gateway, client, binding, payload };
};

describe("native MCP gateway", () => {
  it("discovers only search fields, injects frozen identity, and reads the exact decoded source", async () => {
    const { gateway, client, binding } = await setup();
    expect(gateway.listTools().map((tool) => tool.name)).toEqual([
      "branch_query",
      "source_read",
    ]);
    expect(Object.keys(gateway.listTools()[0].inputSchema.properties!)).toEqual([
      "query",
      "top",
    ]);
    const result = await gateway.callTool("branch_query", {
      query: "alpha",
      top: 2,
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "branch_query",
      arguments: {
        query: "alpha",
        top: 2,
        baseUrl: binding.baseUrl,
        accountId: binding.accountId,
        clientId: binding.clientId,
        rootId: "root",
        branchId: "branch",
        snapshotId: 1,
        resolverId: "nulldown.resolved.document",
        kind: "paragraph",
        preview: false,
        format: "full",
        maxTokens: 8000,
      },
    });
    if (!("items" in result)) {
      throw new Error("Expected query");
    }
    expect(result.items[0].previewOnly).toBe(true);
    expect(
      await gateway.callTool("source_read", {
        capability: result.items[0].capability,
      }),
    ).toMatchObject({
      chunk: sample,
      rootDropId: "root",
      branchId: "branch",
      snapshotId: 1,
      remainingCalls: 4,
    });
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(gateway.trace())).not.toContain("raw");
    await gateway.close();
    await gateway.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    "baseUrl",
    "accountId",
    "clientId",
    "rootId",
    "rootDropId",
    "branchId",
    "snapshotId",
    "resolverId",
    "snapshotterId",
    "sourceRange",
    "range",
    "preview",
    "format",
    "maxTokens",
    "__proto__",
  ])("rejects supplied %s before transport", async (key) => {
    const { gateway, client } = await setup();
    await expect(
      gateway.callTool("branch_query", {
        query: "alpha",
        top: 1,
        [key]: "override",
      }),
    ).rejects.toThrow("Unsupported");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it.each([
    "diff_apply",
    "drop_create",
    "branch_resolve",
    "branch_content",
    "strategy_search",
    "memory_query",
    "begin_question",
    "unknown",
  ])("disallows %s before transport", async (name) => {
    const { gateway, client } = await setup();
    await expect(gateway.callTool(name, {})).rejects.toThrow("not allowed");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it.each([
    { query: { baseUrl: "https://example.test" }, top: 1 },
    { query: "alpha", top: { snapshotId: 2 } },
    { query: "", top: 1 },
    { query: "alpha", top: 51 },
    { query: "alpha", top: 1, nested: { branchId: "other" } },
  ])("rejects nested or invalid arguments", async (args) => {
    const { gateway, client } = await setup();
    await expect(gateway.callTool("branch_query", args)).rejects.toThrow();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("expires capabilities at each host-only question boundary and enforces six total attempts", async () => {
    const { gateway, client } = await setup();
    const query = await gateway.callTool("branch_query", {
      query: "alpha",
      top: 1,
    });
    if (!("items" in query)) {
      throw new Error("Expected query");
    }
    const capability = query.items[0].capability;
    await expect(
      gateway.callTool("source_read", {
        capability,
        range: { start: 0, end: 100 },
      }),
    ).rejects.toThrow("Unsupported");
    gateway.beginQuestion();
    await expect(
      gateway.callTool("source_read", { capability }),
    ).rejects.toThrow("expired");
    for (let i = 0; i < 5; i++) {
      await expect(gateway.callTool("diff_apply", {})).rejects.toThrow();
    }
    await expect(
      gateway.callTool("branch_query", { query: "alpha", top: 1 }),
    ).rejects.toThrow("budget");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it.each([
    "rootDropId",
    "branchId",
    "snapshotId",
    "sourceContentHash",
    "resolverId",
    "stale",
  ])("rejects mismatched %s", async (field) => {
    const { gateway, payload } = await setup();
    Object.assign(payload, { [field]: "wrong" });
    await expect(
      gateway.callTool("branch_query", { query: "alpha", top: 1 }),
    ).rejects.toThrow("identity");
  });

  it.each(["id", "sourceHash", "text", "sourceRange", "kind"])(
    "rejects corrupted node %s without issuing refs",
    async (field) => {
      const { gateway, payload } = await setup();
      Object.assign(payload.nodes[0].node, {
        [field]: field === "sourceRange" ? { start: 0, end: 10 } : "wrong",
      });
      await expect(
        gateway.callTool("branch_query", { query: "alpha", top: 1 }),
      ).rejects.toThrow("source node");
      expect(gateway.trace()[0].refs).toEqual([]);
    },
  );

  it.each([
    { truncated: true, preview: "secret" },
    { partial: true },
    { content: [] },
  ])("fails closed on incomplete results", async (payload) => {
    const { gateway, client } = await setup();
    client.callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });
    await expect(
      gateway.callTool("branch_query", { query: "alpha", top: 1 }),
    ).rejects.toThrow();
    expect(gateway.trace()[0].refs).toEqual([]);
    expect(JSON.stringify(gateway.trace())).not.toContain("secret");
  });

  it("sanitizes transport errors and forbids concurrent reset", async () => {
    const { gateway, client } = await setup();
    let reject!: (error: Error) => void;
    client.callTool.mockImplementation(
      () => new Promise((_resolve, reject_) => {
        reject = reject_;
      }),
    );
    const pending = gateway.callTool("branch_query", {
      query: "secret query",
      top: 1,
    });
    expect(() => gateway.beginQuestion()).toThrow("unavailable");
    reject(new Error("Bearer secret"));
    await expect(pending).rejects.toThrow("Gateway query failed");
    expect(JSON.stringify(gateway.trace())).not.toContain("secret");
  });

  it("rejects capabilities from another run and cannot mutate stored refs via returned objects", async () => {
    const left = await setup();
    const right = await setup();
    const query = await left.gateway.callTool("branch_query", {
      query: "alpha",
      top: 1,
    });
    if (!("items" in query)) {
      throw new Error("Expected query");
    }
    const item = query.items[0];
    const start = item.sourceRange.start;
    item.sourceRange.start = 0;
    await expect(
      right.gateway.callTool("source_read", { capability: item.capability }),
    ).rejects.toThrow("expired");
    const read = await left.gateway.callTool("source_read", {
      capability: item.capability,
    });
    expect(read).toMatchObject({ sourceRange: { start }, chunk: sample });
    expect(right.client.callTool).not.toHaveBeenCalled();
  });

  it("rejects missing discovered schemas and nonlocal bindings", async () => {
    const { client, binding } = await setup();
    client.listTools.mockResolvedValue({ tools: [] });
    await expect(createBenchMcpGateway(client, binding)).rejects.toThrow(
      "discovery",
    );
    await expect(
      createBenchMcpGateway(client, {
        ...binding,
        baseUrl: "https://nulldown.app",
      }),
    ).rejects.toThrow("loopback");
  });
});
