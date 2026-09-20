import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OPERATION_TIMEOUT_MS = 20_000;
const CLEANUP_OPERATION_TIMEOUT_MS = 4_000;
const OVERALL_HARD_TIMEOUT_MS = 90_000;
const OVERALL_CLEANUP_GRACE_MS = 5_000;
const OVERALL_WORK_TIMEOUT_MS =
  OVERALL_HARD_TIMEOUT_MS - OVERALL_CLEANUP_GRACE_MS;
const QUERY_ROOT_ID = "smoke-query-root";
const QUERY_BRANCH_ID = "smoke:query-branch";
const CONTENT_ROOT_ID = "smoke-content-root";
const CONTENT_BRANCH_ID = "smoke:content-branch";

const expectedTools = [
  "strategy_search",
  "strategy_get",
  "drop_get",
  "drop_create",
  "branch_resolve",
  "branch_content",
  "branch_query",
  "diff_apply",
  "memory_stale_check",
  "memory_query",
  "memory_fact",
  "memory_procedure",
];

class SmokeFailure extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const fail = (
  message: string,
  details: Record<string, unknown> = {},
): never => {
  throw new SmokeFailure(message, details);
};

const parseArgs = (): { command: string; args: string[] } => {
  const [, , command, ...args] = process.argv;
  if (!command) {
    fail("Usage: bun run scripts/smoke-mcp-stdio.ts <command> [args...]");
  }
  return { command, args };
};

const withTimeout = async <T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = OPERATION_TIMEOUT_MS,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SmokeFailure(`${label} timed out.`, { timeoutMs })),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  response.writeHead(status, {
    "Content-Type": "application/json",
    Connection: "close",
  });
  response.end(JSON.stringify(value));
};

const startFixture = async () => {
  const requests: string[] = [];
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    requests.push(
      `${request.method ?? "UNKNOWN"} ${url.pathname}${url.search}`,
    );
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "fixture only accepts GET" });
      return;
    }

    const queryPath = `/api/branches/${QUERY_ROOT_ID}/${QUERY_BRANCH_ID}/resolved/query`;
    if (url.pathname === queryPath) {
      if (
        url.searchParams.get("snapshotterId") === "nulledit.resolved-document"
      ) {
        sendJson(response, 200, {
          rootDropId: QUERY_ROOT_ID,
          branchId: QUERY_BRANCH_ID,
          items: [
            {
              id: "fixture-priority",
              kind: "heading",
              score: 1,
              text: "Deterministic local priority projection.",
              sourceRange: { start: 0, end: 40 },
            },
            {
              id: "fixture-proof",
              kind: "paragraph",
              score: 0.75,
              text: "Proof is captured before deletion.",
              sourceRange: { start: 41, end: 77 },
            },
          ],
        });
        return;
      }

      const count = Number(url.searchParams.get("k") ?? "1");
      sendJson(response, 200, {
        rootDropId: QUERY_ROOT_ID,
        branchId: QUERY_BRANCH_ID,
        snapshotId: 7,
        nodes: Array.from({ length: count }, (_, index) => ({
          id: `fixture-node-${index + 1}`,
          kind: "paragraph",
          score: 1 - index / 10,
          text: `priority-${index + 1} ${"deterministic-local-content ".repeat(20)}`,
          sourceRange: { start: index * 100, end: index * 100 + 99 },
        })),
      });
      return;
    }

    const contentPath = `/api/branches/${CONTENT_ROOT_ID}/${CONTENT_BRANCH_ID}/content`;
    if (url.pathname === contentPath) {
      sendJson(response, 200, {
        rootDropId: CONTENT_ROOT_ID,
        branchId: CONTENT_BRANCH_ID,
        snapshotId: 11,
        content:
          "# Local MCP fixture\n\nComplete deterministic branch content.\n",
      });
      return;
    }

    sendJson(response, 404, { error: "unexpected local fixture request" });
  });

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    }),
    "Local HTTP fixture start",
  );
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    fail("Local HTTP fixture did not expose a TCP address.", { address });
  }
  const port = (address as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      closePromise ??= withTimeout(
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
        "Local HTTP fixture close",
        CLEANUP_OPERATION_TIMEOUT_MS,
      );
      return closePromise;
    },
  };
};

