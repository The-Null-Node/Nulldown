import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { computeDiffOps } from "../../shared/nulledit/textDiff";
import {
  diffToDropDiffOp,
  isDropDiffEnvelope,
  isDropDiffEventMetadata,
  type DropDiffEnvelope,
  type DropDiffEventMetadata,
  type DropDiffOp,
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
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../shared/drop/resolved";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

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

interface DropReadResult {
  id: string;
  requestedId: string;
  revision: string | null;
  contentType: string;
  body: unknown;
  text: string;
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

const parseArgs = (argv: string[]): ParsedArgs => {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!entry.startsWith("--")) {
      positionals.push(entry);
      continue;
    }

    const raw = entry.slice(2);
    const equalIndex = raw.indexOf("=");
    if (equalIndex !== -1) {
      flags[raw.slice(0, equalIndex)] = raw.slice(equalIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[raw] = next;
      index += 1;
      continue;
    }

    flags[raw] = true;
  }

  return { positionals, flags };
};

const flagString = (args: ParsedArgs, name: string): string | null => {
  const value = args.flags[name];
  return typeof value === "string" ? value : null;
};

const hasFlag = (args: ParsedArgs, name: string): boolean =>
  args.flags[name] === true;

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

const encodeBranchPathSegment = (value: string): string =>
  encodeURIComponent(value).replace(/%3A/gi, ":");

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

const getDropContent = (drop: DropReadResult): string => {
  if (drop.body && typeof drop.body === "object" && "content" in drop.body) {
    return String((drop.body as { content: unknown }).content);
  }

  return drop.text;
};

const readBranchContentOrNull = async (
  config: CliConfig,
  dropId: string,
  branchId: string,
): Promise<{ rootDropId: string; content: string } | null> => {
  try {
    const response = await request<{
      rootDropId: string;
      content: string;
    }>(
      config,
      `/api/branches/${encodeURIComponent(dropId)}/${encodeBranchPathSegment(branchId)}/content`,
    );
    return response.data ?? null;
  } catch (error) {
    if (error instanceof CliError && error.status === 404) {
      return null;
    }
    throw error;
  }
};

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

const postDiffEnvelope = async (
  config: CliConfig,
  routeDropId: string,
  branchId: string | null,
  envelope: DropDiffEnvelope,
) => {
  const body = JSON.stringify(envelope);
  const path = `/api/diff/${encodeURIComponent(routeDropId)}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
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

  const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : "";
  return request(config, `${path}${query}`, {
    method: "POST",
    headers,
    body,
  });
};

const parsePosition = (value: string): { start: number; text: string } => {
  const separator = value.indexOf(":");
  if (separator === -1) throw new CliError("Expected insert format pos:text.");
  const start = Number.parseInt(value.slice(0, separator), 10);
  if (!Number.isFinite(start) || start < 0)
    throw new CliError("Insert position must be >= 0.");
  return { start, text: value.slice(separator + 1) };
};

const parseRange = (value: string): { start: number; end: number } => {
  const [rawStart, rawEnd] = value.split(":");
  const start = Number.parseInt(rawStart || "", 10);
  const end = Number.parseInt(rawEnd || "", 10);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start
  ) {
    throw new CliError("Expected delete format start:end with end >= start.");
  }
  return { start, end };
};

const createEvent = (input: {
  dropId: string;
  clientId: string;
  ops: DropDiffOp[];
  metadata?: DropDiffEventMetadata;
}): DropDiffEnvelope => ({
  version: 1,
  events: [
    {
      eventId: `nd-${Date.now()}-${randomUUID()}`,
      seq: 0,
      dropId: input.dropId,
      sourceClientId: input.clientId,
      createdAt: Date.now(),
      ops: input.ops,
      metadata: input.metadata,
    },
  ],
});

const commandCreate = async (config: CliConfig, args: ParsedArgs) => {
  const source = args.positionals[1] ?? "-";
  const content = await readInput(source);
  const metadata = (await parseMetadata(args)) ?? { themeId: "system" };
  const response = await request<{ id: string; url: string }>(
    config,
    "/api/store",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, metadata }),
    },
  );
  print(config, response.data, `created ${response.data?.url}`);
};

const commandGet = async (config: CliConfig, args: ParsedArgs) => {
  const id = args.positionals[1];
  if (!id) throw new CliError("Usage: nd get <id>");
  const drop = await readDrop(config, id);
  if (hasFlag(args, "raw")) {
    if (drop.body && typeof drop.body === "object" && "content" in drop.body) {
      console.log(String((drop.body as { content: unknown }).content));
      return;
    }
    console.log(drop.text);
    return;
  }
  print(
    config,
    drop,
    typeof drop.body === "string"
      ? drop.body
      : JSON.stringify(redact(drop.body), null, 2),
  );
};

const commandUpdate = async (config: CliConfig, args: ParsedArgs) => {
  const id = args.positionals[1];
  const source = args.positionals[2] ?? "-";
  if (!id) throw new CliError("Usage: nd update <id> <file|->");
  const current = await readDrop(config, id);
  const content = await readInput(source);
  const metadataOverride = await parseMetadata(args);
  const currentMetadata =
    current.body &&
    typeof current.body === "object" &&
    "metadata" in current.body
      ? ((current.body as { metadata?: unknown }).metadata as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const metadata = metadataOverride
    ? { ...(currentMetadata ?? {}), ...metadataOverride }
    : (currentMetadata ?? { themeId: "system" });
  const body: Record<string, unknown> = {
    id: current.id,
    upsert: true,
    content,
    metadata,
  };
  if (!hasFlag(args, "force") && current.revision)
    body.expectedRevision = current.revision;
  const response = await request<{ id: string; url: string }>(
    config,
    "/api/store",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  print(config, response.data, `updated ${response.data?.url}`);
};

const commandDelete = async (config: CliConfig, args: ParsedArgs) => {
  const id = args.positionals[1];
  if (!id) throw new CliError("Usage: nd delete <id>");
  const headers: Record<string, string> = {};
  if (!hasFlag(args, "force")) {
    const current = await readDrop(config, id);
    if (current.revision) headers["If-Match"] = current.revision;
  }
  await request(config, `/api/delete/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers,
  });
  print(config, { deleted: id }, `deleted ${id}`);
};

