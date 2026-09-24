import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../../shared/drop/resolved/constants";
import { hashMarkdownSource } from "../../../shared/drop/resolved/hash";
import { heapifyResolvedDocument } from "../../../shared/drop/resolved/heapify/document";
import { decodeMemoryAgentBenchChunk } from "./framing";

/** Minimal SDK boundary, also used by deterministic transport tests. */
export interface BenchMcpClient {
  listTools(): Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

/** Host-owned immutable identity; never accepted from model arguments. */
export interface BenchMcpBinding {
  baseUrl: string;
  accountId: string;
  clientId: string;
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  content: string;
}

interface SourceRef {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  nodeId: string;
  sourceRange: { start: number; end: number };
  sourceContentHash: string;
}

interface Capability extends SourceRef {
  chunk: string;
}

/** Sanitized trace deliberately omits queries, arguments, source text and transport errors. */
export interface BenchMcpTrace {
  question: number;
  call: number;
  tool: "branch_query" | "source_read" | "rejected";
  elapsedMs: number;
  remainingCalls: number;
  status: string;
  refs: SourceRef[];
}

class GatewayError extends Error {}
const fail = (message: string): never => {
  throw new GatewayError(message);
};

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("Invalid object.");
  }
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, keys: string[]): void => {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    fail("Unsupported argument.");
  }
};

const parseResult = (value: unknown): Record<string, unknown> => {
  const result = record(value);
  if (result.isError) {
    fail("MCP query failed.");
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    return fail("Incomplete MCP response; use a narrower query.");
  }
  const block = record(result.content[0]);
  if (block.type !== "text" || typeof block.text !== "string") {
    fail("Invalid MCP response.");
  }
  const parsed = record(JSON.parse(block.text as string));
  if (parsed.truncated || parsed.partial || parsed.preview || parsed.nextCursor) {
    fail("Incomplete MCP response; use a narrower query.");
  }
  return parsed;
};

