import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface CliCredentialAuthoring {
  signingKid: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateJwk: JsonWebKey;
  deviceDelegation: {
    schema: "nulldown.drop-device-delegation.v1";
    version: 1;
    accountId: string;
    credentialId: string;
    delegateSigningPublicJwk: JsonWebKey;
    encryptionKid: string;
    encryptionPublicJwk: JsonWebKey;
    issuedAt: number;
    expiresAt: number;
    signature: { kid: string; alg: "ECDSA_P256_SHA256"; sig: string };
  };
}

interface CliCredentialBundleV1 {
  kind: "nulldown.cli-credential.v1";
  version: 1;
  baseUrl: string;
  userId: string;
  accountId: string;
  credentialId: string;
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  credentialExpiresAt: number;
  createdAt: number;
  authoring?: CliCredentialAuthoring;
}

const REFRESH_WINDOW_MS = 30_000;
export type CliCredentialRefreshEvent = "started" | "completed" | "failed";
export interface FileCliCredentialTokenProviderOptions {
  filePath: string;
  baseUrl: string;
  fetch?: typeof fetch;
  onRefresh?: (event: CliCredentialRefreshEvent) => void;
}

/** Normalizes an API origin stored in a packaged MCP credential. */
export const normalizeCliCredentialBaseUrl = (value: string): string => {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Nulldown credential is unavailable.");
  }
  return url.origin;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasPrivateJwkMaterial = (value: Record<string, unknown>): boolean =>
  ["d", "p", "q", "dp", "dq", "qi", "k"].some((key) => key in value);

const isEncryptionPublicJwk = (value: unknown): value is JsonWebKey =>
  isRecord(value) &&
  !hasPrivateJwkMaterial(value) &&
  value.kty === "RSA" &&
  typeof value.n === "string" &&
  typeof value.e === "string";

const isSigningPublicJwk = (value: unknown): value is JsonWebKey =>
  isRecord(value) &&
  !hasPrivateJwkMaterial(value) &&
  value.kty === "EC" &&
  value.crv === "P-256" &&
  typeof value.x === "string" &&
  typeof value.y === "string";

const isSigningPrivateJwk = (value: unknown): value is JsonWebKey =>
  isRecord(value) &&
  value.kty === "EC" &&
  value.crv === "P-256" &&
  typeof value.x === "string" &&
  typeof value.y === "string" &&
  typeof value.d === "string";

const serializeCanonicalJson = (value: unknown): string => {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!isRecord(entry)) return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
  };
  return JSON.stringify(normalize(value));
};

const isCliCredentialAuthoring = (value: unknown): value is CliCredentialAuthoring => {
  if (!isRecord(value) || !isRecord(value.deviceDelegation)) return false;
  const delegation = value.deviceDelegation;
  return (
    typeof value.signingKid === "string" &&
    isSigningPublicJwk(value.signingPublicJwk) &&
    isSigningPrivateJwk(value.signingPrivateJwk) &&
    delegation.schema === "nulldown.drop-device-delegation.v1" &&
    delegation.version === 1 &&
    typeof delegation.accountId === "string" &&
    typeof delegation.credentialId === "string" &&
    typeof delegation.encryptionKid === "string" &&
    isSigningPublicJwk(delegation.delegateSigningPublicJwk) &&
    isEncryptionPublicJwk(delegation.encryptionPublicJwk) &&
    typeof delegation.issuedAt === "number" &&
    typeof delegation.expiresAt === "number" &&
    delegation.expiresAt > delegation.issuedAt &&
    isRecord(delegation.signature) &&
    typeof delegation.signature.kid === "string" &&
    delegation.signature.alg === "ECDSA_P256_SHA256" &&
    typeof delegation.signature.sig === "string" &&
    serializeCanonicalJson(value.signingPublicJwk) ===
      serializeCanonicalJson(delegation.delegateSigningPublicJwk) &&
    value.signingPrivateJwk.x === value.signingPublicJwk.x &&
    value.signingPrivateJwk.y === value.signingPublicJwk.y
  );
};

