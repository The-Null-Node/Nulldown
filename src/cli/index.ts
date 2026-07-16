import { createHmac } from "node:crypto";
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
  type DiffAuthRegisterResponse,
} from "../../shared/drop/diffAuth";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../shared/drop/branch";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../shared/drop/resolved/constants";
import { createAdminCommand } from "./commands/admin";
import { createAuthCommand } from "./commands/auth";
import { createBranchCommand } from "./commands/branches";
import { createDiffCommand } from "./commands/diffs";
import { createDoctorCommand } from "./commands/doctor";
import { createDropCommands } from "./commands/drops";
import { createServeCommand } from "./commands/serve";
import { createSmokeCommand } from "./commands/smoke";
import { flagString, hasFlag, parseArgs, type ParsedArgs } from "./core/args";
import { findCliCommand, type CliCommand } from "./core/command";
import { createHttpNulldownRuntime } from "./runtime/httpRuntime";
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

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface CliConfig {
  baseUrl: string;
  token: string | null;
  accountId: string | null;
  clientId: string | null;
  configDir: string;
  diffAuthDir: string;
  diffAuthToken: string | null;
  diffAuthTokenPath: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
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
const DIFF_AUTH_TOKEN_KIND = "nulldown.diff-auth.v1";
const DIFF_AUTH_TOKEN_PREFIX = "ndauth.v1.";
const textDecoder = new TextDecoder();

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
  branch promote <rootId> <branchId>

Diff commands:
  diff poll <dropId> [--cursor <n>] [--limit <n>]
  diff latest <dropId>
  diff apply <dropId> --branch <branchId> [--metadata-file <file>] [--insert pos:text] [--delete start:end]
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
  admin branch-backfill <rootId>
  admin index-backfill
  admin metadata-backfill
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
  --diff-auth-token <token>
                     Inline diff auth token
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

const resolveConfig = async (args: ParsedArgs): Promise<CliConfig> => {
  const fileConfig = await readConfig(args);
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

  return {
    baseUrl,
    token:
      flagString(args, "token") ||
      process.env.ND_TOKEN ||
      fileConfig.token ||
      null,
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
    json: hasFlag(args, "json") || Boolean(fileConfig.json),
    quiet: hasFlag(args, "quiet") || Boolean(fileConfig.quiet),
    verbose: hasFlag(args, "verbose") || Boolean(fileConfig.verbose),
  };
};

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
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
    output[key] = redact(entry);
  }
  return output;
};

const print = (config: CliConfig, value: unknown, human?: string): void => {
  if (config.json) {
    console.log(JSON.stringify(redact(value), null, 2));
    return;
  }
  if (human !== undefined) {
    if (!config.quiet) console.log(human);
    return;
  }
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(redact(value), null, 2));
};

