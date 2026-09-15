#!/usr/bin/env bun

import { runNulldownMcpServer } from "../src/mcp/server";
import { mcpLog } from "../src/mcp/logging";

const main = async () => {
  await runNulldownMcpServer();
};

main().catch(() => {
  mcpLog("mcp.server.fatal", "error");
  process.exitCode = 1;
});
