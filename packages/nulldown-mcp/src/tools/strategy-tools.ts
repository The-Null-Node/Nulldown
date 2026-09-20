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
        "Read a bounded strategy using an explicit branch, otherwise a validated same-root plaintext metadata strategyRef, otherwise the root. Never resolves or creates a branch; invalid references and branch errors fail without fallback.",
      inputSchema: {
        ...clientArgsSchema,
        ...mcpResponseArgsSchema,
        id: z.string().describe("Canonical or short drop id."),
        branchId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Explicit branch override; otherwise use plaintext strategyRef or read the root.",
          ),
        query: z.string().optional(),
        snapshotId: z
          .union([z.string(), z.number().int().nonnegative()])
          .optional(),
        top: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      asCompact(
        await createClient(args).readStrategy(args),
        extractMcpResponseArgs(args),
      ),
  );
};
