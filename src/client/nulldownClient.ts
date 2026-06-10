import { createHmac, randomUUID } from "node:crypto";
import {
  DIFF_CLIENT_ID_HEADER,
  DIFF_SECRET_KID_HEADER,
  DIFF_SIGNATURE_HEADER,
  DIFF_SIGNATURE_PREFIX,
  DIFF_TIMESTAMP_HEADER,
  buildDiffSigningPayload,
} from "../../shared/drop/diffAuth";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../shared/drop/branch";
import type {
  DropDiffEnvelope,
  DropDiffEventMetadata,
  DropDiffOp,
} from "../../shared/drop/diff";

/** JSON-compatible value accepted by Nulldown HTTP APIs. */
export type NulldownJsonValue =
  | null
  | boolean
  | number
  | string
  | NulldownJsonValue[]
  | { [key: string]: NulldownJsonValue };

/** Default production API base URL used by CLI and MCP clients. */
export const DEFAULT_NULLDOWN_BASE_URL = "https://nulldown.app";

/** Configuration used to call a Nulldown API. */
export interface NulldownClientConfig {
  /** API base URL, without a trailing slash. */
  baseUrl: string;
  /** Optional bearer account token. */
  token?: string | null;
  /** Optional development account id header. */
  accountId?: string | null;
  /** Optional stable client id for branch and diff operations. */
  clientId?: string | null;
  /** Optional exported `ndauth.v1` token containing diff credentials. */
  diffAuthToken?: string | null;
  /** Optional webhook fallback secret for diff signing. */
  diffWebhookSecret?: string | null;
  /** Optional fetch implementation for tests or alternate runtimes. */
  fetch?: typeof fetch;
}

/** Options accepted when constructing a Nulldown client. */
export interface CreateNulldownClientOptions
  extends Partial<NulldownClientConfig> {}

/** Raw HTTP response returned by the Nulldown client request helper. */
export interface NulldownApiResponse<T = unknown> {
  /** HTTP status code. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** Raw response text. */
  text: string;
  /** Parsed JSON data when available. */
  data: T | null;
}

/** Drop read result with canonical metadata and parsed body. */
export interface NulldownDropReadResult {
  /** Canonical drop id from response headers when present. */
  id: string;
  /** Drop id requested by the caller. */
  requestedId: string;
  /** Current drop revision or entity tag when present. */
  revision: string | null;
  /** Response content type. */
  contentType: string;
  /** Parsed JSON body for JSON drops, otherwise raw text. */
  body: unknown;
  /** Raw response text. */
  text: string;
}

/** Request body accepted by the drop creation API. */
export interface NulldownCreateDropRequest {
  /** Markdown content to store. */
  content: string;
  /** Structured drop metadata. */
  metadata?: Record<string, NulldownJsonValue>;
  /** Optional canonical id for revision-safe upserts. */
  id?: string;
  /** Whether to upsert an existing root object. */
  upsert?: boolean;
  /** Expected current revision for safe updates. */
  expectedRevision?: string;
}

/** Query options for public drop search. */
export interface NulldownSearchDropsRequest {
  /** Search query text. */
  query?: string;
  /** Optional owner filter. */
  owner?: string;
  /** Optional visibility filter. */
  visibility?: string;
  /** Maximum number of results. */
  limit?: number;
  /** Result offset. */
  offset?: number;
}

/** Query options for a branch resolved heap search. */
export interface NulldownBranchQueryRequest {
  /** Root drop id. */
  rootId: string;
  /** Branch id. */
  branchId: string;
  /** Query text. */
  query?: string;
  /** Maximum result count. */
  top?: number;
  /** Optional snapshot id. */
  snapshotId?: string | number;
  /** Optional resolver id. */
  resolverId?: string;
  /** Optional heap node kind filter. */
  kind?: string;
  /** Optional starting diff sequence. */
  fromSeq?: number;
  /** Optional ending diff sequence. */
  toSeq?: number;
  /** Optional nullplug plugin id filter. */
  pluginId?: string;
  /** Optional nullplug call id filter. */
  callId?: string;
  /** Optional nullplug primitive id filter. */
  primitiveId?: string;
  /** Whether to include only changed nodes. */
  changedOnly?: boolean;
  /** Whether to include ancestor nodes. */
  includeAncestors?: boolean;
  /** Whether to include event metadata. */
  includeEventMetadata?: boolean;
}

