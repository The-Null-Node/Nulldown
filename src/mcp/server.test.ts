import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createNulldownMcpServer } from "./server";

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

describe("createNulldownMcpServer", () => {
  it("rejects invalid diff_apply input at the MCP boundary", async () => {
    const server = createNulldownMcpServer();
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
});
