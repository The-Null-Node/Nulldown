import type {
  AdminBackfillRequest,
  BranchMemoryDeleteRequest,
  BranchMemoryFactRequest,
  BranchMemoryProcedureRequest,
  BranchMemoryQueryRequest,
  BranchPriorityCreateRequest,
  BranchPriorityDeleteRequest,
  BranchPriorityListRequest,
  BranchResolvedQueryRequest,
  BranchResolvedUpdateRequest,
  AuthSessionRequest,
  DiffEnvelopeHeadersRequest,
  DiffEnvelopePostRequest,
  DiffPollRequest,
  DropCreateRequest,
  DropCreateResult,
  DropDeleteRequest,
  DropDeleteResult,
  DropListRequest,
  DropReadResult,
  DropSearchRequest,
  DropUpdateRequest,
  DropUpdateResult,
  NulldownRuntime,
} from "./types";

const encodeBranchPathSegment = (value: string): string =>
  encodeURIComponent(value).replace(/%3A/gi, ":");

const branchPath = (rootId: string, branchId: string): string =>
  `/api/branches/${encodeURIComponent(rootId)}/${encodeBranchPathSegment(branchId)}`;

const buildResolvedQueryParams = (
  request: BranchResolvedQueryRequest,
): URLSearchParams => {
  const params = new URLSearchParams();
  if (request.query) params.set("q", request.query);
  if (request.top) params.set("k", request.top);
  if (request.snapshotId) params.set("snapshotId", request.snapshotId);
  if (request.resolverId) params.set("resolverId", request.resolverId);
  if (request.kind) params.set("kind", request.kind);
  if (request.fromSeq) params.set("fromSeq", request.fromSeq);
  if (request.toSeq) params.set("toSeq", request.toSeq);
  if (request.pluginId) params.set("pluginId", request.pluginId);
  if (request.callId) params.set("callId", request.callId);
  if (request.primitiveId) params.set("primitiveId", request.primitiveId);
  if (request.changedOnly) params.set("changedOnly", "true");
  if (request.includeAncestors) params.set("includeAncestors", "true");
  if (request.includeEventMetadata === false) {
    params.set("includeEventMetadata", "false");
  }
  return params;
};

const buildMemoryQueryParams = (
  request: BranchMemoryQueryRequest,
): URLSearchParams => {
  const params = new URLSearchParams();
  if (request.query) params.set("query", request.query);
  if (request.kind) params.set("kind", request.kind);
  if (request.labels?.length) params.set("labels", request.labels.join(","));
  if (request.limit) params.set("limit", request.limit);
  if (request.procedureId) params.set("procedureId", request.procedureId);
  if (request.afterStep) params.set("afterStep", request.afterStep);
  if (request.stepLimit) params.set("stepLimit", request.stepLimit);
  if (request.includeFreshness) params.set("includeFreshness", "true");
  if (request.includeRecords !== undefined) {
    params.set("includeRecords", request.includeRecords ? "true" : "false");
  }
  return params;
};

const buildPriorityListParams = (
  request: BranchPriorityListRequest,
): URLSearchParams => {
  const params = new URLSearchParams();
  if (request.resolverId) params.set("resolverId", request.resolverId);
  if (request.targetKind) params.set("targetKind", request.targetKind);
  if (request.targetId) params.set("targetId", request.targetId);
  if (request.factId) params.set("factId", request.factId);
  if (request.limit) params.set("limit", request.limit);
  return params;
};

const buildDiffPollParams = (request: DiffPollRequest): URLSearchParams => {
  const params = new URLSearchParams();
  if (request.branchId) params.set("branchId", request.branchId);
  params.set("cursor", request.cursor);
  if (request.limit) params.set("limit", request.limit);
  if (request.excludeClient) params.set("excludeClient", request.excludeClient);
  return params;
};

const maybeSet = (
  body: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  if (value !== null && value !== undefined) body[key] = value;
};

interface RuntimeHttpResponse<T> {
  data: T | null;
}

/** Dependencies used by the HTTP-backed CLI runtime during migration. */
export interface HttpNulldownRuntimeDependencies {
  /** Existing drop read implementation to delegate through initially. */
  readDrop(id: string): Promise<DropReadResult>;
  /** Existing HTTP request helper to delegate through initially. */
  request<T = unknown>(
    path: string,
    options?: RequestInit,
  ): Promise<RuntimeHttpResponse<T>>;
  /** Optional hook for adding auth/signature headers to diff envelope posts. */
  diffEnvelopeHeaders?(
    request: DiffEnvelopeHeadersRequest,
  ): Promise<Record<string, string> | undefined>;
}

