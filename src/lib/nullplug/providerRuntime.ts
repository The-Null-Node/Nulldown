import {
  isRemoteNullplugManifest,
  type RemoteNullplugManifest,
} from "../../../shared/nullplug/registry";
import {
  createNullplugRuntime,
  isNullplugRuntimeError,
  NullplugRuntimeError,
  type NullplugRuntimeResolver,
  type VoidNullplugRuntime,
} from "../../../shared/nullplug/runtime";
import {
  isNullplugInvokeResponse,
  type NullplugInvokeRequest,
  type NullplugRuntimeResolution,
} from "../../../shared/nullplug/types";
import { getAccountSessionToken } from "../auth/accountSession";

/** Browser HTTP dependencies for remote provider nullplug resolution. */
export interface CreateRemoteNullplugRuntimeOptions {
  /** Stable provider id retained in invocation provenance. */
  providerId?: string;
  /** Provider base URL. Empty uses the current origin. */
  baseUrl?: string;
  /** Fetch implementation used for registry and invocation requests. */
  fetchImpl?: typeof fetch;
  /** Registry cache duration in milliseconds. */
  registryTtlMs?: number;
  /** Supplies the current browser account session for protected invocations. */
  authTokenProvider?: (() => Promise<string | null>) | null;
}

const readRegistryPage = (
  value: unknown,
): { items: RemoteNullplugManifest[]; cursor: string | null } => {
  if (typeof value !== "object" || value === null || !("items" in value)) {
    return { items: [], cursor: null };
  }
  const items = (value as { items?: unknown }).items;
  const cursor = "cursor" in value ? value.cursor : null;
  return {
    items: Array.isArray(items) ? items.filter(isRemoteNullplugManifest) : [],
    cursor: typeof cursor === "string" && cursor ? cursor : null,
  };
};

const readProviderError = async (
  response: Response,
): Promise<{ code: string; message: string }> => {
  try {
    const value = (await response.json()) as unknown;
    if (typeof value === "object" && value !== null) {
      const code = "code" in value ? value.code : undefined;
      const error = "error" in value ? value.error : undefined;
      if (typeof code === "string" && typeof error === "string") {
        return { code, message: error };
      }
    }
  } catch {
    // Fall through to the stable transport error below.
  }
  return {
    code: "provider_invoke_failed",
    message: `Provider nullplug runtime returned HTTP ${response.status}.`,
  };
};

/** Creates a browser runtime that discovers registered plugins before invoking them. */
export const createRemoteNullplugRuntime = (
  options: CreateRemoteNullplugRuntimeOptions = {},
): VoidNullplugRuntime => {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const providerId = options.providerId ?? "nulldown-provider";
  const providerBaseUrl = baseUrl || "same-origin";
  const fetchImpl = options.fetchImpl ?? fetch;
  const registryTtlMs = Math.max(1_000, options.registryTtlMs ?? 60_000);
  const authTokenProvider = options.authTokenProvider ?? null;
  let manifests = new Map<string, RemoteNullplugManifest>();
  let registryExpiresAt = 0;

  const loadRegistry = async (): Promise<Map<string, RemoteNullplugManifest>> => {
    if (Date.now() < registryExpiresAt) return manifests;
    const items: RemoteNullplugManifest[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await fetchImpl(`${baseUrl}/api/nullplug/registry${suffix}`);
      if (!response.ok) {
        throw new NullplugRuntimeError(
          "registry_unavailable",
          `Nullplug registry returned HTTP ${response.status}.`,
        );
      }
      const page = readRegistryPage(await response.json());
      items.push(...page.items);
      cursor = page.cursor;
      if (cursor && seenCursors.has(cursor)) {
        throw new NullplugRuntimeError(
          "registry_invalid",
          "Nullplug registry returned a repeated cursor.",
        );
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    manifests = new Map(items.map((manifest) => [manifest.id, manifest]));
    registryExpiresAt = Date.now() + registryTtlMs;
    return manifests;
  };

  const resolver: NullplugRuntimeResolver = {
    async resolve(request) {
      const manifest = (await loadRegistry()).get(request.call.pluginId);
      if (
        !manifest ||
        (request.call.version && request.call.version !== manifest.version)
      ) {
        return null;
      }

      const resolution: NullplugRuntimeResolution = {
        pluginId: manifest.id,
        version: manifest.version,
        providerId,
        baseUrl: providerBaseUrl,
        scope: "remote",
      };
      return {
        resolution,
        invoke: async (invokeRequest: NullplugInvokeRequest) => {
          let response: Response;
          try {
            const token = await authTokenProvider?.();
            response = await fetchImpl(`${baseUrl}/api/nullplug/resolve`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({
                ...invokeRequest,
                call: { ...invokeRequest.call, version: manifest.version },
              }),
            });
          } catch (error) {
            throw new NullplugRuntimeError(
              "provider_transport_failed",
              "Provider nullplug runtime request failed.",
              { cause: error, resolution },
            );
          }
          if (!response.ok) {
            const providerError = await readProviderError(response);
            throw new NullplugRuntimeError(
              providerError.code,
              providerError.message,
              { resolution },
            );
          }
          let parsed: unknown;
          try {
            parsed = await response.json();
          } catch (error) {
            throw new NullplugRuntimeError(
              "provider_result_invalid",
              "Provider nullplug runtime returned invalid JSON.",
              { cause: error, resolution },
            );
          }
          if (!isNullplugInvokeResponse(parsed)) {
            throw new NullplugRuntimeError(
              "provider_result_invalid",
              "Provider nullplug runtime returned an invalid response.",
              { resolution },
            );
          }
          return parsed;
        },
      };
    },
  };

  const runtime = createNullplugRuntime({ resolvers: [resolver] });
  return {
    async supports(request) {
      return (await runtime.supports?.(request)) ?? false;
    },
    async invoke(request) {
      try {
        return await runtime.invoke(request);
      } catch (error) {
        if (
          !isNullplugRuntimeError(error) ||
          error.resolution ||
          error.code === "unsupported_plugin"
        ) {
          throw error;
        }
        throw new NullplugRuntimeError(error.code, error.message, {
          cause: error,
          resolution: {
            pluginId: request.call.pluginId,
            version: request.call.version,
            providerId,
            baseUrl: providerBaseUrl,
            scope: "remote",
          },
        });
      }
    },
  };
};

let defaultRemoteRuntime: VoidNullplugRuntime | null = null;

/** Returns the shared same-origin remote nullplug runtime for browser render surfaces. */
export const getDefaultRemoteNullplugRuntime = (): VoidNullplugRuntime => {
  defaultRemoteRuntime ??= createRemoteNullplugRuntime({
    authTokenProvider: getAccountSessionToken,
  });
  return defaultRemoteRuntime;
};
