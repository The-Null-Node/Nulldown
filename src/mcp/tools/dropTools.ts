import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asCompact, asJsonText } from "../response";
import {
  clientArgsSchema,
  createClient,
  extractMcpResponseArgs,
  jsonRecordSchema,
  mcpResponseArgsSchema,
} from "../tooling";

/** Registers drop read and create tools on the MCP server. */
export const registerDropTools = (server: McpServer): void => {
  server.registerTool(
    "drop_get",
    {
      title: "Get Drop",
      description: "Fetch a drop by canonical or short id.",
      inputSchema: {
        ...clientArgsSchema,
        ...mcpResponseArgsSchema,
        id: z.string().describe("Canonical or short drop id."),
      },
    },
    async (args) => asCompact(await createClient(args).getDrop(args.id), extractMcpResponseArgs(args)),
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
};