/** Creates the HTTP-backed command runtime for migrated CLI command groups. */
export const createHttpNulldownRuntime = (
  dependencies: HttpNulldownRuntimeDependencies,
): NulldownRuntime => ({
  drops: {
    async create(request: DropCreateRequest): Promise<DropCreateResult> {
      const response = await dependencies.request<DropCreateResult>("/api/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: request.content,
          metadata: request.metadata,
        }),
      });
      if (!response.data) throw new Error("Create response did not include a drop.");
      return response.data;
    },
    async update(request: DropUpdateRequest): Promise<DropUpdateResult> {
      const body: Record<string, unknown> = {
        id: request.id,
        upsert: true,
        content: request.content,
        metadata: request.metadata,
      };
      if (request.expectedRevision) body.expectedRevision = request.expectedRevision;
      const response = await dependencies.request<DropUpdateResult>("/api/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.data) throw new Error("Update response did not include a drop.");
      return response.data;
    },
    get: (id) => dependencies.readDrop(id),
    async list(request: DropListRequest = {}) {
      const params = new URLSearchParams();
      if (request.limit) params.set("limit", request.limit);
      if (request.cursor) params.set("cursor", request.cursor);
      const response = await dependencies.request(
        `/api/list${params.size ? `?${params}` : ""}`,
      );
      return response.data;
    },
    async search(request: DropSearchRequest = {}) {
      const params = new URLSearchParams();
      params.set("q", request.query ?? "");
      if (request.owner) params.set("owner", request.owner);
      if (request.visibility) params.set("visibility", request.visibility);
      if (request.limit) params.set("limit", request.limit);
      if (request.offset) params.set("offset", request.offset);
      const response = await dependencies.request(`/api/search?${params}`);
      return response.data;
    },
    async delete(id: string, request: DropDeleteRequest = {}): Promise<DropDeleteResult> {
      const headers: Record<string, string> = {};
      if (!request.force) {
        const current = await dependencies.readDrop(id);
        if (current.revision) headers["If-Match"] = current.revision;
      }
      await dependencies.request(`/api/delete/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
      });
      return { deleted: id };
    },
  },
  branches: {
    async list(rootId) {
      const response = await dependencies.request(
        `/api/branches/${encodeURIComponent(rootId)}`,
      );
      return response.data;
    },
    async resolve(dropId) {
      const response = await dependencies.request(
        `/api/branches/resolve/${encodeURIComponent(dropId)}`,
        { method: "POST" },
      );
      return response.data;
    },
    async content(rootId, branchId) {
      const response = await dependencies.request(
        `${branchPath(rootId, branchId)}/content`,
      );
      return response.data;
    },
    async contentOrNull(rootId, branchId) {
      try {
        const response = await dependencies.request(
          `${branchPath(rootId, branchId)}/content`,
        );
        return response.data;
      } catch (error) {
        if (error && typeof error === "object" && "status" in error) {
          const status = (error as { status?: unknown }).status;
          if (status === 404) return null;
        }
        throw error;
      }
    },
    async snapshots(rootId, branchId) {
      const response = await dependencies.request(
        `${branchPath(rootId, branchId)}/snapshots`,
      );
      return response.data;
    },
    async promote(input) {
      const response = await dependencies.request(
        `${branchPath(input.rootId, input.branchId)}/promote`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedSnapshotId: input.expectedSnapshotId,
            idempotencyKey: input.idempotencyKey,
          }),
        },
      );
      return response.data;
    },
  },
  diffs: {
    async poll(request: DiffPollRequest) {
      const params = buildDiffPollParams(request);
      const response = await dependencies.request(
        `/api/diff/${encodeURIComponent(request.dropId)}?${params}`,
      );
      return response.data;
    },
    async postEnvelope(request: DiffEnvelopePostRequest) {
      const body = JSON.stringify(request.envelope);
      const path = `/api/diff/${encodeURIComponent(request.dropId)}`;
      const signedHeaders = await dependencies.diffEnvelopeHeaders?.({
        ...request,
        path,
        body,
      });
      const query = request.branchId
        ? `?branchId=${encodeURIComponent(request.branchId)}`
        : "";
      const response = await dependencies.request(`${path}${query}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(signedHeaders ?? {}),
        },
        body,
      });
      return response.data;
    },
  },
  auth: {
    async session(request: AuthSessionRequest) {
      const response = await dependencies.request("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: request.accountId, ...request.proof }),
      });
      return response.data;
    },
  },
  admin: {
    async backfill(request: AdminBackfillRequest) {
      const params = new URLSearchParams({ limit: request.limit });
      if (request.cursor) params.set("cursor", request.cursor);
      const path =
        request.target === "branch-backfill"
          ? `/api/branches/backfill/${encodeURIComponent(request.rootId || "")}?${params}`
          : request.target === "metadata-backfill"
            ? `/api/metadata/backfill?${params}`
            : `/api/index/backfill?${params}`;
      const response = await dependencies.request(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${request.token}` },
      });
      return response.data;
    },
  },
  resolved: {
    async query(request: BranchResolvedQueryRequest) {
      const params = buildResolvedQueryParams(request);
      const response = await dependencies.request(
        `${branchPath(request.rootId, request.branchId)}/resolved/query${params.size ? `?${params}` : ""}`,
      );
      return response.data;
    },
    async update(request: BranchResolvedUpdateRequest) {
      const body: Record<string, unknown> = { resolverId: request.resolverId };
      if (request.snapshotId !== null && request.snapshotId !== undefined) {
        body.snapshotId = request.snapshotId;
      }
      const response = await dependencies.request(
        `${branchPath(request.rootId, request.branchId)}/resolved/update`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return response.data;
    },
  },
  memory: {
    async query(request: BranchMemoryQueryRequest) {
      const params = buildMemoryQueryParams(request);
      const response = await dependencies.request(
        `${branchPath(request.rootId, request.branchId)}/memory/query${params.size ? `?${params}` : ""}`,
      );
      return response.data;
    },
    async fact(request: BranchMemoryFactRequest) {
      const body: Record<string, unknown> = { text: request.text };
      maybeSet(body, "title", request.title);
      maybeSet(body, "targetKind", request.targetKind);
      maybeSet(body, "targetId", request.targetId);
      if (request.labels?.length) body.labels = request.labels;
      maybeSet(body, "priority", request.priority);
      maybeSet(body, "confidence", request.confidence);
      maybeSet(body, "metadata", request.metadata);
      const response = await dependencies.request(
        `${branchPath(request.rootId, request.branchId)}/memory/facts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return response.data;
    },
    async procedure(request: BranchMemoryProcedureRequest) {
      const body: Record<string, unknown> = {
        goal: request.goal,
        summary: request.summary,
      };
      maybeSet(body, "steps", request.steps);
      maybeSet(body, "outcome", request.outcome);
      maybeSet(body, "reusableAs", request.reusableAs);
      if (request.labels?.length) body.labels = request.labels;
      maybeSet(body, "priority", request.priority);
      maybeSet(body, "confidence", request.confidence);
      maybeSet(body, "metadata", request.metadata);
      const response = await dependencies.request(
        `${branchPath(request.rootId, request.branchId)}/memory/procedures`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return response.data;
    },
    async delete(request: BranchMemoryDeleteRequest) {
      const response = await dependencies.request(
        `${branchPath(request.rootId, request.branchId)}/memory/${encodeURIComponent(request.recordId)}`,
        { method: "DELETE" },
      );
      return response.data;
    },
  },
  priority: {
    async list(request: BranchPriorityListRequest) {
      const params = buildPriorityListParams(request);
      const response = await dependencies.request(
        `${branchPath(request.rootId, request.branchId)}/resolved/priority${params.size ? `?${params}` : ""}`,
      );
      return response.data;
    },
    async create(request: BranchPriorityCreateRequest) {
      const body: Record<string, unknown> = {
        targetKind: request.targetKind,
        priority: request.priority,
      };
      maybeSet(body, "targetId", request.targetId);
      maybeSet(body, "resolverId", request.resolverId);
      maybeSet(body, "reason", request.reason);
      if (request.labels?.length) body.labels = request.labels;
      maybeSet(body, "metadata", request.metadata);
      maybeSet(body, "sourceSeq", request.sourceSeq);
      maybeSet(body, "sourceEventId", request.sourceEventId);
      const response = await dependencies.request(
        `${branchPath(request.rootId, request.branchId)}/resolved/priority`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return response.data;
    },
    async delete(request: BranchPriorityDeleteRequest) {
      const response = await dependencies.request(
        `${branchPath(request.rootId, request.branchId)}/resolved/priority/${encodeURIComponent(request.factId)}`,
        { method: "DELETE" },
      );
      return response.data;
    },
  },
});
