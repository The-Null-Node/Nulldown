import { z } from "zod";
import {
  createNulldownClient,
  DEFAULT_NULLDOWN_BASE_URL,
  type CreateNulldownClientOptions,
  type NulldownEnvelopeProvider,
  type NulldownJsonValue,
} from "../client/nulldownClient";
import {
  createFileCliCredentialTokenProvider,
  normalizeCliCredentialBaseUrl,
  readCliCredential,
} from "../cli/cliCredential";
import { sealDropForAuthoring } from "../../shared/drop/authoringCrypto";
import { isDropEncryptionPublicJwk } from "../../shared/drop/deviceDelegation";
import type { DropEnvelopeV1, DropVisibility } from "../../shared/drop/types";
import { mcpLog } from "./logging";

const credentialProviders = new Map<string, ReturnType<typeof createFileCliCredentialTokenProvider>>();
const AUTHORING_REENROLL_MESSAGE = "Run nd auth login again to enable account-owned authoring.";

const warnLegacyPlaintext = (): void => {
  if (process.env.ND_MCP_LOG_LEVEL?.trim().toLowerCase() === "silent") return;
  process.stderr.write('{"level":"warn","event":"mcp.drop.legacy_plaintext"}\n');
};

interface CreateMcpClientOptions {
  visibility?: DropVisibility;
  legacyPlaintext?: boolean;
}

const importEncryptionKey = async (jwk: JsonWebKey): Promise<CryptoKey> =>
  await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );

const getProviderEncryption = async (): Promise<{ kid: string; publicKey: CryptoKey }> => {
  const raw = process.env.VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK;
  if (!raw) {
    throw new Error("Provider unlock policy requires VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK.");
  }
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw) as JsonWebKey;
  } catch {
    throw new Error("VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK must contain a public RSA JWK.");
  }
  if (!isDropEncryptionPublicJwk(jwk)) {
    throw new Error("VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK must contain a public RSA JWK.");
  }
  return {
    kid: typeof (jwk as Record<string, unknown>).kid === "string"
      ? String((jwk as Record<string, unknown>).kid)
      : "provider",
    publicKey: await importEncryptionKey(jwk),
  };
};

const createAccountEnvelopeProvider = (
  filePath: string,
  baseUrl: string,
  visibility: DropVisibility,
): NulldownEnvelopeProvider => ({
  seal: async ({ content, metadata }): Promise<DropEnvelopeV1> => {
    const credential = await readCliCredential(filePath);
    const authoring = credential?.authoring;
    if (
      !credential ||
      credential.baseUrl !== normalizeCliCredentialBaseUrl(baseUrl) ||
      !authoring ||
      !isDropEncryptionPublicJwk(authoring.deviceDelegation.encryptionPublicJwk)
    ) {
      throw new Error(AUTHORING_REENROLL_MESSAGE);
    }
    const accountEncryption = authoring.deviceDelegation.encryptionPublicJwk;
    const [encryptionPublicKey, signingPrivateKey, providerEncryption] = await Promise.all([
      importEncryptionKey(accountEncryption),
      crypto.subtle.importKey(
        "jwk",
        authoring.signingPrivateJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
      visibility === "private" ? Promise.resolve(undefined) : getProviderEncryption(),
    ]);
    return await sealDropForAuthoring({
      payload: { content, metadata },
      accountEncryption: {
        accountId: credential.accountId,
        encryptionKid: authoring.deviceDelegation.encryptionKid,
        encryptionPublicJwk: accountEncryption,
        encryptionPublicKey,
      },
      delegateSigning: {
        signingKid: authoring.signingKid,
        signingPublicJwk: authoring.signingPublicJwk,
        signingPrivateKey,
        deviceDelegation: authoring.deviceDelegation,
      },
      providerEncryption,
      visibility,
      unlockPolicy: visibility === "private" ? "vault-only" : "provider-escrow",
      metadata,
    });
  },
});

/** Shared optional client arguments accepted by Nulldown MCP tools. */
export const clientArgsSchema = {
  baseUrl: z
    .string()
    .url()
    .optional()
    .describe("Nulldown API base URL. Defaults to ND_BASE_URL or production."),
  accountId: z
    .string()
    .optional()
    .describe("Optional account id header for local/dev APIs."),
  clientId: z
    .string()
    .optional()
    .describe("Stable diff client id. Defaults to ND_CLIENT_ID when set."),
};

/** Recursive JSON value schema accepted by MCP tool metadata inputs. */
export const jsonValueSchema: z.ZodType<NulldownJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** JSON object schema accepted by MCP metadata inputs. */
export const jsonRecordSchema = z.record(z.string(), jsonValueSchema);

/** Client construction arguments accepted by every Nulldown MCP tool. */
export interface ClientArgs {
  baseUrl?: string;
  accountId?: string;
  clientId?: string;
}

/** Response control flags accepted by MCP tools. */
export interface McpResponseArgs {
  preview?: boolean;
  maxTokens?: number;
  format?: "compact" | "full";
}

export const mcpResponseArgsSchema = {
  preview: z.boolean().optional().describe("Return compact preview (default true)."),
  maxTokens: z.number().int().min(100).max(8000).optional().describe("Hard token cap (default 800)."),
  format: z.enum(["compact", "full"]).optional().describe("Response format."),
};

/** Extracts response control flags from tool args. */
export const extractMcpResponseArgs = (args: Record<string, unknown>): McpResponseArgs => ({
  preview: args.preview as boolean | undefined,
  maxTokens: args.maxTokens as number | undefined,
  format: args.format as "compact" | "full" | undefined,
});

/** Creates a Nulldown API client from MCP tool arguments. */
export const createClient = (args: ClientArgs = {}, createOptions: CreateMcpClientOptions = {}) => {
  const options: CreateNulldownClientOptions = {
    baseUrl: args.baseUrl,
    clientId: args.clientId,
  };
  const authFile = process.env.ND_AUTH_FILE?.trim();
  const staticToken = process.env.ND_TOKEN?.trim();
  if (createOptions.visibility && !createOptions.legacyPlaintext && !authFile && staticToken) {
    throw new Error(AUTHORING_REENROLL_MESSAGE);
  }
  if (createOptions.legacyPlaintext && (authFile || staticToken)) {
    warnLegacyPlaintext();
  }
  if (authFile) {
    const baseUrl = args.baseUrl ?? process.env.ND_BASE_URL ?? DEFAULT_NULLDOWN_BASE_URL;
    options.token = null;
    options.accountId = args.accountId ?? null;
    const key = `${baseUrl}\n${authFile}`;
    let provider = credentialProviders.get(key);
    if (!provider) {
      provider = createFileCliCredentialTokenProvider({ filePath: authFile, baseUrl, onRefresh: (event) => mcpLog(`mcp.auth.refresh_${event}` as const, event === "failed" ? "warn" : "info") });
      credentialProviders.set(key, provider);
    }
    options.bearerProvider = provider;
    if (createOptions.visibility && !createOptions.legacyPlaintext) {
      options.envelopeProvider = createAccountEnvelopeProvider(
        authFile,
        baseUrl,
        createOptions.visibility,
      );
    }
  } else if (args.accountId !== undefined) {
    options.accountId = args.accountId;
  }
  return createNulldownClient(options);
};