/** Query options for branch-scoped NullMem memory. */
export interface NulldownMemoryQueryRequest {
  /** Root drop id. */
  rootId: string;
  /** Branch id. */
  branchId: string;
  /** Optional query text. */
  query?: string;
  /** Optional memory kind filter. */
  kind?: "fact" | "procedure" | "capability";
  /** Optional labels that must all match. */
  labels?: string[];
  /** Maximum result count. */
  limit?: number;
}

/** Request accepted when creating a NullMem fact. */
export interface NulldownMemoryFactRequest {
  /** Root drop id. */
  rootId: string;
  /** Branch id. */
  branchId: string;
  /** Fact body. */
  text: string;
  /** Optional compact title. */
  title?: string;
  /** Optional target kind. */
  targetKind?: string;
  /** Optional target id. */
  targetId?: string;
  /** Retrieval labels. */
  labels?: string[];
  /** Sorting priority. */
  priority?: number;
  /** Confidence score. */
  confidence?: number;
  /** Structured metadata. */
  metadata?: Record<string, NulldownJsonValue>;
}

/** Request accepted when creating a NullMem procedure. */
export interface NulldownMemoryProcedureRequest {
  /** Root drop id. */
  rootId: string;
  /** Branch id. */
  branchId: string;
  /** Procedure goal. */
  goal: string;
  /** Compact reusable summary. */
  summary: string;
  /** Procedure steps. */
  steps?: NulldownJsonValue[];
  /** Procedure outcome. */
  outcome?: string;
  /** Optional reuse category. */
  reusableAs?: string;
  /** Retrieval labels. */
  labels?: string[];
  /** Sorting priority. */
  priority?: number;
  /** Confidence score. */
  confidence?: number;
  /** Structured metadata. */
  metadata?: Record<string, NulldownJsonValue>;
}

/** Request accepted when applying an atomic branch diff event. */
export interface NulldownDiffApplyRequest {
  /** Route drop id. */
  dropId: string;
  /** Branch id to mutate. */
  branchId?: string;
  /** Diff operations to apply. */
  ops: DropDiffOp[];
  /** Optional event metadata. */
  metadata?: DropDiffEventMetadata;
  /** Optional canonical drop id stored in the event. */
  eventDropId?: string;
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
  credentials: Record<string, DiffCredentialEntry>;
}

/** Error thrown for failed Nulldown API requests. */
export class NulldownClientError extends Error {
  /** HTTP status code when the failure came from HTTP. */
  readonly status?: number;
  /** Structured Nulldown error code when present. */
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "NulldownClientError";
    this.status = options.status;
    this.code = options.code;
  }
}

const parseJsonLoose = (text: string): unknown | null => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const DIFF_AUTH_TOKEN_PREFIX = "ndauth.v1.";

const base64UrlDecode = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
};

const decodeDiffAuthToken = (
  token?: string | null,
): DiffAuthTokenBundle | null => {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  const encoded = trimmed.startsWith(DIFF_AUTH_TOKEN_PREFIX)
    ? trimmed.slice(DIFF_AUTH_TOKEN_PREFIX.length)
    : trimmed;

  try {
    const parsed = JSON.parse(base64UrlDecode(encoded)) as Partial<DiffAuthTokenBundle>;
    if (parsed.version !== 1 || parsed.kind !== "nulldown.diff-auth.v1") {
      return null;
    }
    return {
      version: 1,
      kind: "nulldown.diff-auth.v1",
      credentials:
        parsed.credentials && typeof parsed.credentials === "object"
          ? (parsed.credentials as Record<string, DiffCredentialEntry>)
          : {},
    };
  } catch {
    return null;
  }
};

const findDiffCredential = (
  token: string | null | undefined,
  dropId: string,
): DiffCredentialEntry | null => {
  const bundle = decodeDiffAuthToken(token);
  return bundle?.credentials[dropId] ?? null;
};

