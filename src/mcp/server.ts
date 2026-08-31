import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mcpLog } from "./logging";
import { registerNulldownTools } from "./tools";

/** Creates the Nulldown MCP server and registers direct API tools. */
export const createNulldownMcpServer = (): McpServer => {
  const server = new McpServer({ name: "nulldown", version: "1.0.0" });
  registerNulldownTools(server);
  return server;
};

/** Runs the Nulldown MCP server over stdio. */
export const runNulldownMcpServer = async (): Promise<void> => {
  mcpLog("mcp.server.starting");
  const server = createNulldownMcpServer();
  await server.connect(new StdioServerTransport());
  mcpLog("mcp.server.ready");
};
