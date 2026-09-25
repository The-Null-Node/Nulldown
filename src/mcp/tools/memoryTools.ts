import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asCompact, asJsonText } from "../response";
import {
  clientArgsSchema,
  createClient,
  extractMcpResponseArgs,
  jsonRecordSchema,
  jsonValueSchema,
  mcpResponseArgsSchema,
} from "../tooling";

/** Registers branch-scoped NullMem tools on the MCP server. */
export const registerMemoryTools = (server: McpServer): void => {
  server.registerTool(
    "memory_stale_check",
    {
      title: "Check Stale NullMem",
      description: "Evaluate branch-scoped NullMem records for staleness and supersession.",
      inputSchema: {
        ...clientArgsSchema,
        ...mcpResponseArgsSchema,
        rootId: z.string().describe("Root drop id."),
        branchId: z.string().describe("Branch id."),
        query: z.string().optional(),
        kind: z.enum(["fact", "procedure", "capability"]).optional(),
        labels: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      asCompact(
        await createClient(args).queryMemory({
          rootId: args.rootId,
          branchId: args.branchId,
          query: args.query,
          kind: args.kind,
          labels: args.labels,
          limit: args.limit,
          includeFreshness: true,
        }),
        extractMcpResponseArgs(args),
      ),
  );

  server.registerTool(
    "memory_query",
    {
      title: "Query NullMem",
      description: "Query branch-scoped NullMem facts, procedures, and capabilities.",
      inputSchema: {
        ...clientArgsSchema,
        ...mcpResponseArgsSchema,
        rootId: z.string().describe("Root drop id."),
        branchId: z.string().describe("Branch id."),
        query: z.string().optional(),
        kind: z.enum(["fact", "procedure", "capability"]).optional(),
        labels: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        procedureId: z
          .string()
          .optional()
          .describe("Exact procedure record id for compact next-step projection."),
        afterStep: z
          .number()
          .optional()
          .describe("Return procedure steps with index greater than this cursor."),
        stepLimit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum procedure steps to return."),
        includeRecords: z
          .boolean()
          .optional()
          .describe("Return full records alongside compact capsules and procedure steps."),
        includeFreshness: z
          .boolean()
          .optional()
          .describe("Include freshness reports for the results."),
      },
    },
    async (args) =>
      asCompact(await createClient(args).queryMemory(args), extractMcpResponseArgs(args)),
  );

  server.registerTool(
    "memory_fact",
    {
      title: "Create NullMem Fact",
      description: "Create a branch-scoped NullMem fact.",
      inputSchema: {
        ...clientArgsSchema,
        rootId: z.string().describe("Root drop id."),
        branchId: z.string().describe("Branch id."),
        text: z.string().describe("Fact body."),
        title: z.string().optional(),
        targetKind: z.string().optional(),
        targetId: z.string().optional(),
        labels: z.array(z.string()).optional(),
        priority: z.number().optional(),
        confidence: z.number().min(0).max(1).optional(),
        metadata: jsonRecordSchema.optional(),
      },
    },
    async (args) =>
      asJsonText(
        await createClient(args).createMemoryFact({
          rootId: args.rootId,
          branchId: args.branchId,
          text: args.text,
          title: args.title,
          targetKind: args.targetKind,
          targetId: args.targetId,
          labels: args.labels,
          priority: args.priority,
          confidence: args.confidence,
          metadata: args.metadata,
        }),
      ),
  );

  server.registerTool(
    "memory_procedure",
    {
      title: "Create NullMem Procedure",
      description: "Create a branch-scoped reusable NullMem procedure.",
      inputSchema: {
        ...clientArgsSchema,
        rootId: z.string().describe("Root drop id."),
        branchId: z.string().describe("Branch id."),
        goal: z.string().describe("Procedure goal."),
        summary: z.string().describe("Reusable summary."),
        steps: z.array(jsonValueSchema).optional(),
        outcome: z.string().optional(),
        reusableAs: z.string().optional(),
        labels: z.array(z.string()).optional(),
        priority: z.number().optional(),
        confidence: z.number().min(0).max(1).optional(),
        metadata: jsonRecordSchema.optional(),
      },
    },
    async (args) =>
      asJsonText(
        await createClient(args).createMemoryProcedure({
          rootId: args.rootId,
          branchId: args.branchId,
          goal: args.goal,
          summary: args.summary,
          steps: args.steps,
          outcome: args.outcome,
          reusableAs: args.reusableAs,
          labels: args.labels,
          priority: args.priority,
          confidence: args.confidence,
          metadata: args.metadata,
        }),
      ),
  );
};
