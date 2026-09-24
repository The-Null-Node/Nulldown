import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createNulldownClient } from "../../client/nulldownClient";
import { createMemoryAgentBenchRun } from "./harness";
import { createLocalMemoryAgentBenchRuntime } from "./localRuntime";
import { createBenchMcpGateway, type BenchMcpGateway } from "./mcpGateway";

/** Host-only process options; never exposed to the planner or accepted over call_tool. */
export interface BenchMcpBridgeOptions {
  temporaryDirectory?: string;
  executable?: string;
  executableArgs?: string[];
}

/** Owns one disposable runtime and one clean-environment packaged stdio MCP child. */
export const createBenchMcpBridge = async (options: BenchMcpBridgeOptions = {}) => {
  const runtime = await createLocalMemoryAgentBenchRuntime({
    temporaryDirectory: options.temporaryDirectory,
  });
  // Use an explicit credential-free client; the frozen runtime's default client may inherit ND_TOKEN.
  const accountId = `memory-agent-bench-${randomUUID()}`;
  const clientId = `memory-agent-bench-${randomUUID()}`;
  const http = createNulldownClient({
    baseUrl: runtime.baseUrl,
    accountId,
    clientId,
    token: null,
    diffAuthToken: null,
    diffWebhookSecret: null,
  });
  const client = new Client({ name: "memory-agent-bench-native", version: "1.0.0" });
  const packageDir = dirname(
    fileURLToPath(import.meta.resolve("@thenullnode/nulldown-mcp/package.json")),
  );
  const executable = options.executable
    ? resolve(options.executable)
    : process.execPath;
  const args = options.executableArgs ?? [
    "--no-env-file",
    join(packageDir, "bin/nulldown-mcp.ts"),
  ];
  // SDK merges a small inherited environment. env -i removes even that before Bun starts.
  const transport = new StdioClientTransport({
    command: "/usr/bin/env",
    args: [
      "-i",
      `HOME=${runtime.dataDir}`,
      `TMPDIR=${runtime.dataDir}`,
      "PATH=/usr/bin:/bin",
      "ND_MCP_LOG_LEVEL=silent",
      executable,
      ...args,
    ],
    cwd: runtime.dataDir,
    stderr: "pipe",
  });
  // Drain, but never copy untrusted child logs (which may contain credentials) into benchmark traces.
  transport.stderr?.on("data", () => undefined);
  let gateway: BenchMcpGateway | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const releaseResources = async (): Promise<void> => {
    const errors: unknown[] = [];
    // Always attempt every stage, including partially connected children.
    // Keep transport teardown ahead of SQLite/listener/storage teardown.
    for (const release of [
      () => gateway ? gateway.close() : client.close(),
      () => transport.close(),
      () => runtime.close(),
    ]) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Native bridge cleanup failed.");
    }
  };

  const close = (): Promise<void> => {
    // Concurrent and later callers observe the same complete cleanup outcome.
    if (!closePromise) {
      closed = true;
      closePromise = releaseResources();
    }
    return closePromise;
  };
  try {
    const run = await createMemoryAgentBenchRun({ client: http });
    await client.connect(transport);
    return {
      rootDropId: run.rootDropId,
      branchId: run.branchId,
      dataDir: runtime.dataDir,
      ingest: async (index: number, chunk: string) => {
        if (closed) {
          throw new Error("Bridge closed.");
        }
        return run.ingest(index, chunk);
      },
      async finalize() {
        if (closed) {
          throw new Error("Bridge closed.");
        }
        const result = await run.finalize();
        const source = await http.getBranchContent(run.rootDropId, run.branchId);
        if (
          !source ||
          typeof source !== "object" ||
          !("rootDropId" in source) ||
          !("branchId" in source) ||
          !("snapshotId" in source) ||
          !("content" in source) ||
          typeof source.content !== "string" ||
          source.rootDropId !== result.rootDropId ||
          source.branchId !== result.branchId ||
          source.snapshotId !== result.snapshotId
        ) {
          throw new Error("Final source identity mismatch.");
        }
        gateway = await createBenchMcpGateway(client, {
          baseUrl: runtime.baseUrl,
          accountId,
          clientId,
          ...result,
          content: source.content,
        });
        const finalizedAtMs = performance.now();
        return {
          ...result,
          constructionTiming: {
            ...result.constructionTiming,
            finalizedAtMs,
            elapsedMs: finalizedAtMs - result.constructionTiming.startedAtMs,
          },
        };
      },
      gateway() {
        if (closed || !gateway) {
          throw new Error("Finalize before using the gateway.");
        }
        return gateway;
      },
      close,
    };
  } catch (startupError) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Native bridge startup and cleanup failed.",
      );
    }
    throw new Error("Native bridge startup failed.", { cause: startupError });
  }
};
