#!/usr/bin/env bun

import { runNulldownMcpServer } from "../src/mcp/server";

const main = async () => {
  await runNulldownMcpServer();
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
