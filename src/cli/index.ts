import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import packageJson from "../../package.json";
import {
  isDropDiffEnvelope,
  isDropDiffEventMetadata,
  type DropDiffEnvelope,
  type DropDiffEventMetadata,
} from "../../shared/drop/diff";
import {
  buildDiffSigningPayload,
  DIFF_CLIENT_ID_HEADER,
  DIFF_SECRET_KID_HEADER,
  DIFF_SIGNATURE_HEADER,
  DIFF_SIGNATURE_PREFIX,
  DIFF_TIMESTAMP_HEADER,
  decodeDiffAuthRegisterResponse,
} from "../../shared/drop/diffAuth";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../shared/drop/branch";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../shared/drop/resolved/constants";
import type { CliCredentialBundle } from "../../shared/auth/cli-device";
import { decodeCliCredentialBundle } from "../../shared/auth/codecs/cli-device-v1";
import { createAdminCommand } from "./commands/admin";
import { createAuthCommand } from "./commands/auth";
import { createBranchCommand } from "./commands/branches";
import { createDiffCommand } from "./commands/diffs";
import { createDoctorCommand } from "./commands/doctor";
import { createDropCommands } from "./commands/drops";
import {
  createServeCommand,
  type ServeCommandDependencies,
} from "./commands/serve";
import { createSmokeCommand } from "./commands/smoke";
import {
  clearCliCredential,
  isCliCredentialForBaseUrl,
  readCliCredential,
  writeCliCredential,
} from "./auth";
import { mergeCliCredentialAuthoring } from "./cli-credential";
import { flagString, hasFlag, parseArgs, type ParsedArgs } from "./core/args";
import { findCliCommand, type CliCommand } from "./core/command";
import {
  createCliDiagnostics,
  type CliDiagnostics,
} from "./core/diagnostics";
import { createHttpNulldownRuntime } from "./runtime/http-runtime";
import type {
  AdminBackfillTarget,
  DiffEnvelopeHeadersRequest,
  DropReadResult,
  NulldownRuntime,
} from "./runtime/types";

export {
  buildSeedDropContent,
  buildSeedDropMetadata,
  buildSeedNextCommands,
  isSeedCreateArgs,
  resolveSeedTitle,
} from "./seed";

interface CliConfig {
  baseUrl: string;
  token: string | null;
  accountId: string | null;
  clientId: string | null;
  configDir: string;
  diffAuthDir: string;
  diffAuthToken: string | null;
  diffAuthTokenPath: string;
  authFilePath: string;
  authCredential: CliCredentialBundle | null;
  authRefreshPromise: Promise<boolean> | null;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  requestTimeoutMs: number;
}

/** Result returned by one CLI invocation without terminating the host process. */
export interface CliExitResult {
  /** Process exit code the executable wrapper should expose. */
  exitCode: number;
}

/** Portable HTTP request operation accepted by the CLI runtime. */
export type CliFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Injectable process and transport boundaries used by `runCli`. */
export interface RunCliDependencies {
  /** Writes one complete stdout value. */
  stdout?(text: string): void;
  /** Writes one complete stderr value. */
  stderr?(text: string): void;
  /** Performs outbound HTTP requests. */
  fetch?: CliFetch;
  /** Reads stdin when a command uses `-`. */
  readStdin?(): Promise<string>;
  /** Generates a correlation id for one outbound request. */
  createRequestId?(): string;
  /** Returns the current clock value in milliseconds. */
  now?(): number;
  /** Aborts outbound requests after this duration. */
  requestTimeoutMs?: number;
  /** Programmatic dependencies for the embedded local server command. */
  serve?: Pick<ServeCommandDependencies, "data">;
}

interface ResolvedRunCliDependencies {
  stdout(text: string): void;
  stderr(text: string): void;
  fetch: CliFetch;
  readStdin(): Promise<string>;
  createRequestId(): string;
  now(): number;
  requestTimeoutMs: number;
  serve: Pick<ServeCommandDependencies, "data">;
}

interface DiffClientKeysRecord {
  version: 1;
  clientId: string;
  createdAt: number;
  encryptionPublicJwk: JsonWebKey;
  encryptionPrivateJwk: JsonWebKey;
}

interface DiffCredentialEntry {
  version: 1;
  dropId: string;
  branchId: string;
  baseUrl: string;
  clientId: string;
  kid: string;
  secret: string;
  createdAt: number;
  expiresAt: number | null;
}

interface DiffAuthTokenBundle {
  version: 1;
  kind: "nulldown.diff-auth.v1";
  createdAt: number;
  keys: DiffClientKeysRecord | null;
  credentials: Record<string, DiffCredentialEntry>;
}

interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  text: string;
  data: T | null;
}

class CliError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    options: { status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.status = options.status;
    this.code = options.code;
  }
}

const DEFAULT_BASE_URL = "https://nulldown.app";
const DEFAULT_CONFIG_DIR_NAME = "nulldown";
const DEFAULT_DIFF_AUTH_TOKEN_FILE = "diff-auth.token";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const DIFF_AUTH_TOKEN_KIND = "nulldown.diff-auth.v1";
const DIFF_AUTH_TOKEN_PREFIX = "ndauth.v1.";
const textDecoder = new TextDecoder();

const resolveRunCliDependencies = (
  dependencies: RunCliDependencies = {},
): ResolvedRunCliDependencies => ({
  stdout: dependencies.stdout ?? ((text) => console.log(text)),
  stderr: dependencies.stderr ?? ((text) => console.error(text)),
  fetch: dependencies.fetch ?? globalThis.fetch,
  readStdin: dependencies.readStdin ?? (() => Bun.stdin.text()),
  createRequestId: dependencies.createRequestId ?? randomUUID,
  now: dependencies.now ?? Date.now,
  requestTimeoutMs:
    dependencies.requestTimeoutMs !== undefined &&
    Number.isInteger(dependencies.requestTimeoutMs) &&
    dependencies.requestTimeoutMs >= 1 &&
    dependencies.requestTimeoutMs <= MAX_REQUEST_TIMEOUT_MS
      ? dependencies.requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS,
  serve: dependencies.serve ?? {},
});

const helpText = `Nulldown CLI

Usage:
  nd <command> [args] [flags]

Drop commands:
  create <file|->                    Create a plaintext drop
  create --seed [title] [--intent <text>] [--labels <csv>] [--resolve-branch]
                                      Create a tiny semantic seed for diff-built docs
  get <id>                           Fetch a drop
  update <id> <file|->               Revision-safe root upsert
  delete <id>                        Revision-safe delete
  list                               List public drops
  search [query]                     Search indexed drops

Branch commands:
  branch list <rootId>
  branch resolve <dropId>
  branch content <rootId> <branchId>
  branch snapshots <rootId> <branchId>
  branch query <rootId> <branchId> [--resolver <id>] [--query <text>] [--top <n>] [--kind <csv>] [--from-seq <n>] [--to-seq <n>]
  branch heap-update <rootId> <branchId> [--resolver <id|all>] [--snapshot <n|latest>]  Repair/materialize resolved heaps
  branch memory query <rootId> <branchId> [--query <text>] [--kind <kind>] [--labels <a,b>]
  branch memory fact <rootId> <branchId> --text <text> [--title <text>] [--labels <a,b>]
  branch memory procedure <rootId> <branchId> --goal <text> --summary <text> [--steps <json>]
  branch memory delete <rootId> <branchId> <recordId>
  branch priority <rootId> <branchId> --priority <n> [--node <id>|--heap|--diff <eventId>] [--reason <text>]
  branch priority list <rootId> <branchId> [--target-kind <kind>] [--target <id>]
  branch priority delete <rootId> <branchId> <factId>
  branch promote <rootId> <branchId> --expected-snapshot <n> --idempotency-key <key>

Diff commands:
  diff poll <dropId> [--cursor <n>] [--limit <n>]
  diff latest <dropId>
  diff apply <dropId> --branch <branchId> [--metadata-file <file>] [--event-id <id> --created-at <ms>] [--insert pos:text] [--delete start:end]
  diff replace <dropId> --branch <branchId> --to-file <file> [--from-file <file>] [--metadata-file <file>]
  diff batch <dropId> --branch <branchId> --body-file <file|->
  diff event <dropId> --body-file <file|->
  diff keygen [--client <id>] [--force]
  diff register <dropId>
  diff sign <dropId> --body-file <file|->
  diff token export [dropId]
  diff token import <token|-> [--force]

Auth and admin:
  auth session --account <id> --proof <file|->
  auth login [--no-browser] [--name <name>]
  auth status | refresh | logout
  admin branch-backfill <rootId>
  admin index-backfill
  admin metadata-backfill [--account-library-only]
  serve [--host <host>] [--port <port>] [--data-dir <dir>] [--migrations-dir <dir>] [--no-sqlite]
  doctor
  smoke diff

Global flags:
  --version          Print the CLI version
  --base <url>       API base URL (default: ${DEFAULT_BASE_URL})
  --json             Stable JSON output
  --token <token>    Account bearer token
  --account <id>     Account ID header for dev environments
  --client <id>      Stable client ID
  --config <file>    JSON config file
  --config-dir <dir> Config directory (default: ~/.config/nulldown)
  --auth-file <file> Credential file (default: ~/.config/nulldown/auth.json)
  --diff-auth-token <token>
                     Inline diff auth token
  --timeout-ms <n>   Abort HTTP requests after n milliseconds (default: ${DEFAULT_REQUEST_TIMEOUT_MS})
  --quiet            Reduce human output
  --verbose          More diagnostics
`;

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
};

