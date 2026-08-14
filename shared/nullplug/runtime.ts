import {
  isNullplugInvokeResponse,
  isNullplugResult,
  type NullplugInvokeRequest,
  type NullplugInvokeResponse,
  type NullplugResult,
  type NullplugRuntimeResolution,
} from "./types";

/** Value returned by a compiled, remote, or policy-backed nullplug invoker. */
export type NullplugRuntimeReturn =
  | NullplugInvokeResponse
  | NullplugResult
  | string
  | null
  | undefined;

/** Executes one already-resolved nullplug invocation. */
export type NullplugRuntimeInvoker = (
  request: NullplugInvokeRequest,
) => NullplugRuntimeReturn | Promise<NullplugRuntimeReturn>;

/** Resolver-selected invoker with authoritative provider and version identity. */
export interface NullplugResolvedInvoker {
  /** Invoker selected for the request. */
  invoke: NullplugRuntimeInvoker;
  /** Resolution identity owned by the resolver rather than plugin output. */
  resolution: NullplugRuntimeResolution;
}

/** Resolves a typed invocation to a trusted local or remote invoker. */
export interface NullplugRuntimeResolver {
  /** Returns an invoker when this resolver owns the requested plugin. */
  resolve(
    request: NullplugInvokeRequest,
  ):
    | NullplugRuntimeInvoker
    | NullplugResolvedInvoker
    | null
    | Promise<NullplugRuntimeInvoker | NullplugResolvedInvoker | null>;
}

/** Provider policy that prepares an invocation and filters its normalized result. */
export interface VoidRuntimePolicy {
  /** Authorizes and optionally narrows a call before any resolver or invoker executes. */
  prepare(
    request: NullplugInvokeRequest,
  ): NullplugInvokeRequest | Promise<NullplugInvokeRequest>;
  /** Filters a normalized response after a successful invocation. */
  validate(
    response: NullplugInvokeResponse,
    request: NullplugInvokeRequest,
  ): NullplugInvokeResponse | Promise<NullplugInvokeResponse>;
}

/** Provider-owned nullplug invocation, normalization, and policy boundary. */
export interface VoidNullplugRuntime {
  /** Checks whether this runtime currently owns a call without invoking it. */
  supports?(request: NullplugInvokeRequest): Promise<boolean>;
  /** Resolves, invokes, normalizes, and validates one nullplug call. */
  invoke(request: NullplugInvokeRequest): Promise<NullplugInvokeResponse>;
}

/** Dependencies used to compose a provider-owned nullplug runtime. */
export interface CreateNullplugRuntimeOptions {
  /** Ordered resolvers. The first resolver that recognizes the plugin wins. */
  resolvers: readonly NullplugRuntimeResolver[];
  /** Optional provider policy applied before resolution and after normalization. */
  policy?: VoidRuntimePolicy;
}

/** Stable runtime failure carrying a machine-readable boundary error code. */
export class NullplugRuntimeError extends Error {
  readonly resolution?: NullplugRuntimeResolution;

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown; resolution?: NullplugRuntimeResolution },
  ) {
    super(message, options);
    this.name = "NullplugRuntimeError";
    this.resolution = options?.resolution;
  }
}

/** Returns true when a failure came from the nullplug runtime boundary. */
export const isNullplugRuntimeError = (
  value: unknown,
): value is NullplugRuntimeError => value instanceof NullplugRuntimeError;

const normalizeNullplugReturn = (
  value: NullplugRuntimeReturn,
): NullplugInvokeResponse => {
  if (value === null || value === undefined) {
    return { result: {} };
  }
  if (typeof value === "string") {
    return { result: { content: value } };
  }
  if (isNullplugInvokeResponse(value)) {
    return value;
  }
  if (isNullplugResult(value)) {
    return { result: value };
  }
  throw new NullplugRuntimeError(
    "invalid_result",
    "Nullplug invoker returned an invalid result.",
  );
};

const isResolvedInvoker = (
  value: NullplugRuntimeInvoker | NullplugResolvedInvoker,
): value is NullplugResolvedInvoker => typeof value !== "function";

/** Creates the concrete runtime wrapper shared by server and browser providers. */
export const createNullplugRuntime = ({
  resolvers,
  policy,
}: CreateNullplugRuntimeOptions): VoidNullplugRuntime => ({
  async supports(request) {
    try {
      for (const resolver of resolvers) {
        if (await resolver.resolve(request)) return true;
      }
      return false;
    } catch (error) {
      if (isNullplugRuntimeError(error)) throw error;
      throw new NullplugRuntimeError(
        "resolution_failed",
        `Failed to resolve nullplug ${request.call.pluginId}.`,
        { cause: error },
      );
    }
  },
  async invoke(request) {
    let preparedRequest = request;
    if (policy) {
      try {
        preparedRequest = await policy.prepare(request);
      } catch (error) {
        if (isNullplugRuntimeError(error)) throw error;
        throw new NullplugRuntimeError(
          "policy_prepare_failed",
          `Nullplug ${request.call.pluginId} policy preparation failed.`,
          { cause: error },
        );
      }
    }

    let invoker: NullplugRuntimeInvoker | null = null;
    let resolution: NullplugRuntimeResolution | undefined;

    try {
      for (const resolver of resolvers) {
        const resolved = await resolver.resolve(preparedRequest);
        if (!resolved) continue;
        if (isResolvedInvoker(resolved)) {
          invoker = resolved.invoke;
          resolution = resolved.resolution;
        } else {
          invoker = resolved;
        }
        if (invoker) break;
      }
    } catch (error) {
      if (isNullplugRuntimeError(error)) throw error;
      throw new NullplugRuntimeError(
        "resolution_failed",
        `Failed to resolve nullplug ${preparedRequest.call.pluginId}.`,
        { cause: error },
      );
    }

    if (!invoker) {
      throw new NullplugRuntimeError(
        "unsupported_plugin",
        `No nullplug resolver accepted ${preparedRequest.call.pluginId}.`,
      );
    }

    let returned: NullplugRuntimeReturn;
    try {
      returned = await invoker(preparedRequest);
    } catch (error) {
      if (isNullplugRuntimeError(error)) {
        if (!resolution) throw error;
        throw new NullplugRuntimeError(error.code, error.message, {
          cause: error,
          resolution,
        });
      }
      throw new NullplugRuntimeError(
        "invoke_failed",
        `Nullplug ${preparedRequest.call.pluginId} invocation failed.`,
        { cause: error, resolution },
      );
    }

    const normalized = normalizeNullplugReturn(returned);
    const response = resolution ? { ...normalized, resolution } : normalized;
    if (!policy) return response;

    try {
      const validated = await policy.validate(response, preparedRequest);
      return response.resolution
        ? { ...validated, resolution: response.resolution }
        : validated;
    } catch (error) {
      if (isNullplugRuntimeError(error)) throw error;
      throw new NullplugRuntimeError(
        "policy_validation_failed",
        `Nullplug ${preparedRequest.call.pluginId} policy validation failed.`,
        { cause: error },
      );
    }
  },
});
