import { createInterface } from "node:readline";
import {
  createLocalMemoryAgentBenchRuntime,
  type LocalMemoryAgentBenchRuntime,
} from "../src/benchmarks/memoryAgentBench/localRuntime";
import type { MemoryAgentBenchRun } from "../src/benchmarks/memoryAgentBench/types";

const SENTINEL = "@@NULLDOWN_MEMORY_AGENT_BENCH@@";

type Command =
  | { op: "start" }
  | { op: "ingest"; index: number; chunk: string }
  | { op: "finalize" }
  | { op: "retrieve"; query: string; topK: number }
  | { op: "dispose" };

const operations = new Set<Command["op"]>([
  "start",
  "ingest",
  "finalize",
  "retrieve",
  "dispose",
]);

let runtime: LocalMemoryAgentBenchRuntime | null = null;
let run: MemoryAgentBenchRun | null = null;

const writeFrame = (value: unknown): void => {
  process.stdout.write(`${SENTINEL}${JSON.stringify(value)}\n`);
};

const requireRun = (): MemoryAgentBenchRun => {
  if (!run) {
    throw new Error("start must be called before this operation");
  }
  return run;
};

const dispose = async (): Promise<void> => {
  const activeRuntime = runtime;
  runtime = null;
  run = null;
  await activeRuntime?.close();
};

const execute = async (command: Command): Promise<unknown> => {
  switch (command.op) {
    case "start":
      if (runtime) {
        throw new Error("bridge context is already started");
      }
      runtime = await createLocalMemoryAgentBenchRuntime();
      run = await runtime.createRun();
      return { op: "start", rootDropId: run.rootDropId, branchId: run.branchId };
    case "ingest":
      return {
        op: "ingest",
        receipt: await requireRun().ingest(command.index, command.chunk),
      };
    case "finalize":
      return { op: "finalize", result: await requireRun().finalize() };
    case "retrieve":
      return {
        op: "retrieve",
        result: await requireRun().retrieve(command.query, command.topK),
      };
    case "dispose":
      await dispose();
      return { op: "dispose", disposed: true };
  }
};

const input = createInterface({ input: process.stdin, terminal: false });

try {
  // Await each command so piped lifecycle operations cannot overtake one another.
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const command = JSON.parse(line) as Command;
      if (
        !command ||
        typeof command !== "object" ||
        typeof command.op !== "string"
      ) {
        throw new Error("invalid command");
      }
      if (!operations.has(command.op)) {
        throw new Error(`unknown operation: ${command.op}`);
      }
      const result = await execute(command);
      writeFrame({ ok: true, ...(result as object) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`MemoryAgentBench bridge error: ${message}\n`);
      writeFrame({ ok: false, error: message });
    }
  }
} finally {
  await dispose();
}