const defaultConfigDir = (): string => {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  return resolve(
    xdgConfigHome
      ? join(xdgConfigHome, DEFAULT_CONFIG_DIR_NAME)
      : join(homedir(), ".config", DEFAULT_CONFIG_DIR_NAME),
  );
};

const readConfig = async (args: ParsedArgs): Promise<Partial<CliConfig>> => {
  const configPath = flagString(args, "config") || process.env.ND_CONFIG;
  if (!configPath) return {};
  return (await readJsonFile<Partial<CliConfig>>(resolve(configPath))) ?? {};
};

const resolveRequestTimeoutMs = (
  args: ParsedArgs,
  fileConfig: Partial<CliConfig>,
  defaultValue: number,
): number => {
  const value =
    flagString(args, "timeout-ms") ||
    process.env.ND_REQUEST_TIMEOUT_MS ||
    fileConfig.requestTimeoutMs;
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new CliError(
      `Request timeout must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}.`,
      { code: "invalid_request_timeout" },
    );
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new CliError(
      `Request timeout must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}.`,
      {
        code: "invalid_request_timeout",
      },
    );
  }
  return parsed;
};

const resolveConfig = async (
  args: ParsedArgs,
  fileConfig: Partial<CliConfig>,
  defaultRequestTimeoutMs: number,
): Promise<CliConfig> => {
  const configDir = resolve(
    flagString(args, "config-dir") ||
      flagString(args, "diff-auth-dir") ||
      process.env.ND_CONFIG_DIR ||
      process.env.ND_DIFF_AUTH_DIR ||
      fileConfig.configDir ||
      fileConfig.diffAuthDir ||
      defaultConfigDir(),
  );
  const baseUrl = (
    flagString(args, "base") ||
    process.env.ND_BASE_URL ||
    fileConfig.baseUrl ||
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");
  const authFilePath = resolve(
    flagString(args, "auth-file") ||
      process.env.ND_AUTH_FILE ||
      fileConfig.authFilePath ||
      join(configDir, "auth.json"),
  );
  const directToken =
    flagString(args, "token") || process.env.ND_TOKEN || fileConfig.token || null;
  const storedCredential = await readCliCredential(authFilePath);
  const authCredential = isCliCredentialForBaseUrl(storedCredential, baseUrl)
    ? storedCredential
    : null;

  return {
    baseUrl,
    token: directToken || authCredential?.accessToken || null,
    accountId:
      flagString(args, "account") ||
      process.env.ND_ACCOUNT_ID ||
      fileConfig.accountId ||
      null,
    clientId:
      flagString(args, "client") ||
      process.env.ND_CLIENT_ID ||
      fileConfig.clientId ||
      null,
    configDir,
    diffAuthDir: configDir,
    diffAuthToken:
      flagString(args, "diff-auth-token") ||
      process.env.ND_DIFF_AUTH_TOKEN ||
      fileConfig.diffAuthToken ||
      null,
    diffAuthTokenPath: resolve(
      flagString(args, "diff-auth-token-file") ||
        process.env.ND_DIFF_AUTH_TOKEN_FILE ||
        fileConfig.diffAuthTokenPath ||
        join(configDir, DEFAULT_DIFF_AUTH_TOKEN_FILE),
    ),
    authFilePath,
    authCredential: directToken ? null : authCredential,
    authRefreshPromise: null,
    json: hasFlag(args, "json") || Boolean(fileConfig.json),
    quiet: hasFlag(args, "quiet") || Boolean(fileConfig.quiet),
    verbose: hasFlag(args, "verbose") || Boolean(fileConfig.verbose),
    requestTimeoutMs: resolveRequestTimeoutMs(
      args,
      fileConfig,
      defaultRequestTimeoutMs,
    ),
  };
};

const redactText = (value: string, secrets: readonly string[]): string =>
  secrets.reduce(
    (output, secret) =>
      secret ? output.split(secret).join("[redacted]") : output,
    value,
  );

const redact = (value: unknown, secrets: readonly string[] = []): unknown => {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, secrets));
  }
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    const isPresenceFlag =
      typeof entry === "boolean" && lowerKey.startsWith("has");
    const isLocationField =
      typeof entry === "string" && /(path|dir|file)$/i.test(key);
    if (
      !isPresenceFlag &&
      !isLocationField &&
      /token|secret|private|wrappedkey|signature|sig/i.test(key)
    ) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = redact(entry, secrets);
  }
  return output;
};

