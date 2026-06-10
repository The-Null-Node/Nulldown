import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createNulldownClient,
  type CreateNulldownClientOptions,
  type NulldownJsonValue,
} from "../client/nulldownClient";
import {
  DropDiffEventMetadataSchema,
  DropDiffOpSchema,
} from "../../shared/drop/diffSchemas";
import type { DropDiffEventMetadata, DropDiffOp } from "../../shared/drop/diff";

const clientArgsSchema = {
  baseUrl: z
    .string()
    .url()
    .optional()
    .describe("Nulldown API base URL. Defaults to ND_BASE_URL or production."),
  accountId: z
    .string()
    .optional()
    .describe("Optional account id header for local/dev APIs."),
  clientId: z
    .string()
    .optional()
    .describe("Stable diff client id. Defaults to ND_CLIENT_ID when set."),
};

const jsonValueSchema: z.ZodType<NulldownJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonRecordSchema = z.record(z.string(), jsonValueSchema);

type ClientArgs = {
  baseUrl?: string;
  accountId?: string;
  clientId?: string;
};

const createClient = (args: ClientArgs = {}) => {
  const options: CreateNulldownClientOptions = {
    baseUrl: args.baseUrl,
    accountId: args.accountId,
    clientId: args.clientId,
  };
  return createNulldownClient(options);
};

const asJsonText = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(value ?? null, null, 2),
    },
  ],
});

/** Creates the Nulldown MCP server and registers direct API tools. */
export const createNulldownMcpServer = (): McpServer => {
  const server = new McpServer({ name: "nulldown", version: "1.0.0" });

  server.registerTool(
    "strategy_search",
    {
      title: "Search Nulldown Strategies",
      description:
        "Search public Nulldown strategy and documentation drops. Use ND_TOKEN for authenticated APIs when needed.",
      inputSchema: {
        ...clientArgsSchema,
        query: z.string().describe("Search text."),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) =>
      asJsonText(
        await createClient(args).searchDrops({
          query: args.query,
          limit: args.limit,
        }),
      ),
  );

  server.registerTool(
    "strategy_get",
    {
      title: "Get Nulldown Strategy",
      description:
        "Fetch a Nulldown strategy or documentation drop by canonical or short id.",
      inputSchema: {
        ...clientArgsSchema,
        id: z.string().describe("Canonical or short drop id."),
      },
    },
    async (args) => asJsonText(await createClient(args).getDrop(args.id)),
  );

  server.registerTool(
    "drop_get",
    {
      title: "Get Drop",
      description: "Fetch a drop by canonical or short id.",
      inputSchema: {
        ...clientArgsSchema,
        id: z.string().describe("Canonical or short drop id."),
      },
    },
    async (args) => asJsonText(await createClient(args).getDrop(args.id)),
  );

  server.registerTool(
    "drop_create",
    {
      title: "Create Drop",
      description:
        "Create a plaintext Nulldown drop. Authenticated APIs use ND_TOKEN from the MCP environment.",
      inputSchema: {
        ...clientArgsSchema,
        content: z.string().describe("Markdown content to store."),
        metadata: jsonRecordSchema.optional(),
        id: z.string().optional(),
        upsert: z.boolean().optional(),
        expectedRevision: z.string().optional(),
      },
    },
    async (args) =>
      asJsonText(
        await createClient(args).createDrop({
          content: args.content,
          metadata: args.metadata,
          id: args.id,
          upsert: args.upsert,
          expectedRevision: args.expectedRevision,
        }),
      ),
  );

  server.registerTool(
    "branch_resolve",
    {
      title: "Resolve Branch",
      description: "Resolve or create the current actor branch for a root drop.",
      inputSchema: {
        ...clientArgsSchema,
        dropId: z.string().describe("Root drop id."),
      },
    },
    async (args) => asJsonText(await createClient(args).resolveBranch(args.dropId)),
  );

  server.registerTool(
    "branch_content",
    {
      title: "Get Branch Content",
      description: "Fetch exact materialized branch content.",
      inputSchema: {
        ...clientArgsSchema,
        rootId: z.string().describe("Root drop id."),
        branchId: z.string().describe("Branch id."),
      },
    },
    async (args) =>
      asJsonText(await createClient(args).getBranchContent(args.rootId, args.branchId)),
  );

  server.registerTool(
    "branch_query",
    {
      title: "Query Branch Heap",
      description: "Query a branch resolved heap.",
      inputSchema: {
        ...clientArgsSchema,
        rootId: z.string().describe("Root drop id."),
        branchId: z.string().describe("Branch id."),
        query: z.string().optional(),
        top: z.number().int().min(1).max(50).optional(),
        snapshotId: z.union([z.string(), z.number()]).optional(),
        resolverId: z.string().optional(),
        kind: z.string().optional(),
        fromSeq: z.number().int().min(0).optional(),
        toSeq: z.number().int().min(0).optional(),
        pluginId: z.string().optional(),
        callId: z.string().optional(),
        primitiveId: z.string().optional(),
        changedOnly: z.boolean().optional(),
        includeAncestors: z.boolean().optional(),
        includeEventMetadata: z.boolean().optional(),
      },
    },
    async (args) => asJsonText(await createClient(args).queryBranch(args)),
  );

  server.registerTool(
    "diff_apply",
    {
      title: "Apply Branch Diff",
      description:
        "Post one atomic branch diff event. Protected branches require ND_TOKEN and any server-side diff credentials already configured.",
      inputSchema: {
        ...clientArgsSchema,
        dropId: z.string().describe("Route drop id."),
        branchId: z.string().optional(),
        ops: z.array(DropDiffOpSchema).min(1),
        metadata: DropDiffEventMetadataSchema.optional(),
        eventDropId: z.string().optional(),
      },
    },
    async (args) =>
      asJsonText(
        await createClient(args).applyDiff({
          dropId: args.dropId,
          branchId: args.branchId,
          ops: args.ops as DropDiffOp[],
          metadata: args.metadata as DropDiffEventMetadata | undefined,
          eventDropId: args.eventDropId,
        }),
      ),
  );

  server.registerTool(
    "memory_query",
    {
      title: "Query NullMem",
      description: "Query branch-scoped NullMem facts, procedures, and capabilities.",
      inputSchema: {
        ...clientArgsSchema,
        rootId: z.string().describe("Root drop id."),
        branchId: z.string().describe("Branch id."),
        query: z.string().optional(),
        kind: z.enum(["fact", "procedure", "capability"]).optional(),
        labels: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => asJsonText(await createClient(args).queryMemory(args)),
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

  return server;
};

/** Runs the Nulldown MCP server over stdio. */
export const runNulldownMcpServer = async (): Promise<void> => {
  const server = createNulldownMcpServer();
  await server.connect(new StdioServerTransport());
};
