type McpLogLevel = "silent" | "error" | "warn" | "info" | "debug";
type McpLogEvent =
  | "mcp.server.starting"
  | "mcp.server.ready"
  | "mcp.server.fatal"
  | "mcp.auth.refresh_started"
  | "mcp.auth.refresh_completed"
  | "mcp.auth.refresh_failed";

const logOrder: Record<McpLogLevel, number> = {
  silent: 99,
  error: 40,
  warn: 30,
  info: 20,
  debug: 10,
};

/** Writes fixed, credential-safe diagnostics to the stdio server's stderr stream. */
export const createMcpLogger = (environment = process.env) => {
  const requested = environment.ND_MCP_LOG_LEVEL?.trim().toLowerCase();
  const level: McpLogLevel = requested && requested in logOrder
    ? requested as McpLogLevel
    : "info";

  return (event: McpLogEvent, eventLevel: Exclude<McpLogLevel, "silent"> = "info") => {
    if (logOrder[eventLevel] < logOrder[level]) return;
    process.stderr.write(`${JSON.stringify({
      ts: new Date().toISOString(),
      level: eventLevel,
      event,
    })}\n`);
  };
};

/** Process-wide MCP diagnostics configured from the server environment. */
export const mcpLog = createMcpLogger();