const environmentSensitiveValues = (): Array<string | null | undefined> => [
  process.env.ND_TOKEN,
  process.env.ND_DIFF_AUTH_TOKEN,
  process.env.DIFF_WEBHOOK_SECRET,
  process.env.METADATA_BACKFILL_TOKEN,
  process.env.DROP_INDEX_BACKFILL_TOKEN,
  process.env.BRANCH_HEAP_BACKFILL_TOKEN,
];

const compactSensitiveValues = (
  values: Array<string | null | undefined>,
): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))];

const sensitiveValues = (config: CliConfig): string[] =>
  compactSensitiveValues([
    config.token,
    config.diffAuthToken,
    ...environmentSensitiveValues(),
  ]);

const unresolvedSensitiveValues = (args: ParsedArgs): string[] =>
  compactSensitiveValues([
    flagString(args, "token"),
    flagString(args, "diff-auth-token"),
    ...environmentSensitiveValues(),
  ]);

const print = (
  config: CliConfig,
  dependencies: ResolvedRunCliDependencies,
  value: unknown,
  human?: string,
): void => {
  if (config.json) {
    dependencies.stdout(JSON.stringify(redact(value), null, 2));
    return;
  }
  if (human !== undefined) {
    if (!config.quiet) dependencies.stdout(human);
    return;
  }
  if (typeof value === "string") {
    dependencies.stdout(value);
    return;
  }
  dependencies.stdout(JSON.stringify(redact(value), null, 2));
};

