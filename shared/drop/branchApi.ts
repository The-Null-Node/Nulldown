import {
  NULLDOWN_ACCOUNT_ID_HEADER,
  type DropBranchContentResponse,
  type DropBranchPromoteResponse,
  type DropBranchResolveResponse,
  type DropSnapshotListResponse,
} from "./branch";

export interface BranchApiClientOptions {
  baseUrl: string;
  accountId?: string | null;
  clientId?: string | null;
  fetchImpl?: typeof fetch;
}

const withHeaders = (
  options: BranchApiClientOptions,
  extra: Record<string, string> = {},
): HeadersInit => {
  const headers: Record<string, string> = { ...extra };
  if (options.accountId) {
    headers[NULLDOWN_ACCOUNT_ID_HEADER] = options.accountId;
  }
  if (options.clientId) {
    headers["x-nulldown-client-id"] = options.clientId;
  }
  return headers;
};

const readJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
};

export const createBranchApiClient = (options: BranchApiClientOptions) => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return {
    async resolveBranch(dropId: string): Promise<DropBranchResolveResponse> {
      const response = await fetchImpl(`${baseUrl}/api/branches/resolve/${encodeURIComponent(dropId)}`, {
        method: "POST",
        headers: withHeaders(options),
      });
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
          headers: withHeaders(options),
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
          headers: withHeaders(options),
        },
      );
      return readJson<DropSnapshotListResponse>(response);
    },

    async promoteBranch(
      rootDropId: string,
      branchId: string,
    ): Promise<DropBranchPromoteResponse> {
      const response = await fetchImpl(
        `${baseUrl}/api/branches/${encodeURIComponent(rootDropId)}/${encodeURIComponent(branchId)}/promote`,
        {
          method: "POST",
          headers: withHeaders(options),
        },
      );
      return readJson<DropBranchPromoteResponse>(response);
    },
  };
};