const isCliCredentialBundle = (value: unknown): value is CliCredentialBundleV1 => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  return (
    credential.kind === "nulldown.cli-credential.v1" &&
    credential.version === 1 &&
    ["baseUrl", "userId", "accountId", "credentialId", "refreshToken", "accessToken"].every(
      (key) => typeof credential[key] === "string",
    ) &&
    ["accessExpiresAt", "credentialExpiresAt", "createdAt"].every(
      (key) => typeof credential[key] === "number" && Number.isFinite(credential[key]),
    ) &&
    (credential.authoring === undefined || isCliCredentialAuthoring(credential.authoring)) &&
    (credential.authoring === undefined || (
      credential.authoring.deviceDelegation.accountId === credential.accountId &&
      credential.authoring.deviceDelegation.credentialId === credential.credentialId
    ))
  );
};

/** Reads a packaged MCP credential without exposing it in diagnostics. */
export const readCliCredential = async (
  filePath: string,
): Promise<CliCredentialBundleV1 | null> => {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isCliCredentialBundle(value)
      ? { ...value, baseUrl: normalizeCliCredentialBaseUrl(value.baseUrl) }
      : null;
  } catch {
    return null;
  }
};

const writeCliCredential = async (
  filePath: string,
  credential: CliCredentialBundleV1,
): Promise<void> => {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

const mergeCliCredentialAuthoring = (
  current: CliCredentialBundleV1,
  replacement: CliCredentialBundleV1,
): CliCredentialBundleV1 => {
  if (!current.authoring) return replacement;
  if (
    current.accountId !== replacement.accountId ||
    current.credentialId !== replacement.credentialId
  ) {
    throw new Error("Nulldown credential refresh changed the delegated authoring identity.");
  }
  return { ...replacement, authoring: current.authoring };
};

/** Creates a private-file bearer provider for the packaged stdio MCP server. */
export const createFileCliCredentialTokenProvider = ({
  filePath,
  baseUrl,
  fetch: fetchImpl = fetch,
  onRefresh,
}: FileCliCredentialTokenProviderOptions) => {
  const origin = normalizeCliCredentialBaseUrl(baseUrl);
  let refreshing: Promise<CliCredentialBundleV1> | null = null;
  const current = async (): Promise<CliCredentialBundleV1> => {
    const credential = await readCliCredential(filePath);
    if (!credential || credential.baseUrl !== origin || credential.credentialExpiresAt <= Date.now()) {
      throw new Error("Nulldown credential is unavailable.");
    }
    return credential;
  };
  const refresh = async (rejectedToken?: string | null): Promise<CliCredentialBundleV1> => {
    if (refreshing) return await refreshing;
    refreshing = (async () => {
      const credential = await current();
      if (
        rejectedToken &&
        credential.accessToken !== rejectedToken &&
        credential.accessExpiresAt > Date.now() + REFRESH_WINDOW_MS
      ) {
        return credential;
      }
      onRefresh?.("started");
      try {
        const response = await fetchImpl(`${origin}/api/auth/cli/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: credential.refreshToken }),
        });
        const body = await response.json().catch(() => null);
        if (
          !response.ok ||
          !isCliCredentialBundle(body) ||
          normalizeCliCredentialBaseUrl(body.baseUrl) !== origin
        ) {
          throw new Error();
        }
        const replacement = mergeCliCredentialAuthoring(credential, body);
        await writeCliCredential(filePath, replacement);
        onRefresh?.("completed");
        return replacement;
      } catch {
        onRefresh?.("failed");
        throw new Error("Nulldown credential refresh failed.");
      }
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  };
  return async (
    { forceRefresh = false, rejectedToken }: { forceRefresh?: boolean; rejectedToken?: string | null } = {},
  ) => {
    const credential = await current();
    if (
      !forceRefresh &&
      credential.accessExpiresAt > Date.now() + REFRESH_WINDOW_MS
    ) {
      return credential.accessToken;
    }
    if (
      forceRefresh &&
      rejectedToken &&
      credential.accessToken !== rejectedToken &&
      credential.accessExpiresAt > Date.now() + REFRESH_WINDOW_MS
    ) {
      return credential.accessToken;
    }
    return (await refresh(rejectedToken)).accessToken;
  };
};