const parseJsonLoose = (text: string): unknown | null => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const refreshStoredCliCredential = async (
  config: CliConfig,
  dependencies: ResolvedRunCliDependencies,
  diagnostics: CliDiagnostics,
): Promise<boolean> => {
  if (!config.authCredential) return false;
  if (config.authRefreshPromise) return config.authRefreshPromise;

  const current = config.authCredential;
  const promise = (async (): Promise<boolean> => {
    try {
      const response = await requestOnce({ ...config, token: null, accountId: null, clientId: null }, "/api/auth/cli/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      }, dependencies, diagnostics);
      const parsed = decodeCliCredentialBundle(response.data);
      if (
        !parsed ||
        !isCliCredentialForBaseUrl(parsed, config.baseUrl)
      ) {
        return false;
      }
      const refreshed = mergeCliCredentialAuthoring(current, parsed);
      await writeCliCredential(config.authFilePath, refreshed);
      if (config.authCredential === current) {
        config.authCredential = refreshed;
        config.token = refreshed.accessToken;
      }
      return true;
    } catch {
      return false;
    }
  })();
  config.authRefreshPromise = promise;
  try {
    return await promise;
  } finally {
    if (config.authRefreshPromise === promise) config.authRefreshPromise = null;
  }
};

const request = async <T = unknown>(
  config: CliConfig,
  path: string,
  options: RequestInit = {},
  dependencies: ResolvedRunCliDependencies,
  diagnostics: CliDiagnostics,
): Promise<ApiResponse<T>> => {
  const canRefresh =
    path !== "/api/auth/cli/refresh" &&
    path !== "/api/auth/cli/revoke" &&
    !new Headers(options.headers).has("Authorization") &&
    config.authCredential !== null;
  if (canRefresh && (config.authCredential?.accessExpiresAt ?? 0) - dependencies.now() <= 30_000) {
    await refreshStoredCliCredential(config, dependencies, diagnostics);
  }
  try {
    return await requestOnce<T>(config, path, options, dependencies, diagnostics);
  } catch (error) {
    if (
      error instanceof CliError && error.status === 401 && canRefresh &&
      await refreshStoredCliCredential(config, dependencies, diagnostics)
    ) {
      return await requestOnce<T>(config, path, options, dependencies, diagnostics);
    }
    throw error;
  }
};

const requestOnce = async <T = unknown>(
  config: CliConfig,
  path: string,
  options: RequestInit,
  dependencies: ResolvedRunCliDependencies,
  diagnostics: CliDiagnostics,
): Promise<ApiResponse<T>> => {
  const headers = new Headers(options.headers);
  const requestId = dependencies.createRequestId();
  const method = (options.method || "GET").toUpperCase();
  const startedAt = dependencies.now();
  headers.set("x-request-id", requestId);
  if (config.token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${config.token}`);
  }
  if (config.accountId && !headers.has(NULLDOWN_ACCOUNT_ID_HEADER)) {
    headers.set(NULLDOWN_ACCOUNT_ID_HEADER, config.accountId);
  }
  if (config.clientId && !headers.has(DIFF_CLIENT_ID_HEADER)) {
    headers.set(DIFF_CLIENT_ID_HEADER, config.clientId);
  }

  const controller = new AbortController();
  const externalSignal = options.signal;
  let abortSource: "caller" | "timeout" | null = null;
  const abortFromCaller = () => {
    if (abortSource) return;
    abortSource = "caller";
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    if (abortSource) return;
    abortSource = "timeout";
    controller.abort();
  }, config.requestTimeoutMs);

  diagnostics.emit({ event: "http.start", requestId, method });
  try {
    const response = await dependencies.fetch(`${config.baseUrl}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    const data = parseJsonLoose(text) as T | null;
    const contentType = response.headers.get("Content-Type") || "";

    if (
      response.ok &&
      contentType.includes("application/json") &&
      text.trim() &&
      text.trim() !== "null" &&
      data === null
    ) {
      throw new CliError("Response body was not valid JSON.", {
        status: response.status,
        code: "invalid_json_response",
      });
    }

    if (!response.ok) {
      const message =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : text || `${response.status} ${response.statusText}`;
      const code =
        data && typeof data === "object" && "code" in data
          ? String((data as { code: unknown }).code)
          : "http_error";
      throw new CliError(message, { status: response.status, code });
    }

    diagnostics.emit({
      event: "http.end",
      requestId,
      method,
      durationMs: dependencies.now() - startedAt,
      status: response.status,
    });
    return {
      status: response.status,
      headers: response.headers,
      text,
      data,
    };
  } catch (error) {
    const normalized = abortSource === "timeout"
      ? new CliError("Request timed out.", { code: "request_timeout" })
      : abortSource === "caller"
        ? new CliError("Request was aborted.", { code: "request_aborted" })
        : error instanceof CliError
          ? error
          : new CliError("Request failed.", { code: "request_failed" });
    diagnostics.emit({
      event: "http.error",
      requestId,
      method,
      durationMs: dependencies.now() - startedAt,
      code: normalized.code || "request_failed",
      status: normalized.status,
    });
    throw normalized;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
};

const readDrop = async (
  config: CliConfig,
  id: string,
  dependencies: ResolvedRunCliDependencies,
  diagnostics: CliDiagnostics,
): Promise<DropReadResult> => {
  const response = await request(
    config,
    `/api/get/${encodeURIComponent(id)}`,
    {},
    dependencies,
    diagnostics,
  );
  const contentType = response.headers.get("Content-Type") || "";
  const body = contentType.includes("application/json")
    ? response.data
    : response.text;
  return {
    id: response.headers.get("X-Drop-Canonical-Id") || id,
    requestedId: id,
    revision:
      response.headers.get("X-Drop-Revision") || response.headers.get("ETag"),
    contentType,
    body,
    text: response.text,
  };
};

const createCliRuntime = (
  config: CliConfig,
  dependencies: ResolvedRunCliDependencies,
  diagnostics: CliDiagnostics,
): NulldownRuntime =>
  createHttpNulldownRuntime({
    readDrop: (id) => readDrop(config, id, dependencies, diagnostics),
    request: <T = unknown>(path: string, options?: RequestInit) =>
      request<T>(config, path, options, dependencies, diagnostics),
    diffEnvelopeHeaders: (request: DiffEnvelopeHeadersRequest) =>
      createDiffEnvelopeHeaders(
        config,
        request.dropId,
        request.envelope,
        request.body,
        request.path,
      ),
  });

const readInput = async (
  path: string | null,
  dependencies: ResolvedRunCliDependencies,
): Promise<string> => {
  if (!path || path === "-") {
    return await dependencies.readStdin();
  }
  return await readFile(path, "utf8");
};

const parseMetadata = async (
  args: ParsedArgs,
  dependencies: ResolvedRunCliDependencies,
): Promise<Record<string, unknown> | undefined> => {
  const inline = flagString(args, "metadata");
  const file = flagString(args, "metadata-file");
  if (!inline && !file) return undefined;
  const raw = file ? await readInput(file, dependencies) : inline!;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Metadata must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
};

const parseDiffEventMetadata = async (
  args: ParsedArgs,
  dependencies: ResolvedRunCliDependencies,
): Promise<DropDiffEventMetadata | undefined> => {
  const inline = flagString(args, "metadata");
  const file = flagString(args, "metadata-file");
  if (!inline && !file) return undefined;
  const raw = file ? await readInput(file, dependencies) : inline!;
  const parsed = JSON.parse(raw) as unknown;
  if (!isDropDiffEventMetadata(parsed)) {
    throw new CliError("Diff event metadata must match DropDiffEventMetadata.");
  }
  return parsed;
};

const parseDiffEnvelopeInput = async (
  args: ParsedArgs,
  dependencies: ResolvedRunCliDependencies,
): Promise<DropDiffEnvelope> => {
  const body = await readInput(
    flagString(args, "body-file") || flagString(args, "body") || "-",
    dependencies,
  );
  const parsed = JSON.parse(body) as unknown;
  if (!isDropDiffEnvelope(parsed)) {
    throw new CliError("Diff body must match DropDiffEnvelope.");
  }
  return parsed;
};

const base64UrlEncode = (value: string): string =>
  Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const base64UrlDecode = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
};

const emptyDiffAuthBundle = (): DiffAuthTokenBundle => ({
  version: 1,
  kind: DIFF_AUTH_TOKEN_KIND,
  createdAt: Date.now(),
  keys: null,
  credentials: {},
});

const normalizeDiffAuthBundle = (value: unknown): DiffAuthTokenBundle => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("Invalid diff auth token payload.");
  }

  const record = value as Partial<DiffAuthTokenBundle>;
  if (record.version !== 1 || record.kind !== DIFF_AUTH_TOKEN_KIND) {
    throw new CliError("Unsupported diff auth token version.");
  }

  return {
    version: 1,
    kind: DIFF_AUTH_TOKEN_KIND,
    createdAt:
      typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    keys: record.keys ?? null,
    credentials:
      record.credentials &&
      typeof record.credentials === "object" &&
      !Array.isArray(record.credentials)
        ? (record.credentials as Record<string, DiffCredentialEntry>)
        : {},
  };
};

