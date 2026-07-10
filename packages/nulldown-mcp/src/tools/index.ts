import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBranchTools } from "./branchTools";
import { registerDropTools } from "./dropTools";
import { registerMemoryTools } from "./memoryTools";
import { registerStrategyTools } from "./strategyTools";

/** Registers all Nulldown MCP tool groups on the server. */
export const registerNulldownTools = (server: McpServer): void => {
  registerStrategyTools(server);
  registerDropTools(server);
  registerBranchTools(server);
  registerMemoryTools(server);
};
