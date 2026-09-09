import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer as createHttpServer, type Server } from "node:http";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createNulldownMcpServer } from "./server";
import { createNulldownMcpServer as createPackagedNulldownMcpServer } from "../../packages/nulldown-mcp/src/server";

class LoopbackTransport implements Transport {
  peer?: LoopbackTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

const createTransportPair = () => {
  const clientTransport = new LoopbackTransport();
  const serverTransport = new LoopbackTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;
  return { clientTransport, serverTransport };
};

const listen = async (
  handler: Parameters<typeof createHttpServer>[0],
): Promise<{ server: Server; baseUrl: string }> => {
  const server = createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local test address.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const serverFactories = [
  ["source", createNulldownMcpServer],
  ["package", createPackagedNulldownMcpServer],
] as const;

describe.each(serverFactories)("%s createNulldownMcpServer", (_name, createServer) => {
  it("rejects invalid diff_apply input at the MCP boundary", async () => {
    const server = createServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "diff_apply",
        arguments: {
          dropId: "root-drop",
          ops: [
            {
              native: {
                op: 999,
                data: "not-base64",
              },
            },
          ],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("Input validation error");
      expect(result.content[0]?.text).toContain("diff_apply");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    { eventId: "retry-1" },
    { createdAt: 1 },
    { eventId: " retry-1", createdAt: 1 },
  ])("rejects invalid retry identity at the MCP boundary", async (identity) => {
    const server = createServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "diff_apply",
        arguments: {
          dropId: "root-drop",
          ops: [{ type: "insert", start: 0, end: 0, text: "hello" }],
          ...identity,
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("Input validation error");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("forwards a complete retry identity", async () => {
    let postedBody: unknown;
    const api = await listen((request, response) => {
      if (request.method !== "POST" || request.url !== "/api/diff/root-drop?branchId=branch-1") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          accepted: 1,
          deduplicated: 0,
          branchId: "branch-1",
          snapshotId: 1,
          totalStored: 1,
          acknowledgements: [
            { eventId: "retry-1", seq: 0, snapshotId: 1, status: "accepted" },
          ],
        }));
      });
    });
    const server = createServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "diff_apply",
        arguments: {
          baseUrl: api.baseUrl,
          dropId: "root-drop",
          branchId: "branch-1",
          eventId: "retry-1",
          createdAt: 1_725_000_000_000,
          ops: [{ type: "insert", start: 0, end: 0, text: "hello" }],
        },
      });

      expect(result.isError).toBeFalsy();
      expect(postedBody).toEqual({
        version: 1,
        events: [
          expect.objectContaining({ eventId: "retry-1", createdAt: 1_725_000_000_000 }),
        ],
      });
    } finally {
      await client.close();
      await server.close();
      await new Promise<void>((resolve, reject) =>
        api.server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });
});
