import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBranchTools } from "./branch-tools";
import { registerDropTools } from "./drop-tools";
import { registerMemoryTools } from "./memory-tools";
import { registerStrategyTools } from "./strategy-tools";

/** Registers all Nulldown MCP tool groups on the server. */
export const registerNulldownTools = (server: McpServer): void => {
  registerStrategyTools(server);
  registerDropTools(server);
  registerBranchTools(server);
  registerMemoryTools(server);
};
