import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { jest } from "@jest/globals";
import { webcrypto } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer as createHttpServer,
  type RequestListener,
  type Server,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { CliCredentialBundle } from "@thenullnode/nulldown/auth/cliDevice";
import { createNulldownMcpServer } from "./server";
import {
  createFileCliCredentialTokenProvider,
  readCliCredential,
  writeCliCredential,
  type CliCredentialFetch,
} from "@thenullnode/nulldown/auth/cliCredential";
import { encodeCliCredentialBundle } from "../../../shared/auth/codecs/cli-device-v1";

class LoopbackTransport implements Transport {
  peer?: LoopbackTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

const createTransportPair = () => {
  const clientTransport = new LoopbackTransport();
  const serverTransport = new LoopbackTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;
  return { clientTransport, serverTransport };
};

const listen = async (
  handler: RequestListener,
): Promise<{ server: Server; baseUrl: string }> => {
  const server = createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected local test address.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const readToolContent = (result: unknown) => {
  const content =
    typeof result === "object" && result !== null && "content" in result
      ? result.content
      : undefined;
  return (Array.isArray(content) ? content : []) as Array<{
    type: string;
    text?: string;
  }>;
};

const mcpEnvironmentNames = [
  "ND_AUTH_FILE",
  "ND_TOKEN",
  "VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK",
  "ND_MCP_LOG_LEVEL",
] as const;

const setMcpEnvironment = (
  values: Partial<Record<(typeof mcpEnvironmentNames)[number], string>>,
) => {
  const previous = new Map(
    mcpEnvironmentNames.map((name) => [name, process.env[name]]),
  );
  for (const name of mcpEnvironmentNames) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const name of mcpEnvironmentNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
};

const createAuthoringCredential = async (): Promise<{
  credential: CliCredentialBundle;
  providerPublicJwk: JsonWebKey;
}> => {
  const [accountEncryptionPair, delegateSigningPair, providerEncryptionPair] =
    (await Promise.all([
      crypto.subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"],
      ),
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]),
      crypto.subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"],
      ),
    ])) as [CryptoKeyPair, CryptoKeyPair, CryptoKeyPair];
  const [
    encryptionPublicJwk,
    signingPublicJwk,
    signingPrivateJwk,
    providerPublicJwk,
  ] = await Promise.all([
    crypto.subtle.exportKey("jwk", accountEncryptionPair.publicKey),
    crypto.subtle.exportKey("jwk", delegateSigningPair.publicKey),
    crypto.subtle.exportKey("jwk", delegateSigningPair.privateKey),
    crypto.subtle.exportKey("jwk", providerEncryptionPair.publicKey),
  ]);
  return {
    credential: {
      baseUrl: "https://nulldown.test",
      userId: "user-1",
      accountId: "account-1",
      credentialId: "credential-1",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      accessExpiresAt: Date.now() + 60_000,
      credentialExpiresAt: Date.now() + 86_400_000,
      createdAt: Date.now(),
      authoring: {
        signingKid: "delegate-1",
        signingPublicJwk,
        signingPrivateJwk,
        deviceDelegation: {
          accountId: "account-1",
          credentialId: "credential-1",
          delegateSigningPublicJwk: signingPublicJwk,
          encryptionKid: "account-encryption-1",
          encryptionPublicJwk,
          issuedAt: 1,
          expiresAt: Date.now() + 86_400_000,
          signature: {
            kid: "account-1",
            alg: "ECDSA_P256_SHA256",
            sig: "signature",
          },
        },
      },
    },
    providerPublicJwk: {
      ...providerPublicJwk,
      kid: "provider-1",
    } as JsonWebKey,
  };
};

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
});

