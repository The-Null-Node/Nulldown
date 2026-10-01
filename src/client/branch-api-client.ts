import {
  isDropBranchContentResponse,
  isDropBranchListResponse,
  isDropBranchPromoteResponse,
  isDropBranchResolveResponse,
  isDropSnapshotListResponse,
  NULLDOWN_ACCOUNT_ID_HEADER,
  type DropBranchContentResponse,
  type DropBranchListResponse,
  type DropBranchPromoteRequest,
  type DropBranchPromoteResponse,
  type DropBranchResolveResponse,
  type DropSnapshotListResponse,
} from "../../shared/drop/branch";
import {
  isBranchResolvedQueryResponse,
  isBranchResolvedUpdateResponse,
  isNullplugResponseSubmitResponse,
  isNullplugStateSubmitResponse,
} from "../../shared/drop/branch-api";
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
  isValid: (value: unknown) => value is T,
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
  if (!response.text.trim() || !isValid(response.data)) {
    throw new NulldownHttpTransportError(
      "Response body did not match the endpoint contract.",
      {
        code: "invalid_api_response",
        status: response.status,
      },
    );
  }
  return response.data;
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
  const request = async <T>(
    path: string,
    init: RequestInit,
    isValid: (value: unknown) => value is T,
  ): Promise<T> => await readJson(options, `${baseUrl}${path}`, init, isValid);

  const invalidReceipt = (): never => {
    throw new NulldownHttpTransportError(
      "Response receipt did not acknowledge the requested operation.",
      { code: "invalid_api_response" },
    );
  };

  return {
    async listBranches(rootDropId): Promise<DropBranchListResponse> {
      const response = await request(
        `/api/branches/${encodeURIComponent(rootDropId)}`,
        {
          method: "GET",
          headers: await withHeaders(options),
        },
        isDropBranchListResponse,
      );
      return response;
    },
    async resolveBranch(dropId): Promise<DropBranchResolveResponse> {
      return await request(
        `/api/branches/resolve/${encodeURIComponent(dropId)}`,
        { method: "POST", headers: await withHeaders(options) },
        isDropBranchResolveResponse,
      );
    },
    async getBranchContent(
      rootDropId,
      branchId,
    ): Promise<DropBranchContentResponse> {
      const response = await request(
        `/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/content`,
        { method: "GET", headers: await withHeaders(options) },
        isDropBranchContentResponse,
      );
      return response.branchId === branchId ? response : invalidReceipt();
    },
    async listSnapshots(
      rootDropId,
      branchId,
    ): Promise<DropSnapshotListResponse> {
      const response = await request(
        `/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/snapshots`,
        { method: "GET", headers: await withHeaders(options) },
        isDropSnapshotListResponse,
      );
      return response.branchId === branchId ? response : invalidReceipt();
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
      const response = await request(
        `/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/resolved/query${suffix}`,
        { method: "GET", headers: await withHeaders(options) },
        isBranchResolvedQueryResponse,
      );
      return response.branchId === branchId ? response : invalidReceipt();
    },
    async updateResolved(
      rootDropId,
      branchId,
      update: BranchResolvedUpdateRequest = {},
    ): Promise<BranchResolvedUpdateResponse> {
      const response = await request(
        `/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/resolved/update`,
        {
          method: "POST",
          headers: await withHeaders(options, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(update),
        },
        isBranchResolvedUpdateResponse,
      );
      return response.branchId === branchId ? response : invalidReceipt();
    },
    async submitNullplugResponse(
      fact: NullplugUiResponseFact,
    ): Promise<NullplugResponseSubmitResponse> {
      const response = await request(
        "/api/nullplug/submit",
        {
          method: "POST",
          headers: await withHeaders(options, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(fact),
        },
        isNullplugResponseSubmitResponse,
      );
      return response.stored &&
        response.fact.id === fact.id &&
        response.fact.primitiveId === fact.primitiveId &&
        response.fact.source.branchId === fact.source.branchId
        ? response
        : invalidReceipt();
    },
    async submitNullplugState(
      fact: NullplugUiStatePatchFact | NullplugUiStateSnapshot,
    ): Promise<NullplugStateSubmitResponse> {
      const response = await request(
        "/api/nullplug/state",
        {
          method: "POST",
          headers: await withHeaders(options, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(fact),
        },
        isNullplugStateSubmitResponse,
      );
      return response.stored &&
        response.fact.kind === fact.kind &&
        response.fact.id === fact.id &&
        response.fact.callId === fact.callId &&
        response.fact.source.branchId === fact.source.branchId
        ? response
        : invalidReceipt();
    },
    async promoteBranch(
      rootDropId,
      branchId,
      promotion: DropBranchPromoteRequest,
    ): Promise<DropBranchPromoteResponse> {
      const response = await request(
        `/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/promote`,
        {
          method: "POST",
          headers: await withHeaders(options, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(promotion),
        },
        isDropBranchPromoteResponse,
      );
      return response.branchId === branchId &&
        response.snapshotId === promotion.expectedSnapshotId
        ? response
        : invalidReceipt();
    },
  };
};
