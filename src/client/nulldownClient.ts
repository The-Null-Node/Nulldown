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
import type { DropEnvelopeV1, DropMetadata } from "../../shared/drop/types";
import type {
  DropDiffAppendResponse,
  DropDiffEnvelope,
  DropDiffEventMetadata,
  DropDiffOp,
} from "../../shared/drop/diff";
import { isDropDiffAppendResponse } from "../../shared/drop/diff";
import { DropDiffEventIdSchema } from "../../shared/drop/diffSchemas";
import type {
  NullplugInvokeRequest,
  NullplugInvokeResponse,
} from "../../shared/nullplug/types";
import type {
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
  NullplugUiStateSnapshot,
} from "../../shared/nullplug/ui";
import type {
  RemoteNullplugManifest,
  RemoteNullplugRegistryRecord,
} from "../../shared/nullplug/registry";

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

/** Input supplied when resolving a dynamic account bearer. */
export interface NulldownBearerRequest {
  /** True when the preceding request was rejected with a 401 response. */
  forceRefresh?: boolean;
  /** Bearer used by the rejected request, when available. */
  rejectedToken?: string | null;
}

/** Resolves an account bearer immediately before an HTTP request. */
export type NulldownBearerProvider = (
  request: NulldownBearerRequest,
) => Promise<string | null>;

/** Seals plaintext content before the client sends a drop-store request. */
export interface NulldownEnvelopeProvider {
  seal(input: {
    content: string;
    metadata: DropMetadata;
  }): Promise<DropEnvelopeV1>;
}

/** Configuration used to call a Nulldown API. */
export interface NulldownClientConfig {
  /** API base URL, without a trailing slash. */
  baseUrl: string;
  /** Optional bearer account token. */
  token?: string | null;
  /** Optional dynamic bearer resolver used when no static token is configured. */
  bearerProvider?: NulldownBearerProvider;
  /** Optional client-side sealer for account-owned drop requests. */
  envelopeProvider?: NulldownEnvelopeProvider;
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
export interface CreateNulldownClientOptions extends Partial<NulldownClientConfig> {}

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
  /** Optional snapshotter id to invoke yieldNext on the server side (for compact projections). */
  snapshotterId?: string;
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
  /** When true, the response includes freshness reports for the matching records. */
  includeFreshness?: boolean;
  /** Exact procedure record id for compact next-step projection. */
  procedureId?: string;
  /** Return procedure steps with index greater than this cursor. */
  afterStep?: number;
  /** Maximum procedure steps to return. */
  stepLimit?: number;
  /** Whether full records should be returned alongside capsules. */
  includeRecords?: boolean;
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

/** Request accepted when deleting a branch-scoped NullMem record. */
export interface NulldownMemoryDeleteRequest {
  /** Root drop id. */
  rootId: string;
  /** Branch id. */
  branchId: string;
  /** Stable memory record id to delete. */
  recordId: string;
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
  /** Stable event identity to reuse when retrying the same request. */
  eventId?: string;
  /** Original event creation time to reuse with `eventId` during a retry. */
  createdAt?: number;
}

/** Response returned after storing an immutable nullplug UI response fact. */
export interface NulldownNullplugSubmitResult {
  stored: boolean;
  indexed: boolean;
  key: string;
  fact: NullplugUiResponseFact;
}

/** Nullplug UI state facts accepted by the provider runtime. */
export type NulldownNullplugStateFact =
  | NullplugUiStatePatchFact
  | NullplugUiStateSnapshot;

/** Response returned after storing a nullplug UI state fact. */
export interface NulldownNullplugStateResult {
  stored: boolean;
  key: string;
  fact: NulldownNullplugStateFact;
}

/** Response returned by the remote nullplug registry list endpoint. */
export interface NulldownNullplugRegistryListResult {
  items: RemoteNullplugManifest[];
  cursor: string | null;
}

/** Response returned by the remote nullplug registry registration endpoint. */
export interface NulldownNullplugRegistryRegisterResult {
  registered: boolean;
  record: RemoteNullplugRegistryRecord;
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

