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
    async (args) =>
      asCompact(await createClient(args).getDrop(args.id), extractMcpResponseArgs(args)),
  );

  server.registerTool(
    "drop_create",
    {
      title: "Create Drop",
      description:
        "Create a Nulldown drop. ND_AUTH_FILE creates a sealed account-owned envelope by default; ND_TOKEN authenticates only. Plaintext creation with account authentication requires legacyPlaintext=true and is not added to Remote Library.",
      inputSchema: {
        ...clientArgsSchema,
        content: z.string().describe("Markdown content to store."),
        metadata: jsonRecordSchema.optional(),
        visibility: z.enum(["private", "unlisted", "public"]).optional().default("unlisted")
          .describe("Envelope visibility. Defaults to unlisted when ND_AUTH_FILE is used."),
        legacyPlaintext: z.boolean().optional()
          .describe("Explicitly store plaintext for legacy compatibility. Authenticated plaintext drops are not added to Remote Library."),
        id: z.string().optional(),
        upsert: z.boolean().optional(),
        expectedRevision: z.string().optional(),
      },
    },
    async (args) =>
      asJsonText(
        await createClient(args, {
          visibility: args.visibility,
          legacyPlaintext: args.legacyPlaintext,
        }).createDrop({
          content: args.content,
          metadata: args.metadata,
          id: args.id,
          upsert: args.upsert,
          expectedRevision: args.expectedRevision,
        }),
      ),
  );
};
