import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asCompact } from "../response";
import {
  clientArgsSchema,
  createClient,
  extractMcpResponseArgs,
  mcpResponseArgsSchema,
} from "../tooling";

/** Registers strategy search and retrieval tools on the MCP server. */
export const registerStrategyTools = (server: McpServer): void => {
  server.registerTool(
    "strategy_search",
    {
      title: "Search Nulldown Strategies",
      description:
        "Search public Nulldown strategy and documentation drops. Use ND_TOKEN for authenticated APIs when needed.",
      inputSchema: {
        ...clientArgsSchema,
        ...mcpResponseArgsSchema,
        query: z.string().describe("Search text."),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) =>
      asCompact(
        await createClient(args).searchDrops({
          query: args.query,
          limit: args.limit,
        }),
        extractMcpResponseArgs(args),
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
        ...mcpResponseArgsSchema,
        id: z.string().describe("Canonical or short drop id."),
      },
    },
    async (args) =>
      asCompact(await createClient(args).getDrop(args.id), extractMcpResponseArgs(args)),
  );
};
