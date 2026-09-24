import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { jest } from "@jest/globals";

const exec = promisify(execFile);
const sentinel = "@@MCP_GATEWAY_TEST@@";
jest.setTimeout(45_000);

const run = async (source: string) => {
  const { stdout } = await exec("bun", ["--no-env-file", "-e", source], {
    cwd: process.cwd(),
    timeout: 40_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const line = stdout.split("\n").find((line) => line.startsWith(sentinel));
  if (!line) {
    throw new Error("Missing integration result");
  }
  return JSON.parse(line.slice(sentinel.length));
};

describe("packaged stdio MCP gateway over disposable local HTTP", () => {
  it.each([
    { finalized: false, transportFails: true },
    { finalized: true, transportFails: true },
    { finalized: true, transportFails: false },
  ])(
    "tears down storage after close faults ($finalized, $transportFails)",
    async ({ finalized, transportFails }) => {
      const result = await run(`
        import { existsSync } from "node:fs";
        import { rm } from "node:fs/promises";
        import { Client } from "@modelcontextprotocol/sdk/client/index.js";
        import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
        import { createBenchMcpBridge } from "./src/benchmarks/memoryAgentBench/mcpBridge.ts";
        const bridge = await createBenchMcpBridge();
        if (${finalized}) {
          await bridge.ingest(0, "cleanup-test-token");
          await bridge.finalize();
        }

        // This isolated Bun process supplies the fault seam without production DI.
        const originalClientClose = Client.prototype.close;
        const originalTransportClose = StdioClientTransport.prototype.close;
        const order = [];
        Client.prototype.close = async function () {
          order.push("client");
          throw new Error("client-close-fault");
        };
        StdioClientTransport.prototype.close = async function () {
          order.push("transport");
          await originalTransportClose.call(this);
          order.push(existsSync(bridge.dataDir) ? "storage-present" : "storage-gone");
          if (${transportFails}) {
            throw new Error("transport-close-fault");
          }
        };
        try {
          const outcomes = await Promise.allSettled([bridge.close(), bridge.close()]);
          const repeated = await Promise.allSettled([bridge.close()]);
          const firstError = outcomes[0].reason;
          console.log(${JSON.stringify(sentinel)} + JSON.stringify({
            removed: !existsSync(bridge.dataDir),
            statuses: [...outcomes, ...repeated].map(outcome => outcome.status),
            sameError: outcomes[1].reason === firstError && repeated[0].reason === firstError,
            aggregate: firstError instanceof AggregateError,
            errors: firstError instanceof AggregateError
              ? firstError.errors.map(error => error.message)
              : [firstError.message],
            order,
          }));
        } finally {
          Client.prototype.close = originalClientClose;
          StdioClientTransport.prototype.close = originalTransportClose;
          await rm(bridge.dataDir, { recursive: true, force: true });
        }
        process.exit(0);
      `);
      expect(result).toEqual({
        removed: true,
        statuses: ["rejected", "rejected", "rejected"],
        sameError: true,
        aggregate: transportFails,
        errors: transportFails
          ? ["client-close-fault", "transport-close-fault"]
          : ["client-close-fault"],
        order: ["client", "transport", "storage-present"],
      });
    },
  );

  it("preserves startup and cleanup failures while still removing storage", async () => {
    const result = await run(`
      import { mkdtemp, readdir, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
      import { createBenchMcpBridge } from "./src/benchmarks/memoryAgentBench/mcpBridge.ts";
      const parent = await mkdtemp(join(tmpdir(), "mcp-gateway-close-fault-"));
      const originalStart = StdioClientTransport.prototype.start;
      const originalClose = StdioClientTransport.prototype.close;
      let closeAttempts = 0;
      StdioClientTransport.prototype.start = async function () {
        throw new Error("startup-fault");
      };
      StdioClientTransport.prototype.close = async function () {
        closeAttempts += 1;
        await originalClose.call(this);
        throw new Error("transport-close-fault");
      };
      try {
        let failure;
        try {
          await createBenchMcpBridge({ temporaryDirectory: parent });
        } catch (error) {
          failure = error;
        }
        const messages = error => error instanceof AggregateError
          ? error.errors.flatMap(messages)
          : [error.message];
        console.log(${JSON.stringify(sentinel)} + JSON.stringify({
          remaining: await readdir(parent),
          aggregate: failure instanceof AggregateError,
          messages: messages(failure),
          closeAttempts,
        }));
      } finally {
        StdioClientTransport.prototype.start = originalStart;
        StdioClientTransport.prototype.close = originalClose;
        await rm(parent, { recursive: true, force: true });
      }
      process.exit(0);
    `);
    expect(result.remaining).toEqual([]);
    expect(result.aggregate).toBe(true);
    expect(result.messages[0]).toBe("startup-fault");
    expect(result.messages.slice(1)).toContain("transport-close-fault");
    expect(result.closeAttempts).toBeGreaterThanOrEqual(1);
  });

  it("cleans storage after MCP child startup fails", async () => {
    const result = await run(`
      import { mkdtemp, readdir, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { createBenchMcpBridge } from "./src/benchmarks/memoryAgentBench/mcpBridge.ts";
      const parent = await mkdtemp(join(tmpdir(), "mcp-gateway-startup-"));
      try {
        let failed = false;
        try {
          await createBenchMcpBridge({
            temporaryDirectory: parent,
            executable: "/nonexistent/bench-mcp",
            executableArgs: [],
          });
        } catch {
          failed = true;
        }
        console.log(${JSON.stringify(sentinel)} + JSON.stringify({
          failed,
          remaining: await readdir(parent),
        }));
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    `);
    expect(result).toEqual({ failed: true, remaining: [] });
  });

  it("discovers actual schemas, retrieves original chunks, expires refs, and removes storage", async () => {
    const result = await run(`
      import { existsSync } from "node:fs";
      import { createBenchMcpBridge } from "./src/benchmarks/memoryAgentBench/mcpBridge.ts";
      process.env.ND_BASE_URL = "https://invalid.example";
      process.env.ND_TOKEN = "test-secret-never-forward";
      process.env.ND_AUTH_FILE = "/nonexistent/secret";
      const bridge = await createBenchMcpBridge();
      const sample = "nativeuniquetoken **original**\\n[link] 💠";
      let output;
      try {
        await bridge.ingest(0, sample);
        const finalized = await bridge.finalize();
        const gateway = bridge.gateway();
        gateway.beginQuestion();
        const query = await gateway.callTool("branch_query", {
          query: "nativeuniquetoken",
          top: 1,
        });
        const read = await gateway.callTool("source_read", {
          capability: query.items[0].capability,
        });
        gateway.beginQuestion();
        let expired = false;
        try {
          await gateway.callTool("source_read", {
            capability: query.items[0].capability,
          });
        } catch {
          expired = true;
        }
        output = {
          finalized,
          tools: gateway.listTools(),
          query,
          read,
          expired,
          traces: gateway.trace(),
        };
      } finally {
        await bridge.close();
      }
      console.log(${JSON.stringify(sentinel)} + JSON.stringify({
        ...output,
        removed: !existsSync(bridge.dataDir),
      }));
    `);
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "branch_query",
      "source_read",
    ]);
    expect(result.read.chunk).toBe("nativeuniquetoken **original**\n[link] 💠");
    expect(result.read.snapshotId).toBe(result.finalized.snapshotId);
    expect(result.expired).toBe(true);
    expect(result.removed).toBe(true);
    expect(JSON.stringify(result.traces)).not.toContain("test-secret");
  });

  it("fails closed on a real MCP truncation envelope", async () => {
    const result = await run(`
      import { createBenchMcpBridge } from "./src/benchmarks/memoryAgentBench/mcpBridge.ts";
      const bridge = await createBenchMcpBridge();
      try {
        for (let i = 0; i < 12; i++) {
          await bridge.ingest(i, "sharedtoken " + "x".repeat(3500) + i);
        }
        await bridge.finalize();
        const gateway = bridge.gateway();
        gateway.beginQuestion();
        let error;
        try {
          await gateway.callTool("branch_query", {
            query: "sharedtoken",
            top: 12,
          });
        } catch (caught) {
          error = caught.message;
        }
        const narrower = await gateway.callTool("branch_query", {
          query: "sharedtoken",
          top: 1,
        });
        console.log(${JSON.stringify(sentinel)} + JSON.stringify({
          error,
          narrower,
          traces: gateway.trace(),
        }));
      } finally {
        await bridge.close();
      }
    `);
    expect(result.error).toContain("narrower query");
    expect(result.traces[0].refs).toEqual([]);
    expect(result.narrower.items).toHaveLength(1);
  });

  it("keeps bridge stdout sentinel-only and requires an explicit question handshake", async () => {
    const result = await run(`
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "scripts/memory-agent-bench-mcp-bridge.ts",
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      const commands = [
        { op: "start" },
        { op: "ingest", index: 0, chunk: "bridgenativetoken" },
        { op: "finalize" },
        { op: "list_tools" },
        { op: "retrieve", query: "bridgenativetoken", topK: 1 },
        { op: "begin_question" },
        { op: "retrieve", query: "bridgenativetoken", topK: 1 },
        { op: "dispose" },
      ];
      child.stdin.write(
        commands.map(value => JSON.stringify(value)).join("\\n") + "\\n",
      );
      child.stdin.end();
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      const code = await child.exited;
      console.log(${JSON.stringify(sentinel)} + JSON.stringify({
        stdout,
        stderr,
        code,
      }));
    `);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(8);
    const frames = lines.map((line: string) => {
      expect(line.startsWith("@@NULLDOWN_MEMORY_AGENT_BENCH@@")).toBe(true);
      return JSON.parse(line.slice("@@NULLDOWN_MEMORY_AGENT_BENCH@@".length));
    });
    expect(frames.map((frame: { ok: boolean }) => frame.ok)).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
  });
});
