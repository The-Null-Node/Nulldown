import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { webcrypto } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { CliCredentialBundleV1 } from "../../shared/auth/cliDevice";
import { createNulldownMcpServer } from "./server";
import { createNulldownMcpServer as createPackagedNulldownMcpServer } from "../../packages/nulldown-mcp/src/server";
import {
  createFileCliCredentialTokenProvider as createPackagedCredentialProvider,
  readCliCredential as readPackagedCredential,
} from "../../packages/nulldown-mcp/src/cliCredential";

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
  handler: Parameters<typeof createHttpServer>[0],
): Promise<{ server: Server; baseUrl: string }> => {
  const server = createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local test address.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const serverFactories = [
  ["source", createNulldownMcpServer],
  ["package", createPackagedNulldownMcpServer],
] as const;

const mcpEnvironmentNames = [
  "ND_AUTH_FILE",
  "ND_TOKEN",
  "VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK",
  "ND_MCP_LOG_LEVEL",
] as const;

const setMcpEnvironment = (values: Partial<Record<(typeof mcpEnvironmentNames)[number], string>>) => {
  const previous = new Map(mcpEnvironmentNames.map((name) => [name, process.env[name]]));
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
  credential: CliCredentialBundleV1;
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
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
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
  const [encryptionPublicJwk, signingPublicJwk, signingPrivateJwk, providerPublicJwk] =
    await Promise.all([
      crypto.subtle.exportKey("jwk", accountEncryptionPair.publicKey),
      crypto.subtle.exportKey("jwk", delegateSigningPair.publicKey),
      crypto.subtle.exportKey("jwk", delegateSigningPair.privateKey),
      crypto.subtle.exportKey("jwk", providerEncryptionPair.publicKey),
    ]);
  return {
    credential: {
      kind: "nulldown.cli-credential.v1",
      version: 1,
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
          schema: "nulldown.drop-device-delegation.v1",
          version: 1,
          accountId: "account-1",
          credentialId: "credential-1",
          delegateSigningPublicJwk: signingPublicJwk,
          encryptionKid: "account-encryption-1",
          encryptionPublicJwk,
          issuedAt: 1,
          expiresAt: Date.now() + 86_400_000,
          signature: { kid: "account-1", alg: "ECDSA_P256_SHA256", sig: "signature" },
        },
      },
    },
    providerPublicJwk: { ...providerPublicJwk, kid: "provider-1" },
  };
};

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

describe.each(serverFactories)("%s createNulldownMcpServer", (_name, createServer) => {
  it("rejects invalid diff_apply input at the MCP boundary", async () => {
    const server = createServer();
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
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("Input validation error");
      expect(result.content[0]?.text).toContain("diff_apply");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    { eventId: "retry-1" },
    { createdAt: 1 },
    { eventId: " retry-1", createdAt: 1 },
  ])("rejects invalid retry identity at the MCP boundary", async (identity) => {
    const server = createServer();
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
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("Input validation error");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("forwards a complete retry identity", async () => {
    let postedBody: unknown;
    const api = await listen((request, response) => {
      if (request.method !== "POST" || request.url !== "/api/diff/root-drop?branchId=branch-1") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          accepted: 1,
          deduplicated: 0,
          branchId: "branch-1",
          snapshotId: 1,
          totalStored: 1,
          acknowledgements: [
            { eventId: "retry-1", seq: 0, snapshotId: 1, status: "accepted" },
          ],
        }));
      });
    });
    const server = createServer();
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
          expect.objectContaining({ eventId: "retry-1", createdAt: 1_725_000_000_000 }),
        ],
      });
    } finally {
      await client.close();
      await server.close();
      await new Promise<void>((resolve, reject) =>
        api.server.close((error) => error ? reject(error) : resolve()),
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
    await writeFile(authFile, JSON.stringify(credential));
    const restoreEnvironment = setMcpEnvironment({
      ND_AUTH_FILE: authFile,
      VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK: JSON.stringify(providerPublicJwk),
      ND_MCP_LOG_LEVEL: "silent",
    });
    const server = createServer();
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
        api.server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it("requires re-enrollment when an auth file has no authoring authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    await writeFile(authFile, JSON.stringify({
      kind: "nulldown.cli-credential.v1",
      version: 1,
      baseUrl: "https://nulldown.test",
      userId: "user-1",
      accountId: "account-1",
      credentialId: "credential-1",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      accessExpiresAt: Date.now() + 60_000,
      credentialExpiresAt: Date.now() + 86_400_000,
      createdAt: Date.now(),
    }));
    const restoreEnvironment = setMcpEnvironment({ ND_AUTH_FILE: authFile, ND_MCP_LOG_LEVEL: "silent" });
    const server = createServer();
    const client = new Client({ name: "nulldown-test", version: "1.0.0" });
    const { clientTransport, serverTransport } = createTransportPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "drop_create",
        arguments: { baseUrl: "https://nulldown.test", content: "account content" },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("Run nd auth login again to enable account-owned authoring.");
    } finally {
      restoreEnvironment();
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects mismatched delegated authoring material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    const { credential } = await createAuthoringCredential();
    credential.authoring!.deviceDelegation.delegateSigningPublicJwk = {
      ...credential.authoring!.deviceDelegation.delegateSigningPublicJwk,
      x: "mismatched-signer",
    };
    await writeFile(authFile, JSON.stringify(credential));
    const restoreEnvironment = setMcpEnvironment({ ND_AUTH_FILE: authFile, ND_MCP_LOG_LEVEL: "silent" });
    const server = createServer();
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
      expect(result.content[0]?.text).toContain("Run nd auth login again to enable account-owned authoring.");
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
    const restoreEnvironment = setMcpEnvironment({ ND_TOKEN: "token-only", ND_MCP_LOG_LEVEL: "silent" });
    const server = createServer();
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
      expect(rejected.content[0]?.text).toContain("Run nd auth login again to enable account-owned authoring.");

      const legacy = await client.callTool({
        name: "drop_create",
        arguments: {
          baseUrl: api.baseUrl,
          content: "legacy plaintext",
          legacyPlaintext: true,
        },
      });
      expect(legacy.isError).toBeFalsy();
      expect(postedBody).toEqual({ content: "legacy plaintext", metadata: { themeId: "system" } });
    } finally {
      restoreEnvironment();
      await client.close();
      await server.close();
      await new Promise<void>((resolve, reject) =>
        api.server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });
});

describe("packaged MCP credential adapter", () => {
  it("preserves local authoring material when a bearer refresh rotates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nulldown-mcp-auth-"));
    const authFile = join(directory, "auth.json");
    const { credential } = await createAuthoringCredential();
    credential.accessExpiresAt = Date.now() + 1;
    await writeFile(authFile, JSON.stringify(credential));
    const replacement = {
      ...credential,
      refreshToken: "refresh-token-2",
      accessToken: "access-token-2",
      accessExpiresAt: Date.now() + 60_000,
    };
    delete replacement.authoring;
    const provider = createPackagedCredentialProvider({
      filePath: authFile,
      baseUrl: credential.baseUrl,
      fetch: async () => Response.json(replacement),
    });

    try {
      await expect(provider()).resolves.toBe("access-token-2");
      await expect(readPackagedCredential(authFile)).resolves.toEqual({
        ...replacement,
        authoring: credential.authoring,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
