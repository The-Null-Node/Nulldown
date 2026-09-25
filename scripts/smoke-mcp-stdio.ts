import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer as createHttpServer } from "node:http";

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

const createMemoryApi = async () => {
  const records = new Map<string, Record<string, unknown>>();
  let requestCount = 0;
  let generatedId = 0;
  const server = createHttpServer(async (request, response) => {
    requestCount += 1;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = url.pathname.match(
      /^\/api\/branches\/([^/]+)\/([^/]+)\/memory\/(facts|procedures|query)$/,
    );
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    const rootDropId = decodeURIComponent(match[1]);
    const branchId = decodeURIComponent(match[2]);
    const action = match[3];
    response.setHeader("Content-Type", "application/json");

    if (request.method === "GET" && action === "query") {
      const kind = url.searchParams.get("kind");
      const selected = [...records.values()].filter(
        (record) => !kind || record.kind === kind,
      );
      response.end(JSON.stringify({ rootDropId, branchId, records: selected }));
      return;
    }

    if (request.method !== "POST" || (action !== "facts" && action !== "procedures")) {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const kind = action === "facts" ? "fact" : "procedure";
    const prefix = kind === "fact" ? "memfact" : "memproc";
    const recordId = typeof body.recordId === "string"
      ? body.recordId
      : `${prefix}:generated-${++generatedId}`;
    const sourceRefs = body.sourceRefs ?? [{ kind: "branch", rootDropId, branchId }];
    const record = {
      version: 1,
      kind,
      ...body,
      recordId,
      rootDropId,
      branchId,
      sourceRefs,
      createdAt: Date.now(),
    };
    records.set(`${kind}:${recordId}`, record);
    response.writeHead(201).end(JSON.stringify({ rootDropId, branchId, record }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Memory API failed to listen.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestCount: () => requestCount,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
      server.closeAllConnections();
    },
  };
};

const verifyMemoryContract = async (
  client: Client,
  listed: Awaited<ReturnType<Client["listTools"]>>,
  api: Awaited<ReturnType<typeof createMemoryApi>>,
) => {
  for (const name of ["memory_fact", "memory_procedure"]) {
    const schema = listed.tools.find((tool) => tool.name === name)?.inputSchema as {
      properties?: Record<string, { type?: string }>;
    } | undefined;
    if (
      schema?.properties?.recordId?.type !== "string" ||
      schema.properties.sourceRefs?.type !== "array"
    ) {
      fail("Installed MCP did not advertise deterministic memory inputs.", { name, schema });
    }
  }

  const sourceRefs = [
    { kind: "snapshot", rootDropId: "source", branchId: "source-branch", snapshotId: 7 },
    { kind: "mcp", toolId: "installed-package-smoke" },
  ];
  const writes = [
    {
      name: "memory_fact",
      kind: "fact",
      recordId: "memfact:installed-retry",
      payload: { text: "Installed deterministic fact." },
    },
    {
      name: "memory_procedure",
      kind: "procedure",
      recordId: "memproc:installed-retry",
      payload: { goal: "Retry safely", summary: "Reuse one procedure id.", steps: [] },
    },
  ] as const;

  for (const write of writes) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await client.callTool({
        name: write.name,
        arguments: {
          baseUrl: api.baseUrl,
          rootId: "root",
          branchId: "branch",
          recordId: write.recordId,
          sourceRefs,
          ...write.payload,
        },
      });
      const record = (JSON.parse(readTextContent(result)) as {
        record?: { recordId?: string; sourceRefs?: unknown };
      }).record;
      if (
        result.isError ||
        record?.recordId !== write.recordId ||
        JSON.stringify(record.sourceRefs) !== JSON.stringify(sourceRefs)
      ) {
        fail("Installed MCP did not preserve memory identity and provenance.", { write, record });
      }
    }
    const query = await client.callTool({
      name: "memory_query",
      arguments: {
        baseUrl: api.baseUrl,
        rootId: "root",
        branchId: "branch",
        kind: write.kind,
        includeRecords: true,
      },
    });
    const queried = JSON.parse(readTextContent(query)) as {
      records?: Array<{ recordId?: string; sourceRefs?: unknown }>;
    };
    if (
      queried.records?.length !== 1 ||
      queried.records[0]?.recordId !== write.recordId ||
      JSON.stringify(queried.records[0]?.sourceRefs) !== JSON.stringify(sourceRefs)
    ) {
      fail("Installed MCP retry did not leave one logical memory record.", { write, queried });
    }
  }

  for (const write of writes) {
    const result = await client.callTool({
      name: write.name,
      arguments: {
        baseUrl: api.baseUrl,
        rootId: "legacy-root",
        branchId: "legacy-branch",
        ...write.payload,
      },
    });
    const record = (JSON.parse(readTextContent(result)) as {
      record?: { recordId?: string; sourceRefs?: unknown };
    }).record;
    const prefix = write.kind === "fact" ? "memfact:" : "memproc:";
    const expectedRefs = [
      { kind: "branch", rootDropId: "legacy-root", branchId: "legacy-branch" },
    ];
    if (
      result.isError ||
      !record?.recordId?.startsWith(prefix) ||
      JSON.stringify(record.sourceRefs) !== JSON.stringify(expectedRefs)
    ) {
      fail("Installed MCP changed omitted memory input behavior.", { write, record });
    }
  }

  const beforeInvalid = api.requestCount();
  const invalid = await client.callTool({
    name: "memory_fact",
    arguments: {
      baseUrl: api.baseUrl,
      rootId: "root",
      branchId: "branch",
      text: "Invalid provenance",
      sourceRefs: [{ kind: "branch", rootDropId: "missing-branch-id" }],
    },
  });
  if (
    !invalid.isError ||
    !readTextContent(invalid).includes("Input validation error") ||
    api.requestCount() !== beforeInvalid
  ) {
    fail("Installed MCP accepted malformed source refs.", { invalid });
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
  const memoryApi = await createMemoryApi();
  try {
    await withTimeout(client.connect(transport), "MCP initialize");
    const listed = await withTimeout(client.listTools(), "MCP tools/list");
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    const missingTools = expectedTools.filter((tool) => !toolNames.includes(tool));
    if (missingTools.length > 0) {
      fail("MCP tools/list missed expected tools.", { missingTools, toolNames });
    }
    const dropCreate = listed.tools.find((tool) => tool.name === "drop_create");
    if (
      !dropCreate?.description?.includes("ND_AUTH_FILE") ||
      !dropCreate.description.includes("legacyPlaintext")
    ) {
      fail("MCP drop_create did not expose account-authoring guidance.", { dropCreate });
    }
    await verifyMemoryContract(client, listed, memoryApi);

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
          rootId: "ofBVsjWZ1Lc3",
          branchId: "clone_account:2d89645f-f4b5-40be-a890-9e279ff4c46b",
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
    try {
      await client.close();
    } finally {
      await memoryApi.close();
    }
  }
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  fail("MCP stdio smoke failed.", { error: message });
});