const readTextContent = (
  result: Awaited<ReturnType<Client["callTool"]>>,
): string => {
  if (!("content" in result)) {
    fail("MCP tool result did not contain content.", { result });
  }
  const content = result.content as unknown;
  if (!Array.isArray(content)) {
    fail("MCP tool result content was not an array.", { result });
  }
  const contentItems = content as Array<{ type?: unknown; text?: unknown }>;
  const first = contentItems[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    fail("MCP tool result did not return text content.", { result });
  }
  return first!.text as string;
};

const requireInputValidationError = (
  result: Awaited<ReturnType<Client["callTool"]>>,
): void => {
  if (
    !result.isError ||
    !readTextContent(result).includes("Input validation error")
  ) {
    fail("MCP diff_apply accepted an incomplete retry identity.", { result });
  }
};

const createChildEnvironment = (origin: string) => {
  const secretNames = [
    "ND_AUTH_FILE",
    "ND_TOKEN",
    "ND_DIFF_AUTH_TOKEN",
    "DIFF_WEBHOOK_SECRET",
    "VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK",
  ];
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !secretNames.includes(entry[0]),
    ),
  );
  const smokeSecrets = {
    ND_TOKEN: "mcp-smoke-nd-token-7f6b4d21",
    ND_DIFF_AUTH_TOKEN: "mcp-smoke-diff-token-3c89a105",
    DIFF_WEBHOOK_SECRET: "mcp-smoke-webhook-secret-51e78a2c",
    VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK: "mcp-smoke-public-jwk-secret-a6320d94",
    ND_MCP_SMOKE_SECRET: "mcp-smoke-extra-secret-c14e0957",
  };
  return {
    environment: {
      ...environment,
      ...smokeSecrets,
      ND_BASE_URL: origin,
      ND_MCP_LOG_LEVEL: "info",
    },
    smokeSecrets,
  };
};

const parseDiagnostics = (
  chunks: Buffer[],
  smokeSecrets: Record<string, string>,
): Array<Record<string, unknown>> => {
  const stderr = Buffer.concat(chunks).toString("utf8");
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    fail("MCP child emitted no stderr diagnostics.");
  }
  for (const [name, value] of Object.entries(smokeSecrets)) {
    if (stderr.includes(value)) {
      fail("MCP stderr diagnostic exposed a secret environment value.", {
        name,
      });
    }
  }
  return lines.map((line, index): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      return fail("MCP stderr included a non-JSON diagnostic line.", {
        lineNumber: index + 1,
      });
    }
  });
};

type LocalFixture = Awaited<ReturnType<typeof startFixture>>;

