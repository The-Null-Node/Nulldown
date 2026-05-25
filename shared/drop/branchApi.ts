import {
  NULLDOWN_ACCOUNT_ID_HEADER,
  type DropBranchContentResponse,
  type DropBranchPromoteResponse,
  type DropBranchResolveResponse,
  type DropSnapshotListResponse,
} from "./branch";
import type {
  ResolvedDocumentNodeQueryResult,
  ResolvedRuntimeNodeQueryResult,
} from "./resolved";
import type {
  NullplugUiPrimitive,
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
  NullplugUiStateSnapshot,
} from "../nullplug/ui";

export interface BranchApiClientOptions {
  baseUrl: string;
  accountId?: string | null;
  clientId?: string | null;
  authToken?: string | null;
  authTokenProvider?: (() => Promise<string | null>) | null;
  fetchImpl?: typeof fetch;
}

export interface BranchResolvedQueryOptions {
  resolverId?: string;
  query?: string;
  top?: number;
  kind?: string;
  snapshotId?: number | "latest";
  fromSeq?: number;
  toSeq?: number;
  changedOnly?: boolean;
  includeAncestors?: boolean;
  includeEventMetadata?: boolean;
  pluginId?: string;
  callId?: string;
  primitiveId?: string;
}

export interface BranchResolvedQueryResponse {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  resolverId: string;
  resolverVersion: string;
  sourceContentHash: string;
  stale: boolean;
  heapGenerated: boolean;
  nodeCount: number;
  nodes: Array<ResolvedDocumentNodeQueryResult | ResolvedRuntimeNodeQueryResult>;
}

export interface BranchResolvedUpdateRequest {
  resolverId?: string;
  snapshotId?: number | "latest";
  uiPrimitives?: NullplugUiPrimitive[];
  uiResponseFacts?: NullplugUiResponseFact[];
  uiStatePatchFacts?: NullplugUiStatePatchFact[];
  uiStateSnapshots?: NullplugUiStateSnapshot[];
}

export interface BranchResolvedUpdateResponse {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  sourceContentHash: string;
  updated: Array<{
    resolverId: string;
    key: string;
    nodeCount: number;
    sourceContentHash: string;
  }>;
}

const withHeaders = async (
  options: BranchApiClientOptions,
  extra: Record<string, string> = {},
): Promise<HeadersInit> => {
  const headers: Record<string, string> = { ...extra };
  if (options.accountId) {
    headers[NULLDOWN_ACCOUNT_ID_HEADER] = options.accountId;
  }
  if (options.clientId) {
    headers["x-nulldown-client-id"] = options.clientId;
  }

  const providedToken =
    options.authToken ?? (await options.authTokenProvider?.());
  if (providedToken) {
    headers.Authorization = `Bearer ${providedToken}`;
  }

  return headers;
};

const readJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(
      (await response.text()) || `${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as T;
};

const appendDefined = (
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | undefined,
): void => {
  if (value === undefined) return;
  params.set(key, String(value));
};

export const createBranchApiClient = (options: BranchApiClientOptions) => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return {
    async resolveBranch(dropId: string): Promise<DropBranchResolveResponse> {
      const response = await fetchImpl(
        `${baseUrl}/api/branches/resolve/${encodeURIComponent(dropId)}`,
        {
          method: "POST",
          headers: await withHeaders(options),
        },
      );
      return readJson<DropBranchResolveResponse>(response);
    },

    async getBranchContent(
      rootDropId: string,
      branchId: string,
    ): Promise<DropBranchContentResponse> {
      const response = await fetchImpl(
        `${baseUrl}/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/content`,
        {
          method: "GET",
          headers: await withHeaders(options),
        },
      );
      return readJson<DropBranchContentResponse>(response);
    },

    async listSnapshots(
      rootDropId: string,
      branchId: string,
    ): Promise<DropSnapshotListResponse> {
      const response = await fetchImpl(
        `${baseUrl}/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/snapshots`,
        {
          method: "GET",
          headers: await withHeaders(options),
        },
      );
      return readJson<DropSnapshotListResponse>(response);
    },

    async queryResolved(
      rootDropId: string,
      branchId: string,
      queryOptions: BranchResolvedQueryOptions = {},
    ): Promise<BranchResolvedQueryResponse> {
      const params = new URLSearchParams();
      appendDefined(params, "resolverId", queryOptions.resolverId);
      appendDefined(params, "q", queryOptions.query);
      appendDefined(params, "k", queryOptions.top);
      appendDefined(params, "kind", queryOptions.kind);
      appendDefined(params, "snapshotId", queryOptions.snapshotId);
      appendDefined(params, "fromSeq", queryOptions.fromSeq);
      appendDefined(params, "toSeq", queryOptions.toSeq);
      appendDefined(params, "changedOnly", queryOptions.changedOnly);
      appendDefined(params, "includeAncestors", queryOptions.includeAncestors);
      appendDefined(params, "includeEventMetadata", queryOptions.includeEventMetadata);
      appendDefined(params, "pluginId", queryOptions.pluginId);
      appendDefined(params, "callId", queryOptions.callId);
      appendDefined(params, "primitiveId", queryOptions.primitiveId);
      const suffix = params.size ? `?${params}` : "";
      const response = await fetchImpl(
        `${baseUrl}/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/resolved/query${suffix}`,
        {
          method: "GET",
          headers: await withHeaders(options),
        },
      );
      return readJson<BranchResolvedQueryResponse>(response);
    },

    async updateResolved(
      rootDropId: string,
      branchId: string,
      update: BranchResolvedUpdateRequest = {},
    ): Promise<BranchResolvedUpdateResponse> {
      const response = await fetchImpl(
        `${baseUrl}/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/resolved/update`,
        {
          method: "POST",
          headers: await withHeaders(options, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(update),
        },
      );
      return readJson<BranchResolvedUpdateResponse>(response);
    },

    async promoteBranch(
      rootDropId: string,
      branchId: string,
    ): Promise<DropBranchPromoteResponse> {
      const response = await fetchImpl(
        `${baseUrl}/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/promote`,
        {
          method: "POST",
          headers: await withHeaders(options),
        },
      );
      return readJson<DropBranchPromoteResponse>(response);
    },
  };
};
