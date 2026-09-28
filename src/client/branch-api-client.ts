import {
  NULLDOWN_ACCOUNT_ID_HEADER,
  type DropBranchContentResponse,
  type DropBranchListResponse,
  type DropBranchPromoteRequest,
  type DropBranchPromoteResponse,
  type DropBranchResolveResponse,
  type DropSnapshotListResponse,
} from "../../shared/drop/branch";
import type {
  BranchApiClient,
  BranchResolvedQueryOptions,
  BranchResolvedQueryResponse,
  BranchResolvedUpdateRequest,
  BranchResolvedUpdateResponse,
  NullplugResponseSubmitResponse,
  NullplugStateSubmitResponse,
} from "../../shared/drop/branch-api";
import type {
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
  NullplugUiStateSnapshot,
} from "../../shared/nullplug/ui";
import {
  createNulldownHttpResponseError,
  NulldownHttpTransportError,
  requestNulldownHttp,
  type NulldownHttpFetch,
} from "./http-transport";

/** Request-scoped dependencies for the browser and script branch API adapter. */
export interface CreateBranchApiClientOptions {
  baseUrl: string;
  accountId?: string | null;
  clientId?: string | null;
  authToken?: string | null;
  authTokenProvider?: (() => Promise<string | null>) | null;
  fetchImpl?: NulldownHttpFetch;
  requestTimeoutMs?: number;
}

const withHeaders = async (
  options: CreateBranchApiClientOptions,
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
  if (providedToken) headers.Authorization = `Bearer ${providedToken}`;
  return headers;
};

const readJson = async <T>(
  options: CreateBranchApiClientOptions,
  url: string,
  init: RequestInit,
): Promise<T> => {
  const response = await requestNulldownHttp<T>(
    options.fetchImpl ?? fetch,
    url,
    {
      init,
      timeoutMs: options.requestTimeoutMs,
      responseMode: "json",
    },
  );
  if (!response.ok) throw createNulldownHttpResponseError(response);
  if (!response.text.trim()) {
    throw new NulldownHttpTransportError("Response body was not valid JSON.", {
      code: "invalid_json_response",
      status: response.status,
    });
  }
  return response.data as T;
};

const appendDefined = (
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | undefined,
): void => {
  if (value === undefined) return;
  params.set(key, String(value));
};

/** Creates one branch API adapter with browser- or script-owned credentials. */
export const createBranchApiClient = (
  options: CreateBranchApiClientOptions,
): BranchApiClient => {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const request = async <T>(path: string, init: RequestInit): Promise<T> =>
    await readJson<T>(options, `${baseUrl}${path}`, init);

  return {
    async listBranches(rootDropId): Promise<DropBranchListResponse> {
      return await request(`/api/branches/${encodeURIComponent(rootDropId)}`, {
        method: "GET",
        headers: await withHeaders(options),
      });
    },
    async resolveBranch(dropId): Promise<DropBranchResolveResponse> {
      return await request(
        `/api/branches/resolve/${encodeURIComponent(dropId)}`,
        { method: "POST", headers: await withHeaders(options) },
      );
    },
    async getBranchContent(
      rootDropId,
      branchId,
    ): Promise<DropBranchContentResponse> {
      return await request(
        `/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/content`,
        { method: "GET", headers: await withHeaders(options) },
      );
    },
    async listSnapshots(
      rootDropId,
      branchId,
    ): Promise<DropSnapshotListResponse> {
      return await request(
        `/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/snapshots`,
        { method: "GET", headers: await withHeaders(options) },
      );
    },
    async queryResolved(
      rootDropId,
      branchId,
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
      appendDefined(
        params,
        "includeEventMetadata",
        queryOptions.includeEventMetadata,
      );
      appendDefined(params, "pluginId", queryOptions.pluginId);
      appendDefined(params, "callId", queryOptions.callId);
      appendDefined(params, "primitiveId", queryOptions.primitiveId);
      const suffix = params.size ? `?${params}` : "";
      return await request(
        `/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/resolved/query${suffix}`,
        { method: "GET", headers: await withHeaders(options) },
      );
    },
    async updateResolved(
      rootDropId,
      branchId,
      update: BranchResolvedUpdateRequest = {},
    ): Promise<BranchResolvedUpdateResponse> {
      return await request(
        `/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/resolved/update`,
        {
          method: "POST",
          headers: await withHeaders(options, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(update),
        },
      );
    },
    async submitNullplugResponse(
      fact: NullplugUiResponseFact,
    ): Promise<NullplugResponseSubmitResponse> {
      return await request("/api/nullplug/submit", {
        method: "POST",
        headers: await withHeaders(options, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(fact),
      });
    },
    async submitNullplugState(
      fact: NullplugUiStatePatchFact | NullplugUiStateSnapshot,
    ): Promise<NullplugStateSubmitResponse> {
      return await request("/api/nullplug/state", {
        method: "POST",
        headers: await withHeaders(options, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(fact),
      });
    },
    async promoteBranch(
      rootDropId,
      branchId,
      promotion: DropBranchPromoteRequest,
    ): Promise<DropBranchPromoteResponse> {
      return await request(
        `/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/promote`,
        {
          method: "POST",
          headers: await withHeaders(options, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(promotion),
        },
      );
    },
  };
};
