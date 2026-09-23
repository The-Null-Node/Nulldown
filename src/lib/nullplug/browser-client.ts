import { createBranchApiClient } from "../../../shared/drop/branch-api";
import type { NullplugRuntime } from "../../../shared/nullplug/runtime";
import type {
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
} from "../../../shared/nullplug/ui";
import { getAccountSessionToken } from "../auth/accountSession";
import { createRemoteNullplugRuntime } from "./remote-runtime";

/** Branch and actor context required when the browser submits a nullplug fact. */
export interface NullplugSubmissionContext {
  rootDropId: string;
  branchId: string;
  accountId: string;
  clientId: string;
}

/** Browser-owned nullplug client for invocation and branch fact submission. */
export interface BrowserNullplugClient extends NullplugRuntime {
  submitResponse(
    context: NullplugSubmissionContext,
    fact: NullplugUiResponseFact,
  ): Promise<void>;
  submitState(
    context: NullplugSubmissionContext,
    fact: NullplugUiStatePatchFact,
  ): Promise<void>;
}

/** Dependencies used to create one browser nullplug client instance. */
export interface CreateBrowserNullplugClientOptions {
  nullplugRuntime?: NullplugRuntime;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  authTokenProvider?: (() => Promise<string | null>) | null;
}

/** Creates a browser nullplug client with explicit transport dependencies. */
export const createBrowserNullplugClient = (
  options: CreateBrowserNullplugClientOptions = {},
): BrowserNullplugClient => {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;
  const authTokenProvider =
    options.authTokenProvider === undefined
      ? getAccountSessionToken
      : options.authTokenProvider;
  const runtime =
    options.nullplugRuntime ??
    createRemoteNullplugRuntime({
      baseUrl,
      fetchImpl,
      authTokenProvider,
    });

  return {
    ...(runtime.supports
      ? { supports: (request) => runtime.supports!(request) }
      : {}),
    invoke: (request) => runtime.invoke(request),
    async submitResponse(context, fact) {
      await createBranchApiClient({
        baseUrl,
        accountId: context.accountId,
        clientId: context.clientId,
        authTokenProvider,
        fetchImpl,
      }).submitNullplugResponse(fact);
    },
    async submitState(context, fact) {
      await createBranchApiClient({
        baseUrl,
        accountId: context.accountId,
        clientId: context.clientId,
        authTokenProvider,
        fetchImpl,
      }).submitNullplugState(fact);
    },
  };
};