describe("createNulldownMcpServer", () => {
  it.each([false, true])(
    "keeps strategy identity within the minimum budget (metadata: %s)",
    async (implicit) => {
      const requests: string[] = [];
      const api = await listen((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/api/get/short") {
          response.setHeader("X-Drop-Canonical-Id", "root");
          response.end(
            JSON.stringify({
              content: "# Title",
              metadata: {
                strategyRef: {
                  kind: "branch",
                  rootDropId: "root",
                  branchId: "branch",
                },
              },
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            rootDropId: "root",
            branchId: "branch",
            snapshotId: 7,
            items: [{ text: "oversized".repeat(1000) }],
          }),
        );
      });
      const restoreEnvironment = setMcpEnvironment({});
      const server = createNulldownMcpServer();
      const client = new Client({ name: "strategy-test", version: "1.0.0" });
      const { clientTransport, serverTransport } = createTransportPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: "strategy_get",
          arguments: {
            baseUrl: api.baseUrl,
            id: implicit ? "short" : "root",
            ...(implicit ? {} : { branchId: "branch" }),
            snapshotId: 7,
            query: "next",
            top: 2,
            maxTokens: 100,
            preview: false,
            format: "full",
          },
        });
        expect(result.isError).toBeFalsy();
        const text = readToolContent(result)[0]?.text ?? "";
        expect(text.length).toBeLessThanOrEqual(400);
        expect(JSON.parse(text)).toMatchObject({
          read: "branch",
          rootDropId: "root",
          branchId: "branch",
          snapshotId: 7,
          partial: true,
          truncated: true,
        });
        expect(requests).toHaveLength(implicit ? 2 : 1);
        if (implicit) expect(requests[0]).toBe("GET /api/get/short");
        expect(requests.at(-1)).toContain(
          "GET /api/branches/root/branch/resolved/query?",
        );
        expect(requests.at(-1)).toContain("maxTokens=100&preview=false");
        expect(requests.at(-1)).toContain("snapshotId=7");
      } finally {
        restoreEnvironment();
        await client.close();
        await server.close();
        api.server.closeAllConnections();
        await new Promise<void>((resolve) => api.server.close(() => resolve()));
      }
    },
  );

  it("rejects invalid diff_apply input at the MCP boundary", async () => {
    const server = createNulldownMcpServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "diff_apply",
        arguments: {
          dropId: "root-drop",
          ops: [
            {
              native: {
                op: 999,
                data: "not-base64",
              },
            },
          ],
        },
      });

      expect(result.isError).toBe(true);
      const content = readToolContent(result);
      expect(content[0]?.type).toBe("text");
      expect(content[0]?.text).toContain("Input validation error");
      expect(content[0]?.text).toContain("diff_apply");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    { eventId: "retry-1" },
    { createdAt: 1 },
    { eventId: " retry-1", createdAt: 1 },
    { eventId: "retry-1", createdAt: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid retry identity at the MCP boundary", async (identity) => {
    const server = createNulldownMcpServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "diff_apply",
        arguments: {
          dropId: "root-drop",
          ops: [{ type: "insert", start: 0, end: 0, text: "hello" }],
          ...identity,
        },
      });

      expect(result.isError).toBe(true);
      const content = readToolContent(result);
      expect(content[0]?.type).toBe("text");
      expect(content[0]?.text).toContain("Input validation error");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("forwards a complete retry identity", async () => {
    let postedBody: unknown;
    const api = await listen((request, response) => {
      if (
        request.method !== "POST" ||
        request.url !== "/api/diff/root-drop?branchId=branch-1"
      ) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            accepted: 1,
            deduplicated: 0,
            branchId: "branch-1",
            snapshotId: 1,
            totalStored: 1,
            acknowledgements: [
              { eventId: "retry-1", seq: 0, snapshotId: 1, status: "accepted" },
            ],
          }),
        );
      });
    });
    const server = createNulldownMcpServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "diff_apply",
        arguments: {
          baseUrl: api.baseUrl,
          dropId: "root-drop",
          branchId: "branch-1",
          eventId: "retry-1",
          createdAt: 1_725_000_000_000,
          ops: [{ type: "insert", start: 0, end: 0, text: "hello" }],
        },
      });

      expect(result.isError).toBeFalsy();
      expect(postedBody).toEqual({
        version: 1,
        events: [
          expect.objectContaining({
            eventId: "retry-1",
            createdAt: 1_725_000_000_000,
          }),
        ],
      });
    } finally {
      await client.close();
      await server.close();
      await new Promise<void>((resolve, reject) =>
        api.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("seals unlisted drop_create requests with an authoring credential", async () => {
    let postedBody: unknown;
    const api = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "drop-1" }));
      });
    });
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    const { credential, providerPublicJwk } = await createAuthoringCredential();
    credential.baseUrl = api.baseUrl;
    await writeFile(
      authFile,
      JSON.stringify(encodeCliCredentialBundle(credential)),
    );
    const restoreEnvironment = setMcpEnvironment({
      ND_AUTH_FILE: authFile,
      VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK: JSON.stringify(providerPublicJwk),
      ND_MCP_LOG_LEVEL: "silent",
    });
    const server = createNulldownMcpServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "drop_create",
        arguments: { baseUrl: api.baseUrl, content: "account content" },
      });

      expect(result.isError).toBeFalsy();
      expect(postedBody).toEqual({
        envelope: expect.objectContaining({
          accountId: "account-1",
          visibility: "unlisted",
          unlockPolicy: "provider-escrow",
          providerEscrow: expect.objectContaining({ kid: "provider-1" }),
        }),
      });
      expect(JSON.stringify(postedBody)).not.toContain("account content");
      expect(JSON.stringify(postedBody)).not.toContain("signingPrivateJwk");
    } finally {
      restoreEnvironment();
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) =>
        api.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("requires re-enrollment when an auth file has no authoring authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    await writeFile(
      authFile,
      JSON.stringify(
        encodeCliCredentialBundle({
          baseUrl: "https://nulldown.test",
          userId: "user-1",
          accountId: "account-1",
          credentialId: "credential-1",
          refreshToken: "refresh-token",
          accessToken: "access-token",
          accessExpiresAt: Date.now() + 60_000,
          credentialExpiresAt: Date.now() + 86_400_000,
          createdAt: Date.now(),
        }),
      ),
    );
    const restoreEnvironment = setMcpEnvironment({
      ND_AUTH_FILE: authFile,
      ND_MCP_LOG_LEVEL: "silent",
    });
    const server = createNulldownMcpServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "drop_create",
        arguments: {
          baseUrl: "https://nulldown.test",
          content: "account content",
        },
      });

      expect(result.isError).toBe(true);
      const content = readToolContent(result);
      expect(content[0]?.type).toBe("text");
      expect(content[0]?.text).toContain(
        "Run nd auth login again to enable account-owned authoring.",
      );
    } finally {
      restoreEnvironment();
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an authoring credential whose delegation signer does not match", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    const { credential } = await createAuthoringCredential();
    credential.authoring!.deviceDelegation.delegateSigningPublicJwk = {
      ...credential.authoring!.deviceDelegation.delegateSigningPublicJwk,
      x: "mismatched-signer",
    };
    await writeFile(
      authFile,
      JSON.stringify(encodeCliCredentialBundle(credential)),
    );
    const restoreEnvironment = setMcpEnvironment({
      ND_AUTH_FILE: authFile,
      ND_MCP_LOG_LEVEL: "silent",
    });
    const server = createNulldownMcpServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "drop_create",
        arguments: { baseUrl: credential.baseUrl, content: "account content" },
      });

      expect(result.isError).toBe(true);
      expect(readToolContent(result)[0]?.text).toContain(
        "Run nd auth login again to enable account-owned authoring.",
      );
    } finally {
      restoreEnvironment();
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects token-only authoring but permits explicit legacy plaintext", async () => {
    let postedBody: unknown;
    const api = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "drop-1" }));
      });
    });
    const restoreEnvironment = setMcpEnvironment({
      ND_TOKEN: "token-only",
      ND_MCP_LOG_LEVEL: "silent",
    });
    const server = createNulldownMcpServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const rejected = await client.callTool({
        name: "drop_create",
        arguments: { baseUrl: api.baseUrl, content: "account content" },
      });
      expect(rejected.isError).toBe(true);
      expect(readToolContent(rejected)[0]?.text).toContain(
        "Run nd auth login again to enable account-owned authoring.",
      );

      const legacy = await client.callTool({
        name: "drop_create",
        arguments: {
          baseUrl: api.baseUrl,
          content: "legacy plaintext",
          legacyPlaintext: true,
        },
      });
      expect(legacy.isError).toBeFalsy();
      expect(postedBody).toEqual({
        content: "legacy plaintext",
        metadata: { themeId: "system" },
      });
    } finally {
      restoreEnvironment();
      await client.close();
      await server.close();
      await new Promise<void>((resolve, reject) =>
        api.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("shared CLI credential adapter used by MCP", () => {
  it("treats malformed credential JSON as unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    await writeFile(authFile, '{"kind":');
    const provider = createFileCliCredentialTokenProvider({
      filePath: authFile,
      baseUrl: "https://nulldown.test",
    });

    try {
      await expect(readCliCredential(authFile)).resolves.toBeNull();
      await expect(provider()).rejects.toThrow(
        "Nulldown credential is unavailable.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "private encryption JWK material",
      (credential: ReturnType<typeof encodeCliCredentialBundle>) => {
        (
          credential.authoring!.deviceDelegation.encryptionPublicJwk as Record<
            string,
            unknown
          >
        ).d = "private";
      },
    ],
    [
      "an unexpected delegation field",
      (credential: ReturnType<typeof encodeCliCredentialBundle>) => {
        (
          credential.authoring!.deviceDelegation as unknown as Record<
            string,
            unknown
          >
        ).unexpected = true;
      },
    ],
  ])("rejects authoring credentials with %s", async (_description, mutate) => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    const { credential } = await createAuthoringCredential();
    const encodedCredential = encodeCliCredentialBundle(credential);
    mutate(encodedCredential);
    await writeFile(authFile, JSON.stringify(encodedCredential));

    try {
      await expect(readCliCredential(authFile)).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes exact credential JSON atomically with private permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "nested", "auth.json");
    const { credential } = await createAuthoringCredential();

    try {
      await writeCliCredential(authFile, credential);

      await expect(readFile(authFile, "utf8")).resolves.toBe(
        `${JSON.stringify(encodeCliCredentialBundle(credential))}\n`,
      );
      expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
      expect((await stat(authFile)).mode & 0o777).toBe(0o600);
      await expect(readdir(join(directory, "nested"))).resolves.toEqual([
        "auth.json",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves origin and credential-expiry error semantics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    const { credential } = await createAuthoringCredential();
    await writeCliCredential(authFile, credential);

    try {
      const wrongOriginProvider = createFileCliCredentialTokenProvider({
        filePath: authFile,
        baseUrl: "https://other.nulldown.test",
      });
      await expect(wrongOriginProvider()).rejects.toThrow(
        "Nulldown credential is unavailable.",
      );

      await writeCliCredential(authFile, {
        ...credential,
        credentialExpiresAt: Date.now() - 1,
      });
      const expiredProvider = createFileCliCredentialTokenProvider({
        filePath: authFile,
        baseUrl: credential.baseUrl,
      });
      await expect(expiredProvider()).rejects.toThrow(
        "Nulldown credential has expired.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent bearer refreshes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    const { credential } = await createAuthoringCredential();
    credential.accessExpiresAt = Date.now() + 1;
    await writeCliCredential(authFile, credential);
    const replacement = {
      ...credential,
      accessToken: "access-token-2",
      accessExpiresAt: Date.now() + 60_000,
    };
    let releaseRefresh: (() => void) | undefined;
    const pendingRefresh = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = jest.fn<CliCredentialFetch>(async () => {
      await pendingRefresh;
      return Response.json(encodeCliCredentialBundle(replacement));
    });
    const provider = createFileCliCredentialTokenProvider({
      filePath: authFile,
      baseUrl: credential.baseUrl,
      fetch: fetchImpl,
    });

    try {
      const first = provider({
        forceRefresh: true,
        rejectedToken: credential.accessToken,
      });
      const second = provider({
        forceRefresh: true,
        rejectedToken: credential.accessToken,
      });
      await Promise.resolve();
      releaseRefresh?.();

      await expect(Promise.all([first, second])).resolves.toEqual([
        "access-token-2",
        "access-token-2",
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves local authoring material when a bearer refresh rotates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    const { credential } = await createAuthoringCredential();
    credential.accessExpiresAt = Date.now() + 1;
    await writeFile(
      authFile,
      JSON.stringify(encodeCliCredentialBundle(credential)),
    );
    const replacement = {
      ...credential,
      refreshToken: "refresh-token-2",
      accessToken: "access-token-2",
      accessExpiresAt: Date.now() + 60_000,
    };
    delete replacement.authoring;
    const provider = createFileCliCredentialTokenProvider({
      filePath: authFile,
      baseUrl: credential.baseUrl,
      fetch: async () => Response.json(encodeCliCredentialBundle(replacement)),
    });

    try {
      await expect(provider()).resolves.toBe("access-token-2");
      await expect(readCliCredential(authFile)).resolves.toEqual({
        ...replacement,
        authoring: credential.authoring,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a refresh that changes the delegated authoring identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    const { credential } = await createAuthoringCredential();
    credential.accessExpiresAt = Date.now() + 1;
    await writeCliCredential(authFile, credential);
    const replacement = {
      ...credential,
      accountId: "account-2",
      accessToken: "access-token-2",
      authoring: undefined,
    };
    const provider = createFileCliCredentialTokenProvider({
      filePath: authFile,
      baseUrl: credential.baseUrl,
      fetch: async () => Response.json(encodeCliCredentialBundle(replacement)),
    });

    try {
      await expect(provider()).rejects.toThrow(
        "Nulldown credential persistence failed.",
      );
      await expect(readCliCredential(authFile)).resolves.toEqual(credential);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports credential persistence failures and emits safe refresh events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    const { credential } = await createAuthoringCredential();
    credential.accessExpiresAt = Date.now() + 1;
    await writeCliCredential(authFile, credential);
    const replacement = {
      ...credential,
      accessToken: "access-token-2",
      accessExpiresAt: Date.now() + 60_000,
    };
    const events: string[] = [];
    const provider = createFileCliCredentialTokenProvider({
      filePath: authFile,
      baseUrl: credential.baseUrl,
      fetch: async () => {
        await rm(directory, { recursive: true, force: true });
        await writeFile(directory, "blocks credential directory recreation");
        return Response.json(encodeCliCredentialBundle(replacement));
      },
      onRefresh: (event) => events.push(event),
    });

    try {
      await expect(provider()).rejects.toThrow(
        "Nulldown credential persistence failed.",
      );
      expect(events).toEqual(["started", "failed"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