const encodeDiffAuthToken = (bundle: DiffAuthTokenBundle): string =>
  `${DIFF_AUTH_TOKEN_PREFIX}${base64UrlEncode(JSON.stringify(bundle))}`;

const decodeDiffAuthToken = (token: string): DiffAuthTokenBundle => {
  const trimmed = token.trim();
  if (!trimmed) throw new CliError("Diff auth token is empty.");
  const encoded = trimmed.startsWith(DIFF_AUTH_TOKEN_PREFIX)
    ? trimmed.slice(DIFF_AUTH_TOKEN_PREFIX.length)
    : trimmed;
  try {
    return normalizeDiffAuthBundle(
      JSON.parse(base64UrlDecode(encoded)) as unknown,
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Invalid diff auth token.");
  }
};

const readDiffAuthBundle = async (
  config: CliConfig,
): Promise<DiffAuthTokenBundle> => {
  if (config.diffAuthToken) return decodeDiffAuthToken(config.diffAuthToken);
  try {
    return decodeDiffAuthToken(
      await readFile(config.diffAuthTokenPath, "utf8"),
    );
  } catch {
    return emptyDiffAuthBundle();
  }
};

const writeDiffAuthBundle = async (
  config: CliConfig,
  bundle: DiffAuthTokenBundle,
): Promise<void> => {
  await mkdir(dirname(config.diffAuthTokenPath), { recursive: true });
  await writeFile(
    config.diffAuthTokenPath,
    `${encodeDiffAuthToken(bundle)}\n`,
    { mode: 0o600 },
  );
};

const mergeDiffAuthBundles = (
  current: DiffAuthTokenBundle,
  incoming: DiffAuthTokenBundle,
  overwriteKeys: boolean,
): DiffAuthTokenBundle => ({
  version: 1,
  kind: DIFF_AUTH_TOKEN_KIND,
  createdAt: current.createdAt || incoming.createdAt || Date.now(),
  keys:
    overwriteKeys || !current.keys
      ? (incoming.keys ?? current.keys)
      : current.keys,
  credentials: {
    ...current.credentials,
    ...incoming.credentials,
  },
});

const signDiffPayload = (
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string => {
  const payload = buildDiffSigningPayload(method, path, timestamp, body);
  const hex = createHmac("sha256", secret).update(payload).digest("hex");
  return `${DIFF_SIGNATURE_PREFIX}${hex}`;
};

const unwrapSecret = async (
  wrappedSecretBase64: string,
  privateJwk: JsonWebKey,
): Promise<string> => {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    new Uint8Array(Buffer.from(wrappedSecretBase64, "base64")),
  );
  return textDecoder.decode(plaintext);
};

const writeCredential = async (
  config: CliConfig,
  entry: DiffCredentialEntry,
): Promise<void> => {
  const current = await readDiffAuthBundle(config);
  await writeDiffAuthBundle(config, {
    ...current,
    credentials: {
      ...current.credentials,
      [entry.dropId]: entry,
    },
  });
};

const findCredential = async (
  config: CliConfig,
  dropId: string,
): Promise<DiffCredentialEntry | null> => {
  const store = await readDiffAuthBundle(config);
  return store.credentials[dropId] ?? null;
};

const createDiffEnvelopeHeaders = async (
  config: CliConfig,
  routeDropId: string,
  envelope: DropDiffEnvelope,
  body: string,
  path: string,
) => {
  const headers: Record<string, string> = {};
  const credential = await findCredential(
    config,
    envelope.events[0]?.dropId || routeDropId,
  );
  const webhookSecret = process.env.DIFF_WEBHOOK_SECRET || "";

  if (credential) {
    const timestamp = String(Date.now());
    headers[DIFF_CLIENT_ID_HEADER] = credential.clientId;
    headers[DIFF_SECRET_KID_HEADER] = credential.kid;
    headers[DIFF_TIMESTAMP_HEADER] = timestamp;
    headers[DIFF_SIGNATURE_HEADER] = signDiffPayload(
      credential.secret,
      "POST",
      path,
      timestamp,
      body,
    );
  } else if (webhookSecret) {
    const timestamp = String(Date.now());
    headers[DIFF_TIMESTAMP_HEADER] = timestamp;
    headers[DIFF_SIGNATURE_HEADER] = signDiffPayload(
      webhookSecret,
      "POST",
      path,
      timestamp,
      body,
    );
  }

  return headers;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
};

const openBrowser = async (url: string): Promise<void> => {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    void child.exited;
  } catch {
    // The verification URI is printed regardless of local browser availability.
  }
};