const activeResources: {
  client?: Client;
  transport?: StdioClientTransport;
  fixture?: LocalFixture;
  mcpClose?: Promise<void>;
  cleanup?: Promise<void>;
} = {};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const closeMcpResources = (): Promise<void> => {
  activeResources.mcpClose ??= (async () => {
    const failures: string[] = [];
    if (activeResources.client) {
      try {
        await withTimeout(
          activeResources.client.close(),
          "MCP client close",
          CLEANUP_OPERATION_TIMEOUT_MS,
        );
      } catch (error) {
        failures.push(`client: ${errorMessage(error)}`);
      }
    }
    if (activeResources.transport) {
      try {
        await withTimeout(
          activeResources.transport.close(),
          "MCP transport close",
          CLEANUP_OPERATION_TIMEOUT_MS,
        );
      } catch (error) {
        failures.push(`transport: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      fail("MCP stdio cleanup failed.", { failures });
    }
  })();
  return activeResources.mcpClose;
};

const cleanupActiveResources = (): Promise<void> => {
  activeResources.cleanup ??= (async () => {
    const results = await Promise.allSettled([
      closeMcpResources(),
      activeResources.fixture?.close() ?? Promise.resolve(),
    ]);
    const failures = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => errorMessage(result.reason));
    if (failures.length > 0) {
      fail("MCP smoke resource cleanup failed.", { failures });
    }
  })();
  return activeResources.cleanup;
};

const main = async () => {
  const { command, args } = parseArgs();
  const fixture = await startFixture();
  activeResources.fixture = fixture;
  let report: Record<string, unknown> | undefined;
  try {
    const { environment, smokeSecrets } = createChildEnvironment(
      fixture.origin,
    );
    const transport = new StdioClientTransport({
      command,
      args,
      env: environment,
      stderr: "pipe",
    });
    activeResources.transport = transport;
    const stderrChunks: Buffer[] = [];
    transport.stderr?.on("data", (chunk) => {
      stderrChunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
      );
    });

    const client = new Client({ name: "nulldown-mcp-smoke", version: "1.0.0" });
    activeResources.client = client;
    let checks: Record<string, unknown> | undefined;
    try {
      await withTimeout(client.connect(transport), "MCP initialize");
      const listed = await withTimeout(client.listTools(), "MCP tools/list");
      const toolNames = listed.tools.map((tool) => tool.name).sort();
      const missingTools = expectedTools.filter(
        (tool) => !toolNames.includes(tool),
      );
      if (missingTools.length > 0) {
        fail("MCP tools/list missed expected tools.", {
          missingTools,
          toolNames,
        });
      }
      const dropCreate = listed.tools.find(
        (tool) => tool.name === "drop_create",
      );
      if (
        !dropCreate?.description?.includes("ND_AUTH_FILE") ||
        !dropCreate.description.includes("legacyPlaintext")
      ) {
        fail("MCP drop_create did not expose account-authoring guidance.", {
          dropCreate,
        });
      }

      for (const identity of [{ eventId: "retry-1" }, { createdAt: 1 }]) {
        requireInputValidationError(
          await withTimeout(
            client.callTool({
              name: "diff_apply",
              arguments: {
                dropId: "retry-validation-only",
                ops: [{ type: "insert", start: 0, end: 0, text: "x" }],
                ...identity,
              },
            }),
            "MCP diff_apply retry identity validation",
          ),
        );
      }

      const queryResult = await withTimeout(
        client.callTool({
          name: "branch_query",
          arguments: {
            baseUrl: fixture.origin,
            rootId: QUERY_ROOT_ID,
            branchId: QUERY_BRANCH_ID,
            query: "priority",
            top: 1,
          },
        }),
        "MCP branch_query full tool call",
      );
      const text = readTextContent(queryResult);
      const parsed = JSON.parse(text) as {
        rootDropId?: string;
        branchId?: string;
        nodes?: unknown[];
      };
      if (
        parsed.rootDropId !== QUERY_ROOT_ID ||
        parsed.branchId !== QUERY_BRANCH_ID ||
        !Array.isArray(parsed.nodes)
      ) {
        fail("MCP branch_query returned unexpected payload.", { parsed });
      }
      const queryNodes = parsed.nodes as unknown[];
      const fullLen = text.length;

      const snapResult = await withTimeout(
        client.callTool({
          name: "branch_query",
          arguments: {
            baseUrl: fixture.origin,
            rootId: QUERY_ROOT_ID,
            branchId: QUERY_BRANCH_ID,
            snapshotterId: "nulledit.resolved-document",
            top: 2,
          },
        }),
        "MCP branch_query snapshotterId compact",
      );
      const snapText = readTextContent(snapResult);
      const snapLen = snapText.length;
      const snapParsed = JSON.parse(snapText) as {
        items?: Array<{
          id?: unknown;
          kind?: unknown;
          score?: unknown;
          text?: unknown;
          sourceRange?: { start?: unknown; end?: unknown };
        }>;
        nodes?: unknown[];
      };
      if (snapLen > 4000) {
        fail("snapshotterId compact response too large.", { snapLen });
      }
      const firstCompactItem = snapParsed.items?.[0];
      if (
        !firstCompactItem ||
        snapParsed.nodes !== undefined ||
        typeof firstCompactItem.id !== "string" ||
        typeof firstCompactItem.kind !== "string" ||
        typeof firstCompactItem.score !== "number" ||
        typeof firstCompactItem.text !== "string" ||
        typeof firstCompactItem.sourceRange?.start !== "number" ||
        typeof firstCompactItem.sourceRange?.end !== "number"
      ) {
        fail("snapshotterId did not return compact resolved-document items.", {
          snapParsed,
        });
      }

      const tinyResult = await withTimeout(
        client.callTool({
          name: "branch_query",
          arguments: {
            baseUrl: fixture.origin,
            rootId: QUERY_ROOT_ID,
            branchId: QUERY_BRANCH_ID,
            query: "priority",
            top: 5,
            maxTokens: 100,
          },
        }),
        "MCP branch_query maxTokens small",
      );
      const tinyText = readTextContent(tinyResult);
      if (tinyText.length > 500) {
        fail("maxTokens capped response still too large.", {
          len: tinyText.length,
        });
      }
      const tinyParsed = JSON.parse(tinyText) as {
        truncated?: unknown;
        maxTokens?: unknown;
        preview?: unknown;
      };
      if (
        tinyParsed.truncated !== true ||
        tinyParsed.maxTokens !== 100 ||
        typeof tinyParsed.preview !== "string"
      ) {
        fail(
          "maxTokens capped response did not return a truncation envelope.",
          { tinyParsed },
        );
      }

      const contentResult = await withTimeout(
        client.callTool({
          name: "branch_content",
          arguments: {
            baseUrl: fixture.origin,
            rootId: CONTENT_ROOT_ID,
            branchId: CONTENT_BRANCH_ID,
            format: "full",
            maxTokens: 8000,
          },
        }),
        "MCP branch_content full response",
      );
      const contentParsed = JSON.parse(readTextContent(contentResult)) as {
        content?: unknown;
      };
      if (typeof contentParsed.content !== "string") {
        fail("branch_content format full did not return complete content.", {
          contentParsed,
        });
      }
      const branchContent = contentParsed.content as string;

      checks = {
        toolCount: toolNames.length,
        checkedTools: expectedTools,
        branchQueryNodes: queryNodes.length,
        fullQueryLen: fullLen,
        snapshotterCompactItems: snapParsed.items?.length ?? 0,
        snapshotterCompactLen: snapLen,
        maxTokensLen: tinyText.length,
        branchContentLen: branchContent.length,
      };
    } finally {
      await closeMcpResources();
    }

    const diagnostics = parseDiagnostics(stderrChunks, smokeSecrets);
    if (fixture.requests.length !== 4) {
      fail("Local HTTP fixture received an unexpected number of requests.", {
        requests: fixture.requests,
      });
    }
    report = {
      command,
      args,
      ...checks,
      localFixtureRequests: fixture.requests,
      diagnosticEvents: diagnostics.map((entry) => entry.event ?? null),
      protocolStdoutCheck:
        "StdioClientTransport exposes protocol messages only; this SDK has no raw child stdout stream.",
    };
  } finally {
    await cleanupActiveResources();
  }

  console.log(JSON.stringify(report, null, 2));
};

let overallTimedOut = false;
const overallTimer = setTimeout(() => {
  overallTimedOut = true;
  console.error("MCP stdio smoke exceeded its overall useful-work deadline.");
  console.error(
    JSON.stringify(
      {
        usefulWorkTimeoutMs: OVERALL_WORK_TIMEOUT_MS,
        cleanupGraceMs: OVERALL_CLEANUP_GRACE_MS,
        hardTimeoutMs: OVERALL_HARD_TIMEOUT_MS,
      },
      null,
      2,
    ),
  );
  const hardTerminationTimer = setTimeout(() => {
    console.error(
      "MCP stdio smoke cleanup exceeded its bounded grace period; forcing exit.",
    );
    process.exit(1);
  }, OVERALL_CLEANUP_GRACE_MS);

  void cleanupActiveResources()
    .catch((error: unknown) => {
      console.error(
        "MCP stdio smoke timed out and best-effort cleanup failed.",
      );
      console.error(JSON.stringify({ error: errorMessage(error) }, null, 2));
    })
    .finally(() => {
      clearTimeout(hardTerminationTimer);
      process.exit(1);
    });
}, OVERALL_WORK_TIMEOUT_MS);

main()
  .catch((error: unknown) => {
    if (overallTimedOut) return;
    const smokeFailure = error instanceof SmokeFailure ? error : null;
    console.error(smokeFailure?.message ?? "MCP stdio smoke failed.");
    console.error(
      JSON.stringify(
        smokeFailure?.details ?? {
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    if (!overallTimedOut) clearTimeout(overallTimer);
  });