const parseJsonLoose = (text: string): unknown | null => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const request = async <T = unknown>(
  config: CliConfig,
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> => {
  const headers = new Headers(options.headers);
  if (config.token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${config.token}`);
  }
  if (config.accountId && !headers.has(NULLDOWN_ACCOUNT_ID_HEADER)) {
    headers.set(NULLDOWN_ACCOUNT_ID_HEADER, config.accountId);
  }
  if (config.clientId && !headers.has(DIFF_CLIENT_ID_HEADER)) {
    headers.set(DIFF_CLIENT_ID_HEADER, config.clientId);
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  const data = parseJsonLoose(text) as T | null;

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : text || `${response.status} ${response.statusText}`;
    const code =
      data && typeof data === "object" && "code" in data
        ? String((data as { code: unknown }).code)
        : undefined;
    throw new CliError(message, { status: response.status, code });
  }

  return {
    status: response.status,
    headers: response.headers,
    text,
    data,
  };
};

const readDrop = async (
  config: CliConfig,
  id: string,
): Promise<DropReadResult> => {
  const response = await request(config, `/api/get/${encodeURIComponent(id)}`);
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

const createCliRuntime = (config: CliConfig): NulldownRuntime =>
  createHttpNulldownRuntime({
    readDrop: (id) => readDrop(config, id),
    request: <T = unknown>(path: string, options?: RequestInit) =>
      request<T>(config, path, options),
    diffEnvelopeHeaders: (request: DiffEnvelopeHeadersRequest) =>
      createDiffEnvelopeHeaders(
        config,
        request.dropId,
        request.envelope,
        request.body,
        request.path,
      ),
  });

const readInput = async (path: string | null): Promise<string> => {
  if (!path || path === "-") {
    return await Bun.stdin.text();
  }
  return await readFile(path, "utf8");
};

const parseMetadata = async (
  args: ParsedArgs,
): Promise<Record<string, unknown> | undefined> => {
  const inline = flagString(args, "metadata");
  const file = flagString(args, "metadata-file");
  if (!inline && !file) return undefined;
  const raw = file ? await readInput(file) : inline!;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Metadata must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
};

const parseDiffEventMetadata = async (
  args: ParsedArgs,
): Promise<DropDiffEventMetadata | undefined> => {
  const inline = flagString(args, "metadata");
  const file = flagString(args, "metadata-file");
  if (!inline && !file) return undefined;
  const raw = file ? await readInput(file) : inline!;
  const parsed = JSON.parse(raw) as unknown;
  if (!isDropDiffEventMetadata(parsed)) {
    throw new CliError("Diff event metadata must match DropDiffEventMetadata.");
  }
  return parsed;
};

const parseDiffEnvelopeInput = async (
  args: ParsedArgs,
): Promise<DropDiffEnvelope> => {
  const body = await readInput(
    flagString(args, "body-file") || flagString(args, "body") || "-",
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

const createRegisteredCommands = (config: CliConfig): CliCommand<CliConfig>[] => {
  const runtime = createCliRuntime(config);
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
    createDoctorCommand({ readDiffAuthBundle, print }),
    ...createDropCommands<CliConfig>({
      runtime,
      print: (value, human) => print(config, value, human),
      redact,
      writeText: (text) => console.log(text),
      readInput,
      parseMetadata,
      shouldResolveSeedBranch: () => Boolean(config.token || config.accountId),
    }),
    createBranchCommand<CliConfig>({
      runtime,
      print: (value, human) => print(config, value, human),
      parseMetadata,
      parseJsonLoose,
      defaultDocumentResolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
    }),
    createDiffCommand<CliConfig>({
      runtime,
      print: (value, human) => print(config, value, human),
      parseDiffEnvelopeInput,
      parseDiffEventMetadata,
      readInput,
      clientId: () => config.clientId,
      readDiffAuthBundle: () => readDiffAuthBundle(config),
      writeDiffAuthBundle: (bundle) => writeDiffAuthBundle(config, bundle),
      mergeDiffAuthBundles,
      encodeDiffAuthToken,
      decodeDiffAuthToken,
      async registerDiffAuth(dropId, keys) {
        const response = await request<DiffAuthRegisterResponse>(
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
        );
        if (!response.data) {
          throw new CliError("Diff auth registration returned no body.");
        }
        return response.data;
      },
      unwrapSecret,
      writeCredential: (entry) => writeCredential(config, entry),
      findCredential: (dropId) => findCredential(config, dropId),
      signDiffPayload,
      diffAuthTokenPath: () => config.diffAuthTokenPath,
      baseUrl: () => config.baseUrl,
      writeText: (text) => console.log(text),
      isJson: () => config.json,
    }),
    createAuthCommand<CliConfig>({
      runtime,
      print: (value, human) => print(config, value, human),
      readInput,
    }),
    createAdminCommand<CliConfig>({
      runtime,
      print: (value, human) => print(config, value, human),
      resolveAdminToken,
      sleep,
    }),
    createSmokeCommand<CliConfig>({
      runtime,
      print: (value, human) => print(config, value, human),
      clientId: () => config.clientId,
    }),
    createServeCommand<CliConfig>({
      print: (value, human) => print(config, value, human),
    }),
  ];
};

const dispatch = async (config: CliConfig, args: ParsedArgs): Promise<void> => {
  const command = args.positionals[0];
  if (
    !command ||
    command === "help" ||
    hasFlag(args, "help") ||
    hasFlag(args, "h")
  ) {
    console.log(helpText);
    return;
  }
  const registeredCommand = findCliCommand(
    createRegisteredCommands(config),
    command,
    args,
  );
  if (registeredCommand) return registeredCommand.run({ config, args });

  throw new CliError(`Unknown command: ${command}`);
};

export const runCli = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv);
  if (hasFlag(args, "version")) {
    console.log(packageJson.version);
    return;
  }
  const config = await resolveConfig(args);
  try {
    await dispatch(config, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (config.json) {
      const output =
        error instanceof CliError
          ? { error: message, code: error.code, status: error.status }
          : { error: message };
      console.error(JSON.stringify(redact(output), null, 2));
    } else {
      console.error(`error: ${message}`);
    }
    process.exit(1);
  }
};