const signDiffPayload = (
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string =>
  `${DIFF_SIGNATURE_PREFIX}${createHmac("sha256", secret)
    .update(buildDiffSigningPayload(method, path, timestamp, body))
    .digest("hex")}`;

const encodeBranchPathSegment = (value: string): string =>
  encodeURIComponent(value).replace(/%3A/gi, ":");

const appendParam = (
  params: URLSearchParams,
  name: string,
  value: string | number | boolean | undefined,
): void => {
  if (value === undefined) return;
  params.set(name, String(value));
};

const normalizeBaseUrl = (baseUrl?: string | null): string =>
  (baseUrl || DEFAULT_NULLDOWN_BASE_URL).replace(/\/$/, "");

/** Creates Nulldown client configuration from options and `ND_*` environment variables. */
export const createNulldownClientConfig = (
  options: CreateNulldownClientOptions = {},
): NulldownClientConfig => ({
  baseUrl: normalizeBaseUrl(options.baseUrl ?? process.env.ND_BASE_URL),
  token: options.token ?? process.env.ND_TOKEN ?? null,
  accountId: options.accountId ?? process.env.ND_ACCOUNT_ID ?? null,
  clientId: options.clientId ?? process.env.ND_CLIENT_ID ?? null,
  diffAuthToken: options.diffAuthToken ?? process.env.ND_DIFF_AUTH_TOKEN ?? null,
  diffWebhookSecret:
    options.diffWebhookSecret ?? process.env.DIFF_WEBHOOK_SECRET ?? null,
  fetch: options.fetch,
});

/** Small HTTP client for direct Nulldown API calls used by CLI and MCP surfaces. */
export class NulldownClient {
  private readonly config: NulldownClientConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CreateNulldownClientOptions = {}) {
    this.config = createNulldownClientConfig(options);
    this.fetchImpl = this.config.fetch ?? fetch;
  }

  /** Sends an authenticated API request and parses JSON when possible. */
  async request<T = unknown>(
    path: string,
    options: RequestInit = {},
  ): Promise<NulldownApiResponse<T>> {
    const headers = new Headers(options.headers);
    if (this.config.token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.config.token}`);
    }
    if (this.config.accountId && !headers.has(NULLDOWN_ACCOUNT_ID_HEADER)) {
      headers.set(NULLDOWN_ACCOUNT_ID_HEADER, this.config.accountId);
    }
    if (this.config.clientId && !headers.has(DIFF_CLIENT_ID_HEADER)) {
      headers.set(DIFF_CLIENT_ID_HEADER, this.config.clientId);
    }

    const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
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
      throw new NulldownClientError(message, { status: response.status, code });
    }

    return {
      status: response.status,
      headers: response.headers,
      text,
      data,
    };
  }

  /** Reads a drop by canonical or short id. */
  async getDrop(id: string): Promise<NulldownDropReadResult> {
    const response = await this.request(`/api/get/${encodeURIComponent(id)}`);
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
  }

  /** Creates a new drop or revision-safe root upsert. */
  async createDrop(request: NulldownCreateDropRequest): Promise<unknown> {
    const response = await this.request("/api/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...request,
        metadata: request.metadata ?? { themeId: "system" },
      }),
    });
    return response.data;
  }

  /** Searches public indexed drops. */
  async searchDrops(request: NulldownSearchDropsRequest = {}): Promise<unknown> {
    const params = new URLSearchParams();
    params.set("q", request.query ?? "");
    appendParam(params, "owner", request.owner);
    appendParam(params, "visibility", request.visibility);
    appendParam(params, "limit", request.limit);
    appendParam(params, "offset", request.offset);
    const response = await this.request(`/api/search?${params}`);
    return response.data;
  }

  /** Resolves or creates the current actor/client branch for a drop. */
  async resolveBranch(dropId: string): Promise<unknown> {
    const response = await this.request(
      `/api/branches/resolve/${encodeURIComponent(dropId)}`,
      { method: "POST" },
    );
    return response.data;
  }

  /** Reads exact branch content. */
  async getBranchContent(rootId: string, branchId: string): Promise<unknown> {
    const response = await this.request(
      `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/content`,
    );
    return response.data;
  }

  /** Queries a branch resolved heap. */
  async queryBranch(request: NulldownBranchQueryRequest): Promise<unknown> {
    const params = new URLSearchParams();
    appendParam(params, "q", request.query);
    appendParam(params, "k", request.top);
    appendParam(params, "snapshotId", request.snapshotId);
    appendParam(params, "resolverId", request.resolverId);
    appendParam(params, "kind", request.kind);
    appendParam(params, "fromSeq", request.fromSeq);
    appendParam(params, "toSeq", request.toSeq);
    appendParam(params, "pluginId", request.pluginId);
    appendParam(params, "callId", request.callId);
    appendParam(params, "primitiveId", request.primitiveId);
    if (request.changedOnly) params.set("changedOnly", "true");
    if (request.includeAncestors) params.set("includeAncestors", "true");
    if (request.includeEventMetadata === false) {
      params.set("includeEventMetadata", "false");
    }
    const suffix = params.size ? `?${params}` : "";
    const response = await this.request(
      `/api/branches/${encodeURIComponent(request.rootId)}/${encodeBranchPathSegment(request.branchId)}/resolved/query${suffix}`,
    );
    return response.data;
  }

  /** Queries branch-scoped NullMem records. */
  async queryMemory(request: NulldownMemoryQueryRequest): Promise<unknown> {
    const params = new URLSearchParams();
    appendParam(params, "query", request.query);
    appendParam(params, "kind", request.kind);
    if (request.labels?.length) params.set("labels", request.labels.join(","));
    appendParam(params, "limit", request.limit);
    const suffix = params.size ? `?${params}` : "";
    const response = await this.request(
      `/api/branches/${encodeURIComponent(request.rootId)}/${encodeBranchPathSegment(request.branchId)}/memory/query${suffix}`,
    );
    return response.data;
  }

  /** Creates a branch-scoped NullMem fact. */
  async createMemoryFact(request: NulldownMemoryFactRequest): Promise<unknown> {
    const { rootId, branchId, ...body } = request;
    const response = await this.request(
      `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/memory/facts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return response.data;
  }

  /** Creates a branch-scoped NullMem procedure. */
  async createMemoryProcedure(
    request: NulldownMemoryProcedureRequest,
  ): Promise<unknown> {
    const { rootId, branchId, ...body } = request;
    const response = await this.request(
      `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}/memory/procedures`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return response.data;
  }

  /** Posts a single atomic branch diff event. */
  async applyDiff(request: NulldownDiffApplyRequest): Promise<unknown> {
    const eventDropId = request.eventDropId ?? request.dropId;
    const envelope: DropDiffEnvelope = {
      version: 1,
      events: [
        {
          eventId: `mcp-${Date.now()}-${randomUUID()}`,
          seq: 0,
          dropId: eventDropId,
          sourceClientId: this.config.clientId || "nulldown-mcp",
          createdAt: Date.now(),
          ops: request.ops,
          metadata: request.metadata,
        },
      ],
    };
    const query = request.branchId
      ? `?branchId=${encodeURIComponent(request.branchId)}`
      : "";
    const path = `/api/diff/${encodeURIComponent(request.dropId)}`;
    const body = JSON.stringify(envelope);
    const headers = new Headers({ "Content-Type": "application/json" });
    const credential = findDiffCredential(this.config.diffAuthToken, eventDropId);

    if (credential) {
      const timestamp = String(Date.now());
      headers.set(DIFF_CLIENT_ID_HEADER, credential.clientId);
      headers.set(DIFF_SECRET_KID_HEADER, credential.kid);
      headers.set(DIFF_TIMESTAMP_HEADER, timestamp);
      headers.set(
        DIFF_SIGNATURE_HEADER,
        signDiffPayload(credential.secret, "POST", path, timestamp, body),
      );
    } else if (this.config.diffWebhookSecret) {
      const timestamp = String(Date.now());
      headers.set(DIFF_TIMESTAMP_HEADER, timestamp);
      headers.set(
        DIFF_SIGNATURE_HEADER,
        signDiffPayload(
          this.config.diffWebhookSecret,
          "POST",
          path,
          timestamp,
          body,
        ),
      );
    }

    const response = await this.request(
      `${path}${query}`,
      {
        method: "POST",
        headers,
        body,
      },
    );
    return response.data;
  }
}

/** Creates a Nulldown API client from options and environment defaults. */
export const createNulldownClient = (
  options: CreateNulldownClientOptions = {},
): NulldownClient => new NulldownClient(options);