const commandList = async (config: CliConfig, args: ParsedArgs) => {
  const params = new URLSearchParams();
  const limit = flagString(args, "limit");
  const cursor = flagString(args, "cursor");
  if (limit) params.set("limit", limit);
  if (cursor) params.set("cursor", cursor);
  const response = await request(
    config,
    `/api/list${params.size ? `?${params}` : ""}`,
  );
  print(config, response.data);
};

const commandSearch = async (config: CliConfig, args: ParsedArgs) => {
  const params = new URLSearchParams();
  params.set("q", args.positionals[1] ?? flagString(args, "query") ?? "");
  for (const name of ["owner", "visibility", "limit", "offset"]) {
    const value = flagString(args, name);
    if (value) params.set(name, value);
  }
  const response = await request(config, `/api/search?${params}`);
  print(config, response.data);
};

const commandBranch = async (config: CliConfig, args: ParsedArgs) => {
  const sub = args.positionals[1];
  if (sub === "list") {
    const id = args.positionals[2];
    if (!id) throw new CliError("Usage: nd branch list <rootId>");
    const response = await request(
      config,
      `/api/branches/${encodeURIComponent(id)}`,
    );
    print(config, response.data);
    return;
  }
  if (sub === "resolve") {
    const id =
      args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
    if (!id) throw new CliError("Usage: nd branch resolve <dropId>");
    const response = await request(
      config,
      `/api/branches/resolve/${encodeURIComponent(id)}`,
      {
        method: "POST",
      },
    );
    print(config, response.data);
    return;
  }
  if (sub === "content") {
    const rootId =
      args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
    const branchId = args.positionals[3] || flagString(args, "branch");
    if (!rootId || !branchId)
      throw new CliError("Usage: nd branch content <rootId> <branchId>");
    const response = await request(
      config,
      `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/content`,
    );
    print(
      config,
      response.data,
      (response.data as { content?: string } | null)?.content,
    );
    return;
  }
  if (sub === "snapshots") {
    const rootId = args.positionals[2];
    const branchId = args.positionals[3] || flagString(args, "branch");
    if (!rootId || !branchId)
      throw new CliError("Usage: nd branch snapshots <rootId> <branchId>");
    const response = await request(
      config,
      `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/snapshots`,
    );
    print(config, response.data);
    return;
  }
  if (sub === "query") {
    const rootId =
      args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
    const branchId = args.positionals[3] || flagString(args, "branch");
    if (!rootId || !branchId)
      throw new CliError("Usage: nd branch query <rootId> <branchId>");
    const params = new URLSearchParams();
    const query = flagString(args, "query") || flagString(args, "q");
    const top = flagString(args, "top") || flagString(args, "k");
    const snapshotId =
      flagString(args, "snapshot") || flagString(args, "snapshotId");
    const resolverId =
      flagString(args, "resolver") || flagString(args, "resolverId");
    const kind = flagString(args, "kind");
    const fromSeq = flagString(args, "from-seq") || flagString(args, "fromSeq");
    const toSeq = flagString(args, "to-seq") || flagString(args, "toSeq");
    const pluginId = flagString(args, "plugin") || flagString(args, "pluginId");
    const callId = flagString(args, "call") || flagString(args, "callId");
    const primitiveId =
      flagString(args, "primitive") || flagString(args, "primitiveId");
    if (query) params.set("q", query);
    if (top) params.set("k", top);
    if (snapshotId) params.set("snapshotId", snapshotId);
    if (resolverId) params.set("resolverId", resolverId);
    if (kind) params.set("kind", kind);
    if (fromSeq) params.set("fromSeq", fromSeq);
    if (toSeq) params.set("toSeq", toSeq);
    if (pluginId) params.set("pluginId", pluginId);
    if (callId) params.set("callId", callId);
    if (primitiveId) params.set("primitiveId", primitiveId);
    if (hasFlag(args, "changed-only")) params.set("changedOnly", "true");
    if (hasFlag(args, "include-ancestors"))
      params.set("includeAncestors", "true");
    if (hasFlag(args, "no-event-metadata"))
      params.set("includeEventMetadata", "false");
    const suffix = params.size ? `?${params}` : "";
    const response = await request(
      config,
      `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/resolved/query${suffix}`,
    );
    print(config, response.data);
    return;
  }
  if (sub === "heap-update" || sub === "resolved-update") {
    const rootId =
      args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
    const branchId = args.positionals[3] || flagString(args, "branch");
    if (!rootId || !branchId)
      throw new CliError("Usage: nd branch heap-update <rootId> <branchId>");
    const resolverId =
      flagString(args, "resolver") || flagString(args, "resolverId") || "all";
    const snapshotId =
      flagString(args, "snapshot") || flagString(args, "snapshotId");
    const body: Record<string, unknown> = { resolverId };
    if (snapshotId) {
      body.snapshotId = /^\d+$/.test(snapshotId)
        ? Number.parseInt(snapshotId, 10)
        : snapshotId;
    }
    const response = await request(
      config,
      `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/resolved/update`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    print(config, response.data);
    return;
  }
  if (sub === "memory" || sub === "mem") {
    const action = args.positionals[2];
    const rootId =
      args.positionals[3] || flagString(args, "drop") || flagString(args, "id");
    const branchId = args.positionals[4] || flagString(args, "branch");
    if (!rootId || !branchId) {
      throw new CliError(
        "Usage: nd branch memory <query|fact|procedure> <rootId> <branchId>",
      );
    }

    const labels = flagString(args, "labels")
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (action === "query" || action === "search" || action === "q") {
      const params = new URLSearchParams();
      const query = flagString(args, "query") || flagString(args, "q");
      const kind = flagString(args, "kind");
      const limit = flagString(args, "limit");
      if (query) params.set("query", query);
      if (kind) params.set("kind", kind);
      if (labels?.length) params.set("labels", labels.join(","));
      if (limit) params.set("limit", limit);
      const suffix = params.size ? `?${params}` : "";
      const response = await request(
        config,
        `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/memory/query${suffix}`,
      );
      print(config, response.data);
      return;
    }

    if (action === "fact" || action === "note") {
      const text = flagString(args, "text") || flagString(args, "body");
      if (!text) {
        throw new CliError("Usage: nd branch memory fact <rootId> <branchId> --text <text>");
      }
      const metadata = await parseMetadata(args);
      const body: Record<string, unknown> = { text };
      const title = flagString(args, "title");
      const targetKind = flagString(args, "target-kind") || flagString(args, "targetKind");
      const targetId = flagString(args, "target") || flagString(args, "targetId");
      const priority = flagString(args, "priority");
      const confidence = flagString(args, "confidence");
      if (title) body.title = title;
      if (targetKind) body.targetKind = targetKind;
      if (targetId) body.targetId = targetId;
      if (labels?.length) body.labels = labels;
      if (priority) body.priority = Number.parseFloat(priority);
      if (confidence) body.confidence = Number.parseFloat(confidence);
      if (metadata) body.metadata = metadata;

      const response = await request(
        config,
        `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/memory/facts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      print(config, response.data);
      return;
    }

    if (action === "procedure" || action === "proc") {
      const goal = flagString(args, "goal");
      const summary = flagString(args, "summary");
      if (!goal || !summary) {
        throw new CliError(
          "Usage: nd branch memory procedure <rootId> <branchId> --goal <text> --summary <text>",
        );
      }
      const metadata = await parseMetadata(args);
      const stepsRaw =
        flagString(args, "steps") ||
        flagString(args, "steps-json") ||
        flagString(args, "stepsJson");
      const body: Record<string, unknown> = { goal, summary };
      const outcome = flagString(args, "outcome");
      const reusableAs = flagString(args, "reusable-as") || flagString(args, "reusableAs");
      const priority = flagString(args, "priority");
      const confidence = flagString(args, "confidence");
      if (stepsRaw) body.steps = parseJsonLoose(stepsRaw);
      if (outcome) body.outcome = outcome;
      if (reusableAs) body.reusableAs = reusableAs;
      if (labels?.length) body.labels = labels;
      if (priority) body.priority = Number.parseFloat(priority);
      if (confidence) body.confidence = Number.parseFloat(confidence);
      if (metadata) body.metadata = metadata;

      const response = await request(
        config,
        `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/memory/procedures`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      print(config, response.data);
      return;
    }

    throw new CliError(
      "Usage: nd branch memory <query|fact|procedure> <rootId> <branchId>",
    );
  }
  if (sub === "priority" || sub === "prioritize") {
    const action = args.positionals[2];
    if (action === "list" || action === "ls") {
      const rootId =
        args.positionals[3] || flagString(args, "drop") || flagString(args, "id");
      const branchId = args.positionals[4] || flagString(args, "branch");
      if (!rootId || !branchId) {
        throw new CliError("Usage: nd branch priority list <rootId> <branchId>");
      }

      const params = new URLSearchParams();
      const resolverId = flagString(args, "resolver") || flagString(args, "resolverId");
      const targetKind = flagString(args, "target-kind") || flagString(args, "targetKind");
      const targetId = flagString(args, "target") || flagString(args, "targetId");
      const factId = flagString(args, "fact") || flagString(args, "factId");
      const limit = flagString(args, "limit");
      if (resolverId) params.set("resolverId", resolverId);
      if (targetKind) params.set("targetKind", targetKind);
      if (targetId) params.set("targetId", targetId);
      if (factId) params.set("factId", factId);
      if (limit) params.set("limit", limit);
      const suffix = params.size ? `?${params}` : "";
      const response = await request(
        config,
        `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/resolved/priority${suffix}`,
      );
      print(config, response.data);
      return;
    }

    if (action === "delete" || action === "del" || action === "rm") {
      const rootId =
        args.positionals[3] || flagString(args, "drop") || flagString(args, "id");
      const branchId = args.positionals[4] || flagString(args, "branch");
      const factId =
        args.positionals[5] || flagString(args, "fact") || flagString(args, "factId");
      if (!rootId || !branchId || !factId) {
        throw new CliError(
          "Usage: nd branch priority delete <rootId> <branchId> <factId>",
        );
      }

      const response = await request(
        config,
        `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/resolved/priority/${encodeURIComponent(factId)}`,
        { method: "DELETE" },
      );
      print(config, response.data);
      return;
    }

    const rootId =
      args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
    const branchId = args.positionals[3] || flagString(args, "branch");
    if (!rootId || !branchId) {
      throw new CliError("Usage: nd branch priority <rootId> <branchId> --priority <n>");
    }

    const rawPriority = flagString(args, "priority") || flagString(args, "score");
    const priority = Number.parseFloat(rawPriority || "");
    if (!Number.isFinite(priority)) {
      throw new CliError("nd branch priority requires --priority <number>.");
    }

    const nodeTarget = flagString(args, "node") || flagString(args, "nodeId");
    const diffTarget = flagString(args, "diff") || flagString(args, "event") || flagString(args, "eventId");
    const explicitTarget = flagString(args, "target") || flagString(args, "targetId");
    const targetKind = hasFlag(args, "heap")
      ? "heap"
      : nodeTarget
        ? "node"
        : diffTarget
          ? "diff"
          : (flagString(args, "target-kind") || flagString(args, "targetKind") || "node");
    if (targetKind !== "node" && targetKind !== "heap" && targetKind !== "diff") {
      throw new CliError("Priority target kind must be node, heap, or diff.");
    }

    const metadata = await parseMetadata(args);
    const labels = flagString(args, "labels")
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const body: Record<string, unknown> = {
      targetKind,
      priority,
    };
    const targetId = nodeTarget || diffTarget || explicitTarget;
    if (targetId) body.targetId = targetId;
    body.resolverId =
      flagString(args, "resolver") || flagString(args, "resolverId") ||
      (targetKind === "node" ? RESOLVED_DOCUMENT_RESOLVER_ID : undefined);
    const reason = flagString(args, "reason");
    if (reason) body.reason = reason;
    if (labels?.length) body.labels = labels;
    if (metadata) body.metadata = metadata;
    const sourceSeq = flagString(args, "source-seq") || flagString(args, "sourceSeq");
    if (sourceSeq) body.sourceSeq = Number.parseInt(sourceSeq, 10);
    const sourceEventId = flagString(args, "source-event") || flagString(args, "sourceEventId");
    if (sourceEventId) body.sourceEventId = sourceEventId;

    const response = await request(
      config,
      `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/resolved/priority`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    print(config, response.data);
    return;
  }
  if (sub === "promote") {
    const rootId =
      args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
    const branchId = args.positionals[3] || flagString(args, "branch");
    if (!rootId || !branchId)
      throw new CliError("Usage: nd branch promote <rootId> <branchId>");
    const response = await request(
      config,
      `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/promote`,
      {
        method: "POST",
      },
    );
    print(
      config,
      response.data,
      `promoted ${(response.data as { url?: string } | null)?.url ?? "branch"}`,
    );
    return;
  }
  throw new CliError(
    "Usage: nd branch <list|resolve|content|snapshots|query|heap-update|priority|promote> ...",
  );
};

const commandDiffKeygen = async (config: CliConfig, args: ParsedArgs) => {
  const bundle = await readDiffAuthBundle(config);
  if (bundle.keys && !hasFlag(args, "force")) {
    print(
      config,
      { path: config.diffAuthTokenPath, clientId: bundle.keys.clientId },
      `diff auth token already has keys at ${config.diffAuthTokenPath}`,
    );
    return;
  }
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const record: DiffClientKeysRecord = {
    version: 1,
    clientId:
      flagString(args, "client") || config.clientId || `client_${randomUUID()}`,
    createdAt: Date.now(),
    encryptionPublicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    encryptionPrivateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
  await writeDiffAuthBundle(config, { ...bundle, keys: record });
  print(
    config,
    { path: config.diffAuthTokenPath, clientId: record.clientId },
    `created diff auth token at ${config.diffAuthTokenPath}`,
  );
};

const commandDiffRegister = async (config: CliConfig, args: ParsedArgs) => {
  const dropId =
    args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
  if (!dropId) throw new CliError("Usage: nd diff register <dropId>");
  const bundle = await readDiffAuthBundle(config);
  const keys = bundle.keys;
  if (!keys)
    throw new CliError(
      `Missing keypair in ${config.diffAuthTokenPath}. Run nd diff keygen first.`,
    );
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
  if (!response.data)
    throw new CliError("Diff auth registration returned no body.");
  const secret = await unwrapSecret(
    response.data.wrappedSecret,
    keys.encryptionPrivateJwk,
  );
  const entry: DiffCredentialEntry = {
    version: 1,
    dropId: response.data.dropId,
    branchId: response.data.branchId,
    baseUrl: config.baseUrl,
    clientId: response.data.clientId,
    kid: response.data.kid,
    secret,
    createdAt: Date.now(),
    expiresAt: response.data.expiresAt,
  };
  await writeCredential(config, entry);
  print(
    config,
    entry,
    `registered diff auth for ${entry.dropId} branch=${entry.branchId}`,
  );
};

const commandDiffToken = async (config: CliConfig, args: ParsedArgs) => {
  const action = args.positionals[2];
  if (action === "export" || action === "show") {
    const dropId =
      args.positionals[3] || flagString(args, "drop") || flagString(args, "id");
    const bundle = await readDiffAuthBundle(config);
    const credentials = dropId
      ? bundle.credentials[dropId]
        ? { [dropId]: bundle.credentials[dropId] }
        : {}
      : bundle.credentials;
    const exportedBundle: DiffAuthTokenBundle = {
      ...bundle,
      credentials,
    };
    const token = encodeDiffAuthToken(exportedBundle);
    if (config.json) {
      console.log(
        JSON.stringify(
          { token, credentialDropIds: Object.keys(credentials) },
          null,
          2,
        ),
      );
    } else {
      console.log(token);
    }
    return;
  }

  if (action === "import") {
    const tokenSource = flagString(args, "token") || args.positionals[3];
    const rawToken = tokenSource
      ? tokenSource === "-"
        ? await Bun.stdin.text()
        : tokenSource
      : await readInput(flagString(args, "token-file") || "-");
    const imported = decodeDiffAuthToken(rawToken);
    const existing = await readDiffAuthBundle(config);
    const hasExisting = Boolean(
      existing.keys || Object.keys(existing.credentials).length,
    );
    if (hasExisting && !hasFlag(args, "force") && !hasFlag(args, "merge")) {
      throw new CliError(
        "Diff auth token already exists. Use --merge or --force.",
      );
    }
    const next = hasFlag(args, "merge")
      ? mergeDiffAuthBundles(existing, imported, hasFlag(args, "force"))
      : imported;
    await writeDiffAuthBundle(config, next);
    print(
      config,
      {
        path: config.diffAuthTokenPath,
        hasKeys: Boolean(next.keys),
        credentialDropIds: Object.keys(next.credentials),
      },
      `imported diff auth token to ${config.diffAuthTokenPath}`,
    );
    return;
  }

  throw new CliError("Usage: nd diff token <export|import> ...");
};

const commandDiffSign = async (config: CliConfig, args: ParsedArgs) => {
  const dropId =
    args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
  if (!dropId)
    throw new CliError("Usage: nd diff sign <dropId> --body-file <file|->");
  const body = await readInput(
    flagString(args, "body-file") || flagString(args, "body") || "-",
  );
  const credential = await findCredential(config, dropId);
  if (!credential)
    throw new CliError(
      `No credential for ${dropId}. Run nd diff register ${dropId}.`,
    );
  const timestamp = String(Date.now());
  const path = `/api/diff/${encodeURIComponent(dropId)}`;
  const headers = {
    [DIFF_CLIENT_ID_HEADER]: credential.clientId,
    [DIFF_SECRET_KID_HEADER]: credential.kid,
    [DIFF_TIMESTAMP_HEADER]: timestamp,
    [DIFF_SIGNATURE_HEADER]: signDiffPayload(
      credential.secret,
      "POST",
      path,
      timestamp,
      body,
    ),
  };
  print(
    config,
    { headers },
    Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
  );
};

const commandDiff = async (config: CliConfig, args: ParsedArgs) => {
  const sub = args.positionals[1];
  if (sub === "keygen") return commandDiffKeygen(config, args);
  if (sub === "register") return commandDiffRegister(config, args);
  if (sub === "sign") return commandDiffSign(config, args);
  if (sub === "token") return commandDiffToken(config, args);

  const dropId =
    args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
  if (!dropId)
    throw new CliError(
      "Usage: nd diff <poll|latest|apply|replace|batch|event> <dropId>",
    );
  const branchId = flagString(args, "branch");

  if (sub === "poll" || sub === "latest") {
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    params.set(
      "cursor",
      sub === "latest" ? "__latest__" : (flagString(args, "cursor") ?? "-1"),
    );
    const limit = flagString(args, "limit");
    const exclude = flagString(args, "exclude-client");
    if (limit) params.set("limit", limit);
    if (exclude) params.set("excludeClient", exclude);
    const response = await request(
      config,
      `/api/diff/${encodeURIComponent(dropId)}?${params}`,
    );
    print(config, response.data);
    return;
  }

  if (sub === "event") {
    const parsed = await parseDiffEnvelopeInput(args);
    const response = await postDiffEnvelope(config, dropId, branchId, parsed);
    print(config, response.data);
    return;
  }

  if (sub === "batch") {
    if (!branchId)
      throw new CliError("nd diff batch requires --branch <branchId>.");
    const parsed = await parseDiffEnvelopeInput(args);
    const response = await postDiffEnvelope(config, dropId, branchId, parsed);
    print(config, response.data);
    return;
  }

  if (sub === "apply") {
    const canonical = await readDrop(config, dropId);
    const metadata = await parseDiffEventMetadata(args);
    const ops: DropDiffOp[] = [];
    const insert = flagString(args, "insert");
    const del = flagString(args, "delete");
    if (del) {
      const range = parseRange(del);
      ops.push({
        type: "delete",
        start: range.start,
        end: range.end,
        text: "",
      });
    }
    if (insert) {
      const value = parsePosition(insert);
      ops.push({
        type: "insert",
        start: value.start,
        end: value.start,
        text: value.text,
      });
    }
    if (!ops.length)
      throw new CliError(
        "Provide --insert pos:text and/or --delete start:end.",
      );
    const envelope = createEvent({
      dropId: canonical.id,
      clientId: config.clientId || "nd-cli",
      ops,
      metadata,
    });
    const response = await postDiffEnvelope(config, dropId, branchId, envelope);
    print(config, response.data);
    return;
  }

  if (sub === "replace") {
    if (!branchId)
      throw new CliError("nd diff replace requires --branch <branchId>.");
    const metadata = await parseDiffEventMetadata(args);
    const existingBranchContent = await readBranchContentOrNull(
      config,
      dropId,
      branchId,
    );
    const canonical = existingBranchContent
      ? null
      : await readDrop(config, dropId);
    const from = flagString(args, "from-file")
      ? await readInput(flagString(args, "from-file"))
      : (existingBranchContent?.content ?? getDropContent(canonical!));
    const toFile = flagString(args, "to-file");
    if (!toFile)
      throw new CliError("nd diff replace requires --to-file <file|->.");
    const to = await readInput(toFile);
    const diffs = computeDiffOps(from, to);
    if (!diffs.length) {
      print(config, { changed: false }, "no changes");
      return;
    }
    const ops = diffs.map((diff) => diffToDropDiffOp(diff));
    const envelope = createEvent({
      dropId: existingBranchContent?.rootDropId ?? canonical!.id,
      clientId: config.clientId || "nd-cli",
      ops,
      metadata,
    });
    const posted = await postDiffEnvelope(config, dropId, branchId, envelope);
    const postedBranchId =
      (posted.data as { branchId?: string } | null)?.branchId ?? branchId;
    const verify = await request<{ content: string }>(
      config,
      `/api/branches/${encodeURIComponent(dropId)}/${encodeBranchPathSegment(postedBranchId)}/content`,
    );
    print(
      config,
      { posted: posted.data, verified: verify.data?.content === to },
      `updated branch ${postedBranchId}`,
    );
    return;
  }

  throw new CliError(
    "Usage: nd diff <poll|latest|apply|replace|batch|event|keygen|register|sign|token> ...",
  );
};

const commandAuth = async (config: CliConfig, args: ParsedArgs) => {
  const sub = args.positionals[1];
  if (sub !== "session")
    throw new CliError(
      "Usage: nd auth session --account <id> --proof <file|->",
    );
  const accountId = flagString(args, "account");
  const proofPath = flagString(args, "proof") || "-";
  if (!accountId) throw new CliError("Missing --account <id>.");
  const proof = JSON.parse(await readInput(proofPath)) as Record<
    string,
    unknown
  >;
  const response = await request(config, "/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, ...proof }),
  });
  print(config, response.data);
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
};

const commandAdmin = async (config: CliConfig, args: ParsedArgs) => {
  const sub = args.positionals[1];
  if (
    sub !== "branch-backfill" &&
    sub !== "index-backfill" &&
    sub !== "metadata-backfill"
  ) {
    throw new CliError(
      "Usage: nd admin <branch-backfill|index-backfill|metadata-backfill>",
    );
  }
  const limit =
    flagString(args, "limit") ||
    (sub === "metadata-backfill"
      ? "500"
      : sub === "index-backfill"
        ? "200"
        : "100");
  const maxBatches = Number.parseInt(
    flagString(args, "max-batches") || "1000",
    10,
  );
  let cursor = flagString(args, "cursor");
  const token =
    flagString(args, "token") ||
    (sub === "metadata-backfill"
      ? process.env.METADATA_BACKFILL_TOKEN ||
        process.env.DROP_INDEX_BACKFILL_TOKEN
      : sub === "index-backfill"
        ? process.env.DROP_INDEX_BACKFILL_TOKEN
        : process.env.BRANCH_HEAP_BACKFILL_TOKEN);
  if (!token)
    throw new CliError("Missing admin token. Use --token or relevant env var.");
  const rootId =
    args.positionals[2] || flagString(args, "drop") || flagString(args, "id");
  const batches: unknown[] = [];
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const params = new URLSearchParams({ limit });
    if (cursor) params.set("cursor", cursor);
    if (sub === "branch-backfill" && !rootId)
      throw new CliError("Usage: nd admin branch-backfill <rootId>");
    const path =
      sub === "branch-backfill"
        ? `/api/branches/backfill/${encodeURIComponent(rootId || "")}?${params}`
        : sub === "metadata-backfill"
          ? `/api/metadata/backfill?${params}`
          : `/api/index/backfill?${params}`;
    const response = await request(config, path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    batches.push(response.data);
    cursor =
      (response.data as { cursor?: string | null } | null)?.cursor || undefined;
    if (
      !(response.data as { truncated?: boolean } | null)?.truncated ||
      !cursor
    )
      break;
    await sleep(Number.parseInt(flagString(args, "retry-ms") || "50", 10));
  }
  print(config, { batches });
};

const commandDoctor = async (config: CliConfig) => {
  const diffAuthBundle = await readDiffAuthBundle(config);
  const result = {
    baseUrl: config.baseUrl,
    hasToken: Boolean(config.token),
    accountId: config.accountId,
    clientId: config.clientId,
    configDir: config.configDir,
    diffAuthDir: config.diffAuthDir,
    diffAuthTokenPath: config.diffAuthTokenPath,
    hasInlineDiffAuthToken: Boolean(config.diffAuthToken),
    hasDiffAuthKeys: Boolean(diffAuthBundle.keys),
    diffAuthCredentialDropIds: Object.keys(diffAuthBundle.credentials),
  };
  print(config, result);
};

const commandSmoke = async (config: CliConfig, args: ParsedArgs) => {
  if (args.positionals[1] !== "diff")
    throw new CliError("Usage: nd smoke diff");
  const created = await request<{ id: string; url: string }>(
    config,
    "/api/store",
    {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: `nd-smoke-${Date.now()}`,
    },
  );
  if (!created.data?.id) throw new CliError("Smoke create failed: missing id.");
  const canonical = await readDrop(config, created.data.id);
  const ops: DropDiffOp[] = [
    {
      type: "insert",
      start: canonical.text.length,
      end: canonical.text.length,
      text: "-ok",
    },
  ];
  const envelope = createEvent({
    dropId: canonical.id,
    clientId: config.clientId || "nd-smoke",
    ops,
  });
  const posted = await postDiffEnvelope(config, canonical.id, null, envelope);
  print(
    config,
    { created: created.data, posted: posted.data },
    `smoke ok ${created.data.url}`,
  );
};

const parseServePort = (value: string | null): number => {
  const port = Number.parseInt(value || "8788", 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new CliError("Serve port must be between 1 and 65535.");
  }
  return port;
};

const commandServe = async (config: CliConfig, args: ParsedArgs) => {
  const host = flagString(args, "host") || process.env.ND_SERVE_HOST || "127.0.0.1";
  const port = parseServePort(flagString(args, "port") || process.env.ND_SERVE_PORT || null);
  const dataDir = resolve(
    flagString(args, "data-dir") || process.env.ND_DATA_DIR || ".nulldown-data",
  );
  const logLevel = flagString(args, "log-level") || process.env.LOG_LEVEL || "warn";
  const migrationsDir = resolve(
    flagString(args, "migrations-dir") || process.env.ND_MIGRATIONS_DIR || "migrations",
  );
  const { createLocalNulldownServer, localNulldownServerBaseUrl } = await import(
    "../server/local"
  );
  const sqliteEnabled = !hasFlag(args, "no-sqlite");
  const sqlite = sqliteEnabled
    ? await import("../server/bunSqliteStore").then(async (module) => {
        const sql = await module.createBunSqliteStore({
          databasePath: resolve(dataDir, "metadata.sqlite"),
        });
        const migrationsApplied = await module.applySqliteMigrations(sql, migrationsDir);
        return { sql, migrationsApplied };
      })
    : null;
  const publicBaseUrl =
    flagString(args, "public-base-url") || localNulldownServerBaseUrl(host, port);
  const server = createLocalNulldownServer({
    dataDir,
    publicBaseUrl,
    logLevel,
    sql: sqlite?.sql,
  });

  const listener = Bun.serve({
    hostname: host,
    port,
    fetch: (request) => server.fetch(request),
  });
  const served = {
    host,
    port: listener.port,
    dataDir,
    baseUrl: publicBaseUrl,
    sqlite: Boolean(sqlite),
    databasePath: sqlite?.sql.databasePath ?? null,
    migrationsApplied: sqlite?.migrationsApplied ?? [],
  };
  print(config, served, `nulldown serving ${publicBaseUrl} using ${dataDir}`);

  await new Promise<void>(() => undefined);
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
  if (command === "create") return commandCreate(config, args);
  if (command === "get") return commandGet(config, args);
  if (command === "update") return commandUpdate(config, args);
  if (command === "delete") return commandDelete(config, args);
  if (command === "list") return commandList(config, args);
  if (command === "search") return commandSearch(config, args);
  if (command === "branch") return commandBranch(config, args);
  if (command === "diff") return commandDiff(config, args);
  if (command === "auth") return commandAuth(config, args);
  if (command === "admin") return commandAdmin(config, args);
  if (command === "serve") return commandServe(config, args);
  if (command === "doctor") return commandDoctor(config);
  if (command === "smoke") return commandSmoke(config, args);
  throw new CliError(`Unknown command: ${command}`);
};

export const runCli = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv);
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
