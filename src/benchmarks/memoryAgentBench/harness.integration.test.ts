import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { jest } from "@jest/globals";

const execFileAsync = promisify(execFile);
const resultSentinel = "@@MEMORY_AGENT_BENCH_INTEGRATION@@";
const bridgeSentinel = "@@NULLDOWN_MEMORY_AGENT_BENCH@@";

jest.setTimeout(30_000);

const runInBun = async <T>(source: string): Promise<T> => {
  const { stdout } = await execFileAsync("bun", ["-e", source], {
    cwd: process.cwd(),
    maxBuffer: 4 * 1024 * 1024,
  });
  const result = stdout
    .split("\n")
    .find((line) => line.startsWith(resultSentinel));
  if (!result) {
    throw new Error(`Bun integration result missing from: ${stdout}`);
  }
  return JSON.parse(result.slice(resultSentinel.length)) as T;
};

const runBridge = async (
  commands: readonly Record<string, unknown>[],
): Promise<{
  stdout: string;
  stderr: string;
  frames: Array<Record<string, unknown>>;
}> => {
  const child = spawn("bun", ["run", "scripts/memory-agent-bench-bridge.ts"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const commandLines = commands.map((command) => JSON.stringify(command)).join("\n");
  child.stdin.end(`${commandLines}\n`);
  const exitCode = await closed;
  if (exitCode !== 0) {
    throw new Error(`Bridge exited with ${exitCode}: ${stderr}`);
  }
  const lines = stdout.split("\n").filter(Boolean);
  const frames = lines.map((line) => {
    if (!line.startsWith(bridgeSentinel)) {
      throw new Error(`Non-protocol bridge stdout: ${line}`);
    }
    return JSON.parse(line.slice(bridgeSentinel.length)) as Record<string, unknown>;
  });
  return { stdout, stderr, frames };
};

describe("local MemoryAgentBench runtime", () => {
  it("persists accepted chunks across restart with exact decoded retrieval", async () => {
    const result = await runInBun<{
      accepted: unknown;
      finalized: unknown;
      queried: {
        chunks: string[];
        constructionTiming: { elapsedMs: number };
        retrievalTiming: { elapsedMs: number };
      };
    }>(`
      import { createLocalMemoryAgentBenchRuntime } from "./src/benchmarks/memoryAgentBench/localRuntime.ts";
      const runtime = await createLocalMemoryAgentBenchRuntime();
      try {
        const run = await runtime.createRun();
        const sample = "durable unique-token-alpha with **Markdown**\\nand [link](https://example.test)";
        const accepted = await run.ingest(0, sample);
        await runtime.restart();
        const finalized = await run.finalize();
        const queried = await run.retrieve("unique token alpha", 5);
        console.log(${JSON.stringify(resultSentinel)} + JSON.stringify({ accepted, finalized, queried }));
      } finally {
        await runtime.close();
      }
    `);

    expect(result.accepted).toMatchObject({
      status: "accepted",
      followsSeq: -1,
      sequence: 0,
      snapshotId: 1,
    });
    expect(result.finalized).toMatchObject({ finalEventSequence: 0, snapshotId: 1 });
    expect(result.queried.chunks).toEqual([
      "durable unique-token-alpha with **Markdown**\nand [link](https://example.test)",
    ]);
    expect(result.queried.constructionTiming.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.queried.retrievalTiming.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("isolates two runs by filesystem, server, root, branch, and unique token", async () => {
    const result = await runInBun<{
      identities: string[];
      leftOwn: string[];
      leftOther: string[];
      rightOwn: string[];
    }>(`
      import { createLocalMemoryAgentBenchRuntime } from "./src/benchmarks/memoryAgentBench/localRuntime.ts";
      const left = await createLocalMemoryAgentBenchRuntime();
      const right = await createLocalMemoryAgentBenchRuntime();
      try {
        const leftRun = await left.createRun();
        const rightRun = await right.createRun();
        await leftRun.ingest(0, "leftuniquetokenalpha datum");
        await rightRun.ingest(0, "rightuniquetokenbeta datum");
        await leftRun.finalize();
        await rightRun.finalize();
        const leftOwn = (await leftRun.retrieve("leftuniquetokenalpha", 5)).chunks;
        const leftOther = (await leftRun.retrieve("rightuniquetokenbeta", 5)).chunks;
        const rightOwn = (await rightRun.retrieve("rightuniquetokenbeta", 5)).chunks;
        console.log(${JSON.stringify(resultSentinel)} + JSON.stringify({
          identities: [left.dataDir, right.dataDir, left.baseUrl, right.baseUrl,
            leftRun.rootDropId, rightRun.rootDropId, leftRun.branchId, rightRun.branchId],
          leftOwn, leftOther, rightOwn,
        }));
      } finally {
        await left.close();
        await right.close();
      }
    `);

    for (let index = 0; index < result.identities.length; index += 2) {
      expect(result.identities[index]).not.toBe(result.identities[index + 1]);
    }
    expect(result.leftOwn).toEqual(["leftuniquetokenalpha datum"]);
    expect(result.leftOther).toEqual([]);
    expect(result.rightOwn).toEqual(["rightuniquetokenbeta datum"]);
  });

  it("removes its unique filesystem after a partial startup failure", async () => {
    const parent = await mkdtemp(join(tmpdir(), "nulldown-memory-agent-parent-"));
    try {
      const result = await runInBun<{
        afterFailure: string[];
        closedPathExists: boolean;
      }>(`
        import { existsSync } from "node:fs";
        import { readdir } from "node:fs/promises";
        import { createLocalMemoryAgentBenchRuntime } from "./src/benchmarks/memoryAgentBench/localRuntime.ts";
        const parent = ${JSON.stringify(parent)};
        try {
          await createLocalMemoryAgentBenchRuntime({
            temporaryDirectory: parent,
            serve() {
              throw new Error("listener failed");
            },
          });
          throw new Error("startup unexpectedly succeeded");
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "listener failed") {
            throw error;
          }
        }
        const afterFailure = await readdir(parent);
        const runtime = await createLocalMemoryAgentBenchRuntime({ temporaryDirectory: parent });
        const dataDir = runtime.dataDir;
        await runtime.close();
        console.log(${JSON.stringify(resultSentinel)} + JSON.stringify({
          afterFailure,
          closedPathExists: existsSync(dataDir),
        }));
      `);

      expect(result.afterFailure).toEqual([]);
      expect(result.closedPathExists).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects an unknown bridge operation with a sentinel error frame", async () => {
    const result = await runBridge([{ op: "unknown-operation" }]);

    expect(result.frames).toEqual([
      {
        ok: false,
        error: "unknown operation: unknown-operation",
      },
    ]);
    expect(result.stderr).toContain(
      "MemoryAgentBench bridge error: unknown operation: unknown-operation",
    );
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("runs the sentinel-only bridge lifecycle with exact retrieval", async () => {
    const sample = "bridge-exact-token with **raw Markdown**";
    const result = await runBridge([
      { op: "start" },
      { op: "ingest", index: 0, chunk: sample },
      { op: "finalize" },
      { op: "retrieve", query: "bridge exact token", topK: 5 },
      { op: "dispose" },
    ]);

    expect(result.stderr).toBe("");
    expect(result.frames).toHaveLength(5);
    expect(result.frames.map((frame) => frame.op)).toEqual([
      "start",
      "ingest",
      "finalize",
      "retrieve",
      "dispose",
    ]);
    expect(result.frames.every((frame) => frame.ok === true)).toBe(true);
    expect(result.frames[1]).toMatchObject({
      receipt: { status: "accepted", sequence: 0, snapshotId: 1 },
    });
    expect(result.frames[2]).toMatchObject({
      result: { finalEventSequence: 0, snapshotId: 1 },
    });
    expect(result.frames[3]).toMatchObject({
      result: { chunks: [sample] },
    });
    expect(result.frames[4]).toMatchObject({ disposed: true });
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      expect(line.startsWith(bridgeSentinel)).toBe(true);
    }
  });
});
