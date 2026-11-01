import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNulldownMcpServer } from "../../packages/nulldown-mcp/src/server";

/** One managed acceptance subprocess's real MCP protocol session over the loopback application. */
export async function createApplicationMcpClient(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
) {
  const original = globalThis.fetch;
  process.env.ND_TOKEN = token ?? "";
  process.env.ND_MCP_LOG_LEVEL = "silent";
  globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(
        url.origin,
        new URL(baseUrl).origin,
        "MCP HTTP stays on the fixture origin",
      );
      return fetchImpl(input, init);
    },
    {
      preconnect: () => {
        throw Error("HOST_NETWORK_DISABLED");
      },
    },
  );
  const server = createNulldownMcpServer();
  const client = new Client({ name: "application-acceptance", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    list: () => client.listTools(),
    async call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({
        name,
        arguments: { ...args, baseUrl },
      });
      const content = result.content as { type: string; text?: string }[];
      const text = content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (result.isError) throw Error(`MCP_TOOL_ERROR: ${text}`);
      return JSON.parse(text) as unknown;
    },
    async close() {
      await Promise.all([client.close(), server.close()]);
      globalThis.fetch = original;
      delete process.env.ND_TOKEN;
    },
  };
}