/** Creates the question-scoped read-only gateway after finalization and real tools/list discovery. */
export const createBenchMcpGateway = async (
  client: BenchMcpClient,
  input: BenchMcpBinding,
) => {
  const binding = { ...input };
  const url = new URL(binding.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    fail("A disposable loopback HTTP endpoint is required.");
  }
  if (
    !binding.accountId ||
    !binding.clientId ||
    !binding.rootDropId ||
    !binding.branchId ||
    !Number.isInteger(binding.snapshotId) ||
    binding.snapshotId < 0
  ) {
    fail("Invalid binding.");
  }
  const discovery = await client.listTools();
  const discovered = discovery.tools.filter((tool) => tool.name === "branch_query");
  if (discovery.nextCursor || discovered.length !== 1) {
    fail("Incomplete MCP tool discovery.");
  }
  const properties = discovered[0].inputSchema.properties ?? {};
  for (const name of [
    "query",
    "top",
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
  ]) {
    if (!(name in properties)) {
      fail("Unsupported MCP query schema.");
    }
  }
  // Copy only the discovered primitive query fields. Routing and response controls are host-owned.
  const querySchema = record(properties.query);
  const topSchema = record(properties.top);
  if (
    querySchema.type !== "string" ||
    topSchema.type !== "integer" ||
    topSchema.minimum !== 1 ||
    topSchema.maximum !== 50
  ) {
    fail("Unsupported MCP query schema.");
  }
  const tools: Tool[] = [
    {
      name: "branch_query",
      description:
        "Search raw source chunks. Incomplete results require a narrower query. Read exact chunks with source_read.",
      inputSchema: {
        type: "object",
        properties: {
          query: { ...querySchema, minLength: 1 },
          top: { ...topSchema },
        },
        required: ["query", "top"],
        additionalProperties: false,
      },
    },
    {
      name: "source_read",
      description:
        "Read one exact original chunk using a capability issued by branch_query in this question.",
      inputSchema: {
        type: "object",
        properties: { capability: { type: "string" } },
        required: ["capability"],
        additionalProperties: false,
      },
    },
  ];
  const sourceContentHash = await hashMarkdownSource(binding.content);
  // Validate query refs against the immutable finalized source, not model-supplied ranges.
  const heap = await heapifyResolvedDocument({
    rootDropId: binding.rootDropId,
    branchId: binding.branchId,
    snapshotId: binding.snapshotId,
    content: binding.content,
  });
  const nodes = new Map(
    (heap.documentNodes ?? [])
      .filter((node) => node.kind === "paragraph")
      .map((node) => [node.id, node]),
  );
  const capabilities = new Map<string, Capability>();
  const traces: BenchMcpTrace[] = [];
  let question = 0;
  let calls = 0;
  let busy = false;
  let closed = false;

  const gateway = {
    listTools: () => structuredClone(tools),
    /** Host-only boundary: not a model tool; invalidates every previous capability. */
    beginQuestion() {
      if (closed || busy) {
        fail("Gateway unavailable.");
      }
      capabilities.clear();
      calls = 0;
      question += 1;
      return { question, remainingCalls: 6 };
    },
    trace: () => structuredClone(traces),
    async callTool(name: string, args: unknown) {
      if (closed || busy || question === 0) {
        fail("Begin a question before calling tools; calls must be sequential.");
      }
      if (calls >= 6) {
        fail("Question tool budget exhausted.");
      }
      calls += 1;
      busy = true;
      const started = performance.now();
      const trace: BenchMcpTrace = {
        question,
        call: calls,
        tool:
          name === "branch_query" || name === "source_read" ? name : "rejected",
        elapsedMs: 0,
        remainingCalls: 6 - calls,
        status: "ok",
        refs: [],
      };
      try {
        const arguments_ = record(args);
        if (name === "source_read") {
          exactKeys(arguments_, ["capability"]);
          const cap =
            typeof arguments_.capability === "string"
              ? capabilities.get(arguments_.capability)
              : undefined;
          if (!cap) {
            fail("Unknown or expired source capability.");
          }
          const { chunk, ...ref } = cap!;
          trace.refs.push(ref);
          return structuredClone({ ...ref, chunk, remainingCalls: 6 - calls });
        }
        if (name !== "branch_query") {
          fail("Tool not allowed.");
        }
        exactKeys(arguments_, ["query", "top"]);
        if (
          typeof arguments_.query !== "string" ||
          !arguments_.query.trim() ||
          arguments_.query.length > 4000 ||
          !Number.isInteger(arguments_.top) ||
          Number(arguments_.top) < 1 ||
          Number(arguments_.top) > 50
        ) {
          fail("Expected a nonempty query and integer top from 1 through 50.");
        }
        const result = parseResult(
          await client.callTool({
            name: "branch_query",
            arguments: {
              query: arguments_.query,
              top: arguments_.top,
              baseUrl: binding.baseUrl,
              accountId: binding.accountId,
              clientId: binding.clientId,
              rootId: binding.rootDropId,
              branchId: binding.branchId,
              snapshotId: binding.snapshotId,
              resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
              kind: "paragraph",
              preview: false,
              format: "full",
              maxTokens: 8000,
            },
          }),
        );
        if (
          result.rootDropId !== binding.rootDropId ||
          result.branchId !== binding.branchId ||
          result.snapshotId !== binding.snapshotId ||
          result.resolverId !== RESOLVED_DOCUMENT_RESOLVER_ID ||
          result.sourceContentHash !== sourceContentHash ||
          result.stale !== false
        ) {
          fail("Query source identity mismatch.");
        }
        if (
          !Array.isArray(result.nodes) ||
          result.nodes.length > Number(arguments_.top)
        ) {
          return fail("Incomplete MCP response; use a narrower query.");
        }
        // Validate the entire response before issuing any capabilities.
        const pending = result.nodes.map((entry) => {
          const item = record(entry);
          const node = record(item.node);
          const range = record(node.sourceRange);
          const exact = nodes.get(String(node.id));
          if (
            !exact ||
            node.kind !== "paragraph" ||
            node.sourceHash !== sourceContentHash ||
            range.start !== exact.sourceRange.start ||
            range.end !== exact.sourceRange.end ||
            node.text !== exact.text ||
            typeof item.score !== "number" ||
            !Number.isFinite(item.score)
          ) {
            fail("Incomplete or invalid source node; use a narrower query.");
          }
          const chunk = decodeMemoryAgentBenchChunk(exact!.text);
          const ref: SourceRef = {
            rootDropId: binding.rootDropId,
            branchId: binding.branchId,
            snapshotId: binding.snapshotId,
            sourceContentHash,
            nodeId: exact!.id,
            sourceRange: { ...exact!.sourceRange },
          };
          return { capability: randomUUID(), ref, chunk, score: item.score };
        });
        for (const item of pending) {
          capabilities.set(item.capability, { ...item.ref, chunk: item.chunk });
          trace.refs.push(item.ref);
        }
        return structuredClone({
          items: pending.map(({ capability, ref, chunk, score }) => ({
            capability,
            ...ref,
            score,
            preview: chunk.slice(0, 240),
            previewOnly: true,
          })),
          remainingCalls: 6 - calls,
        });
      } catch (error) {
        const message =
          error instanceof GatewayError
            ? error.message
            : "Gateway query failed; use a narrower query.";
        trace.status = message;
        throw new GatewayError(message);
      } finally {
        trace.elapsedMs = performance.now() - started;
        traces.push(trace);
        busy = false;
      }
    },
    async close() {
      if (busy) {
        fail("Wait for the active tool before closing.");
      }
      if (closed) return;
      closed = true;
      capabilities.clear();
      await client.close();
    },
  };
  return gateway;
};

export type BenchMcpGateway = Awaited<ReturnType<typeof createBenchMcpGateway>>;
