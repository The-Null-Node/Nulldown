import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

const fail = (message: string, details: Record<string, unknown> = {}): never => {
  console.error(message);
  console.error(JSON.stringify(details, null, 2));
  process.exit(1);
};

const parseArgs = (): { command: string; args: string[] } => {
  const [, , command, ...args] = process.argv;
  if (!command) {
    fail("Usage: bun run scripts/smoke-mcp-stdio.ts <command> [args...]");
  }
  return { command, args };
};

const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 20_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const readTextContent = (result: Awaited<ReturnType<Client["callTool"]>>): string => {
  if (!("content" in result)) {
    fail("MCP tool result did not contain content.", { result });
  }
  const first = result.content[0];
  if (!first || first.type !== "text") {
    fail("MCP tool result did not return text content.", { result });
  }
  return first.text;
};

const requireInputValidationError = (
  result: Awaited<ReturnType<Client["callTool"]>>,
): void => {
  if (!result.isError || !readTextContent(result).includes("Input validation error")) {
    fail("MCP diff_apply accepted an incomplete retry identity.", { result });
  }
};

const main = async () => {
  const { command, args } = parseArgs();
  const transport = new StdioClientTransport({
    command,
    args,
    env: {
      ...process.env,
      ND_BASE_URL: process.env.ND_BASE_URL ?? "https://nulldown.app",
    },
    stderr: "pipe",
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });

  const client = new Client({ name: "nulldown-mcp-smoke", version: "1.0.0" });
  try {
    await withTimeout(client.connect(transport), "MCP initialize");
    const listed = await withTimeout(client.listTools(), "MCP tools/list");
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    const missingTools = expectedTools.filter((tool) => !toolNames.includes(tool));
    if (missingTools.length > 0) {
      fail("MCP tools/list missed expected tools.", { missingTools, toolNames });
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
          baseUrl: process.env.ND_BASE_URL ?? "https://nulldown.app",
          rootId: "1wrhjx8Wzk67",
          branchId: "clone_account:91c993ac-2c8c-46d6-aaec-5d31e610a2b7",
          query: "priority",
          top: 1,
        },
      }),
      "MCP branch_query tool call",
    );
    const text = readTextContent(queryResult);
    const parsed = JSON.parse(text) as {
      rootDropId?: string;
      branchId?: string;
      nodes?: unknown[];
    };
    if (
      parsed.rootDropId !== "1wrhjx8Wzk67" ||
      parsed.branchId !== "clone_account:91c993ac-2c8c-46d6-aaec-5d31e610a2b7" ||
      !Array.isArray(parsed.nodes)
    ) {
      fail("MCP branch_query returned unexpected payload.", { parsed });
    }

    const fullLen = text.length;

    // Exercise compact/smaller response via snapshotterId (yieldNext path)
    const snapResult = await withTimeout(
      client.callTool({
        name: "branch_query",
        arguments: {
          baseUrl: process.env.ND_BASE_URL ?? "https://nulldown.app",
          rootId: "1wrhjx8Wzk67",
          branchId: "clone_account:91c993ac-2c8c-46d6-aaec-5d31e610a2b7",
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
      fail("snapshotterId compact response too large", { snapLen });
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
      fail("snapshotterId did not return compact resolved-document items", {
        snapParsed,
      });
    }

    // Force small response via maxTokens cap
    const tinyResult = await withTimeout(
      client.callTool({
        name: "branch_query",
        arguments: {
          baseUrl: process.env.ND_BASE_URL ?? "https://nulldown.app",
          rootId: "1wrhjx8Wzk67",
          branchId: "clone_account:91c993ac-2c8c-46d6-aaec-5d31e610a2b7",
          query: "priority",
          top: 5,
          maxTokens: 100,
        },
      }),
      "MCP branch_query maxTokens small",
    );
    const tinyText = readTextContent(tinyResult);
    if (tinyText.length > 500) {
      fail("maxTokens capped response still too large", { len: tinyText.length });
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
      fail("maxTokens capped response did not return a truncation envelope", { tinyParsed });
    }

    const contentResult = await withTimeout(
      client.callTool({
        name: "branch_content",
        arguments: {
          baseUrl: process.env.ND_BASE_URL ?? "https://nulldown.app",
          rootId: "UubhvMyw6N3a",
          branchId: "clone_account:91c993ac-2c8c-46d6-aaec-5d31e610a2b7",
          format: "full",
          maxTokens: 8000,
        },
      }),
      "MCP branch_content full response",
    );
    const contentParsed = JSON.parse(readTextContent(contentResult)) as { content?: unknown };
    if (typeof contentParsed.content !== "string") {
      fail("branch_content format full did not return complete content", { contentParsed });
    }

    console.log(
      JSON.stringify(
        {
          command,
          args,
          toolCount: toolNames.length,
          checkedTools: expectedTools,
          branchQueryNodes: parsed.nodes.length,
          fullQueryLen: fullLen,
          snapshotterCompactItems: snapParsed.items?.length ?? 0,
          snapshotterCompactLen: snapLen,
          maxTokensLen: tinyText.length,
          branchContentLen: contentParsed.content.length,
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  fail("MCP stdio smoke failed.", { error: message });
});