const createRegisteredCommands = (
  config: CliConfig,
  dependencies: ResolvedRunCliDependencies,
  diagnostics: CliDiagnostics,
): CliCommand<CliConfig>[] => {
  const runtime = createCliRuntime(config, dependencies, diagnostics);
  const resolveAdminToken = (
    target: AdminBackfillTarget,
    args: ParsedArgs,
  ): string | null =>
    flagString(args, "token") ||
    (target === "metadata-backfill"
      ? process.env.METADATA_BACKFILL_TOKEN || process.env.DROP_INDEX_BACKFILL_TOKEN
      : target === "index-backfill"
        ? process.env.DROP_INDEX_BACKFILL_TOKEN
        : process.env.BRANCH_HEAP_BACKFILL_TOKEN) ||
    null;
  return [
    createDoctorCommand<CliConfig>({
      readDiffAuthBundle,
      print: (activeConfig, value, human) =>
        print(activeConfig, dependencies, value, human),
    }),
    ...createDropCommands<CliConfig>({
      runtime,
      print: (value, human) => print(config, dependencies, value, human),
      redact,
      writeText: dependencies.stdout,
      readInput: (path) => readInput(path, dependencies),
      parseMetadata: (args) => parseMetadata(args, dependencies),
      shouldResolveSeedBranch: () => Boolean(config.token || config.accountId),
    }),
    createBranchCommand<CliConfig>({
      runtime,
      print: (value, human) => print(config, dependencies, value, human),
      parseMetadata: (args) => parseMetadata(args, dependencies),
      parseJsonLoose,
      defaultDocumentResolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
    }),
    createDiffCommand<CliConfig>({
      runtime,
      print: (value, human) => print(config, dependencies, value, human),
      parseDiffEnvelopeInput: (args) =>
        parseDiffEnvelopeInput(args, dependencies),
      parseDiffEventMetadata: (args) =>
        parseDiffEventMetadata(args, dependencies),
      readInput: (path) => readInput(path, dependencies),
      clientId: () => config.clientId,
      readDiffAuthBundle: () => readDiffAuthBundle(config),
      writeDiffAuthBundle: (bundle) => writeDiffAuthBundle(config, bundle),
      mergeDiffAuthBundles,
      encodeDiffAuthToken,
      decodeDiffAuthToken,
      async registerDiffAuth(dropId, keys) {
        const response = await request(
          config,
          `/api/diff-auth/register/${encodeURIComponent(dropId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              clientId: keys.clientId,
              requesterPublicJwk: keys.encryptionPublicJwk,
            }),
          },
          dependencies,
          diagnostics,
        );
        const registration = decodeDiffAuthRegisterResponse(response.data);
        if (!registration) {
          throw new CliError("Diff auth registration returned an invalid body.");
        }
        return registration;
      },
      unwrapSecret,
      writeCredential: (entry) => writeCredential(config, entry),
      findCredential: (dropId) => findCredential(config, dropId),
      signDiffPayload,
      diffAuthTokenPath: () => config.diffAuthTokenPath,
      baseUrl: () => config.baseUrl,
      writeText: dependencies.stdout,
      isJson: () => config.json,
    }),
    createAuthCommand<CliConfig>({
      runtime,
      print: (value, human) => print(config, dependencies, value, human),
      readInput: (path) => readInput(path, dependencies),
      baseUrl: () => config.baseUrl,
      authFilePath: () => config.authFilePath,
      readCredential: async () => {
        const credential = config.authCredential ?? await readCliCredential(config.authFilePath);
        return isCliCredentialForBaseUrl(credential, config.baseUrl) ? credential : null;
      },
      writeCredential: async (credential) => {
        await writeCliCredential(config.authFilePath, credential);
        config.authCredential = credential;
        config.token = credential.accessToken;
      },
      clearCredential: async () => {
        await clearCliCredential(config.authFilePath);
        config.authCredential = null;
        config.token = null;
      },
      openBrowser,
      sleep,
    }),
    createAdminCommand<CliConfig>({
      runtime,
      print: (value, human) => print(config, dependencies, value, human),
      resolveAdminToken,
      sleep,
    }),
    createSmokeCommand<CliConfig>({
      runtime,
      print: (value, human) => print(config, dependencies, value, human),
      clientId: () => config.clientId,
    }),
    createServeCommand<CliConfig>({
      ...dependencies.serve,
      print: (value, human) => print(config, dependencies, value, human),
    }),
  ];
};

const dispatch = async (
  config: CliConfig,
  args: ParsedArgs,
  dependencies: ResolvedRunCliDependencies,
  diagnostics: CliDiagnostics,
): Promise<void> => {
  const runCommand = async (
    command: string,
    execute: () => Promise<void>,
  ): Promise<void> => {
    const startedAt = dependencies.now();
    diagnostics.emit({ event: "command.start", command });
    try {
      await execute();
      diagnostics.emit({
        event: "command.end",
        command,
        durationMs: dependencies.now() - startedAt,
        exitCode: 0,
      });
    } catch (error) {
      diagnostics.emit({
        event: "command.error",
        command,
        durationMs: dependencies.now() - startedAt,
        code:
          error instanceof CliError && error.code
            ? error.code
            : "command_failed",
      });
      throw error;
    }
  };
  const command = args.positionals[0];
  if (
    !command ||
    command === "help" ||
    hasFlag(args, "help") ||
    hasFlag(args, "h")
  ) {
    return runCommand("help", async () => dependencies.stdout(helpText));
  }
  const registeredCommand = findCliCommand(
    createRegisteredCommands(config, dependencies, diagnostics),
    command,
    args,
  );
  if (registeredCommand) {
    return runCommand(registeredCommand.name, () =>
      registeredCommand.run({ config, args }),
    );
  }

  return runCommand("unknown", async () => {
    throw new CliError(`Unknown command: ${command}`, {
      code: "unknown_command",
    });
  });
};

/** Runs one CLI invocation and returns the exit status to its host process. */
export const runCli = async (
  argv: string[],
  injectedDependencies: RunCliDependencies = {},
): Promise<CliExitResult> => {
  const dependencies = resolveRunCliDependencies(injectedDependencies);
  const args = parseArgs(argv);
  if (hasFlag(args, "version")) {
    dependencies.stdout(packageJson.version);
    return { exitCode: 0 };
  }
  let config: CliConfig | null = null;
  let fileConfig: Partial<CliConfig> = {};
  try {
    fileConfig = await readConfig(args);
    config = await resolveConfig(
      args,
      fileConfig,
      dependencies.requestTimeoutMs,
    );
    const diagnostics = createCliDiagnostics({
      enabled: config.verbose,
      format: config.json ? "ndjson" : "human",
      write: dependencies.stderr,
    });
    await dispatch(config, args, dependencies, diagnostics);
    return { exitCode: 0 };
  } catch (error) {
    const json =
      config?.json ?? (hasFlag(args, "json") || Boolean(fileConfig.json));
    const verbose =
      config?.verbose ??
      (hasFlag(args, "verbose") || Boolean(fileConfig.verbose));
    const secrets = config
      ? sensitiveValues(config)
      : unresolvedSensitiveValues(args);
    const message = redactText(
      error instanceof Error ? error.message : String(error),
      secrets,
    );
    if (json) {
      const output =
        error instanceof CliError
          ? {
              error: message,
              code: error.code || "command_failed",
              status: error.status,
            }
          : {
              error: message,
              code: config ? "command_failed" : "config_error",
            };
      dependencies.stderr(
        JSON.stringify(redact(output, secrets), null, verbose ? 0 : 2),
      );
    } else {
      dependencies.stderr(`error: ${message}`);
    }
    return { exitCode: 1 };
  }
};
