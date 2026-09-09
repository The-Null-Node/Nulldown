import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DropDiffEventIdSchema,
  DropDiffEventMetadataSchema,
  DropDiffOpSchema,
} from "../../../shared/drop/diffSchemas";
import type {
  DropDiffEventMetadata,
  DropDiffOp,
} from "../../../shared/drop/diff";
import { asCompact, asJsonText } from "../response";
import {
  clientArgsSchema,
  createClient,
  extractMcpResponseArgs,
  mcpResponseArgsSchema,
} from "../tooling";

const diffApplyInputSchema = z
  .object({
    ...clientArgsSchema,
    dropId: z.string().describe("Route drop id."),
    branchId: z.string().optional(),
    ops: z.array(DropDiffOpSchema).min(1),
    metadata: DropDiffEventMetadataSchema.optional(),
    eventDropId: z.string().optional(),
    eventId: DropDiffEventIdSchema.optional(),
    createdAt: z.number().finite().int().min(0).optional(),
  })
  .superRefine((value, context) => {
    if ((value.eventId === undefined) !== (value.createdAt === undefined)) {
      context.addIssue({
        code: "custom",
        message: "eventId and createdAt must be provided together.",
      });
    }
  });

/** Registers branch query/content and diff tools on the MCP server. */
export const registerBranchTools = (server: McpServer): void => {
  server.registerTool(
    "branch_resolve",
    {
      title: "Resolve Branch",
      description: "Resolve or create the current actor branch for a root drop.",
      inputSchema: {
        ...clientArgsSchema,
        ...mcpResponseArgsSchema,
        dropId: z.string().describe("Root drop id."),
      },
    },
    async (args) =>
      asCompact(
        await createClient(args).resolveBranch(args.dropId),
        extractMcpResponseArgs(args),
      ),
  );

  server.registerTool(
    "branch_content",
    {
      title: "Get Branch Content",
      description: "Fetch materialized branch content; request format full for exact content.",
      inputSchema: {
        ...clientArgsSchema,
        ...mcpResponseArgsSchema,
        rootId: z.string().describe("Root drop id."),
        branchId: z.string().describe("Branch id."),
      },
    },
    async (args) =>
      asCompact(
        await createClient(args).getBranchContent(args.rootId, args.branchId),
        extractMcpResponseArgs(args),
      ),
  );

  server.registerTool(
    "branch_query",
    {
      title: "Query Branch Heap",
      description: "Query a branch resolved heap.",
      inputSchema: {
        ...clientArgsSchema,
        ...mcpResponseArgsSchema,
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
        snapshotterId: z.string().optional(),
      },
    },
    async (args) =>
      asCompact(await createClient(args).queryBranch(args), extractMcpResponseArgs(args)),
  );

  server.registerTool(
    "diff_apply",
    {
      title: "Apply Branch Diff",
      description:
        "Post one atomic branch diff event. Protected branches require ND_TOKEN and any server-side diff credentials already configured.",
      inputSchema: diffApplyInputSchema,
    },
    async (args) =>
      asJsonText(
        await createClient(args).applyDiff({
          dropId: args.dropId,
          branchId: args.branchId,
          ops: args.ops as DropDiffOp[],
          metadata: args.metadata as DropDiffEventMetadata | undefined,
          eventDropId: args.eventDropId,
          eventId: args.eventId,
          createdAt: args.createdAt,
        }),
      ),
  );
};