  constructor(
    message: string,
    options: { status?: number; code?: string } = {},
  ) {
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
    const parsed = JSON.parse(
      base64UrlDecode(encoded),
    ) as Partial<DiffAuthTokenBundle>;
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

const isReplayableRequestBody = (body: RequestInit["body"]): boolean =>
  body === undefined || body === null || typeof body === "string" || body instanceof URLSearchParams;

/** Creates Nulldown client configuration from options and `ND_*` environment variables. */
export const createNulldownClientConfig = (
  options: CreateNulldownClientOptions = {},
): NulldownClientConfig => ({
  baseUrl: normalizeBaseUrl(options.baseUrl ?? process.env.ND_BASE_URL),
  token: Object.hasOwn(options, "token") ? options.token : process.env.ND_TOKEN ?? null,
  bearerProvider: options.bearerProvider,
  envelopeProvider: options.envelopeProvider,
  accountId: Object.hasOwn(options, "accountId")
    ? options.accountId
    : process.env.ND_ACCOUNT_ID ?? null,
  clientId: options.clientId ?? process.env.ND_CLIENT_ID ?? null,
  diffAuthToken:
    options.diffAuthToken ?? process.env.ND_DIFF_AUTH_TOKEN ?? null,
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
    const explicitAuthorization = new Headers(options.headers).has("Authorization");
    const bearerProvider =
      !explicitAuthorization && this.config.token === null
        ? this.config.bearerProvider
        : undefined;
    const perform = async (bearer: string | null): Promise<Response> => {
      const headers = new Headers(options.headers);
      if (bearer && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${bearer}`);
      }
      if (this.config.accountId && !headers.has(NULLDOWN_ACCOUNT_ID_HEADER)) {
        headers.set(NULLDOWN_ACCOUNT_ID_HEADER, this.config.accountId);
      }
      if (this.config.clientId && !headers.has(DIFF_CLIENT_ID_HEADER)) {
        headers.set(DIFF_CLIENT_ID_HEADER, this.config.clientId);
      }
      return await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        ...options,
        headers,
      });
    };

    let bearer = bearerProvider ? await bearerProvider({}) : this.config.token ?? null;
    let response = await perform(bearer);
    if (
      response.status === 401 &&
      bearerProvider &&
      bearer &&
      isReplayableRequestBody(options.body)
    ) {
      await response.body?.cancel().catch(() => undefined);
      bearer = await bearerProvider({ forceRefresh: true, rejectedToken: bearer });
      response = await perform(bearer);
    }
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
    const metadata = request.metadata ?? { themeId: "system" };
    const envelope = await this.config.envelopeProvider?.seal({
      content: request.content,
      metadata,
    });
    const response = await this.request("/api/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(envelope
          ? {
              envelope,
              id: request.id,
              upsert: request.upsert,
              expectedRevision: request.expectedRevision,
            }
          : { ...request, metadata }),
      }),
    });
    return response.data;
  }

  /** Searches public indexed drops. */
  async searchDrops(
    request: NulldownSearchDropsRequest = {},
  ): Promise<unknown> {
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
    appendParam(params, "snapshotterId", request.snapshotterId);
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
    appendParam(params, "procedureId", request.procedureId);
    appendParam(params, "afterStep", request.afterStep);
    appendParam(params, "stepLimit", request.stepLimit);
    if (request.includeFreshness) params.set("includeFreshness", "true");
    if (request.includeRecords !== undefined) {
      params.set("includeRecords", request.includeRecords ? "true" : "false");
    }
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

  /** Deletes a branch-scoped NullMem record. */
  async deleteMemoryRecord(
    request: NulldownMemoryDeleteRequest,
  ): Promise<unknown> {
    const response = await this.request(
      `/api/branches/${encodeURIComponent(request.rootId)}/${encodeBranchPathSegment(request.branchId)}/memory/${encodeURIComponent(request.recordId)}`,
      { method: "DELETE" },
    );
    return response.data;
  }

  /** Resolves a nullplug invocation through the provider runtime. */
  async resolveNullplug(
    request: NullplugInvokeRequest,
  ): Promise<NullplugInvokeResponse | null> {
    const response = await this.request<NullplugInvokeResponse>(
      "/api/nullplug/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    return response.data;
  }

  /** Stores an immutable nullplug UI response fact. */
  async submitNullplugResponse(
    fact: NullplugUiResponseFact,
  ): Promise<NulldownNullplugSubmitResult | null> {
    const response = await this.request<NulldownNullplugSubmitResult>(
      "/api/nullplug/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fact),
      },
    );
    return response.data;
  }

  /** Stores a nullplug UI state patch or snapshot fact. */
  async storeNullplugState(
    fact: NulldownNullplugStateFact,
  ): Promise<NulldownNullplugStateResult | null> {
    const response = await this.request<NulldownNullplugStateResult>(
      "/api/nullplug/state",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fact),
      },
    );
    return response.data;
  }

  /** Lists active remote nullplug manifests. */
  async listNullplugRegistry(): Promise<NulldownNullplugRegistryListResult | null> {
    const response = await this.request<NulldownNullplugRegistryListResult>(
      "/api/nullplug/registry",
    );
    return response.data;
  }

  /** Registers a signed remote nullplug manifest. */
  async registerNullplugManifest(
    manifest: RemoteNullplugManifest,
  ): Promise<NulldownNullplugRegistryRegisterResult | null> {
    const response = await this.request<NulldownNullplugRegistryRegisterResult>(
      "/api/nullplug/registry",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest),
      },
    );
    return response.data;
  }

  /** Posts a single atomic branch diff event and returns its server acknowledgement. */
  async applyDiff(
    request: NulldownDiffApplyRequest,
  ): Promise<DropDiffAppendResponse> {
    if ((request.eventId === undefined) !== (request.createdAt === undefined)) {
      throw new NulldownClientError(
        "Diff retries must provide eventId and createdAt together.",
        { code: "diff_retry_identity_incomplete" },
      );
    }
    if (request.eventId !== undefined) {
      const eventId = DropDiffEventIdSchema.safeParse(request.eventId);
      if (!eventId.success) {
        throw new NulldownClientError("Diff retry eventId is invalid.", {
          code: "diff_retry_identity_invalid",
        });
      }
      const createdAt = request.createdAt;
      if (
        createdAt === undefined ||
        !Number.isFinite(createdAt) ||
        !Number.isInteger(createdAt) ||
        createdAt < 0
      ) {
        throw new NulldownClientError("Diff retry createdAt is invalid.", {
          code: "diff_retry_identity_invalid",
        });
      }
    }
    const eventDropId = request.eventDropId ?? request.dropId;
    const envelope: DropDiffEnvelope = {
      version: 1,
      events: [
        {
          eventId: request.eventId ?? `mcp-${Date.now()}-${randomUUID()}`,
          seq: 0,
          dropId: eventDropId,
          sourceClientId: this.config.clientId || "nulldown-mcp",
          createdAt: request.createdAt ?? Date.now(),
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
    const credential = findDiffCredential(
      this.config.diffAuthToken,
      eventDropId,
    );

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

    const response = await this.request(`${path}${query}`, {
      method: "POST",
      headers,
      body,
    });
    if (!isDropDiffAppendResponse(response.data)) {
      throw new NulldownClientError(
        "Diff response did not include a durable acknowledgement. Upgrade the server before retrying.",
        { code: "diff_receipt_unconfirmed", status: response.status },
      );
    }
    if (
      (request.branchId && response.data.branchId !== request.branchId) ||
      response.data.acknowledgements.filter(
        (ack) => ack.eventId === envelope.events[0]?.eventId,
      ).length !== 1
    ) {
      throw new NulldownClientError(
        "Diff response did not acknowledge the submitted event. Retry the exact same event.",
        { code: "diff_receipt_unconfirmed", status: response.status },
      );
    }
    return response.data;
  }
}

/** Creates a Nulldown API client from options and environment defaults. */
export const createNulldownClient = (
  options: CreateNulldownClientOptions = {},
): NulldownClient => new NulldownClient(options);
