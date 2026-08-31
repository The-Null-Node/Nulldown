#!/usr/bin/env bun

import { runNulldownMcpServer } from "../src/server";
import { mcpLog } from "../src/logging";

const main = async () => {
  await runNulldownMcpServer();
};

main().catch(() => {
  mcpLog("mcp.server.fatal", "error");
  process.exitCode = 1;
});
