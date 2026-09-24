import { createInterface } from "node:readline";
import { createBenchMcpBridge } from "../src/benchmarks/memoryAgentBench/mcpBridge";

const SENTINEL = "@@NULLDOWN_MEMORY_AGENT_BENCH@@";
let bridge: Awaited<ReturnType<typeof createBenchMcpBridge>> | null = null;
const required = () => {
  if (!bridge) {
    throw new Error("Start the native bridge first.");
  }
  return bridge;
};
const dispose = async () => {
  await bridge?.close();
  bridge = null;
};
const execute = async (value: unknown): Promise<Record<string, unknown>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid command.");
  }
  const command = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    start: [],
    ingest: ["index", "chunk"],
    finalize: [],
    list_tools: [],
    begin_question: [],
    call_tool: ["name", "arguments"],
    retrieve: ["query", "topK"],
    trace: [],
    dispose: [],
  };
  if (
    typeof command.op !== "string" ||
    !Object.hasOwn(fields, command.op) ||
    Object.keys(command).some(
      (key) => key !== "op" && !fields[command.op as string].includes(key),
    )
  ) {
    throw new Error("Invalid command.");
  }
  switch (command.op) {
    case "start":
      if (bridge) {
        throw new Error("Bridge already started.");
      }
      bridge = await createBenchMcpBridge();
      return { rootDropId: bridge.rootDropId, branchId: bridge.branchId };
    case "ingest":
      if (!Number.isInteger(command.index) || typeof command.chunk !== "string") {
        throw new Error("Invalid ingest.");
      }
      return {
        receipt: await required().ingest(Number(command.index), command.chunk),
      };
    case "finalize":
      return { result: await required().finalize() };
    case "list_tools":
      return { tools: required().gateway().listTools() };
    case "begin_question":
      return required().gateway().beginQuestion();
    case "retrieve":
      return {
        result: await required().gateway().callTool("branch_query", {
          query: command.query,
          top: command.topK,
        }),
      };
    case "call_tool":
      if (typeof command.name !== "string") {
        throw new Error("Invalid tool name.");
      }
      return {
        result: await required().gateway().callTool(command.name, command.arguments),
      };
    case "trace":
      return { traces: required().gateway().trace() };
    case "dispose":
      await dispose();
      return { disposed: true };
    default:
      throw new Error("Invalid command.");
  }
};

const input = createInterface({ input: process.stdin, terminal: false });
try {
  for await (const line of input) {
    if (!line.trim()) continue;
    let frame: Record<string, unknown>;
    try {
      const command = JSON.parse(line);
      frame = {
        ok: true,
        op: command.op,
        ...await execute(command),
      };
    } catch {
      // Detailed, sanitized tool failures remain available through the host-only trace operation.
      frame = {
        ok: false,
        error:
          "Native bridge operation failed; check lifecycle, arguments and budget. For incomplete results, use a narrower query.",
      };
    }
    process.stdout.write(`${SENTINEL}${JSON.stringify(frame)}\n`);
  }
} finally {
  await dispose();
}
