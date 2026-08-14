import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { toShortDropId } from "../../../../shared/drop/id";
import {
  isRemoteNullplugManifestAllowed,
  NULLPLUG_INVOKE_CONTENT_TYPE,
  readLatestRemoteNullplugManifest,
  readRemoteNullplugManifest,
  type NullplugPermission,
  type RemoteNullplugRegistryRecord,
} from "../../../../shared/nullplug/registry";
import {
  createNullplugRuntime,
  NullplugRuntimeError,
  type NullplugRuntimeInvoker,
  type NullplugRuntimeResolver,
  type VoidNullplugRuntime,
  type VoidRuntimePolicy,
} from "../../../../shared/nullplug/runtime";
import {
  isNullplugInvokeResponse,
  type NullplugInvokeRequest,
  type NullplugInvokeResponse,
} from "../../../../shared/nullplug/types";
import { normalizeAllowedHosts } from "../../../../shared/nullplug/policy";
import { createDropIdentityRepository } from "../drops/identity/id";
import { readProviderDropPayload } from "../drops/services/providerPayload";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../core/platform/cloudflarePorts";

const REMOTE_NULLPLUG_RESPONSE_MAX_BYTES = 1_000_000;
const REMOTE_NULLPLUG_TIMEOUT_MS = 10_000;
const textEncoder = new TextEncoder();

/** Cloudflare capabilities required by the provider-owned nullplug runtime. */
export interface CloudflareNullplugRuntimeBindings {
  /** Canonical drop and remote manifest storage. */
  R2_BUCKET: R2Bucket;
  /** Optional D1 index used for canonical drop-id resolution. */
  DB?: D1Database;
  /** Provider escrow private key used to open provider-readable drops. */
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
  /** Comma- or newline-separated remote endpoint allowlist. */
  NULLPLUG_REGISTRY_ALLOWED_HOSTS?: string;
  /** Optional fetch implementation for tests and alternate runtimes. */
  fetchImpl?: typeof fetch;
}

const parseAllowedHosts = (value: string | undefined): string[] =>
  normalizeAllowedHosts(
    (value ?? "")
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

const firstStringArg = (
  request: NullplugInvokeRequest,
  key: string,
): string | null => {
  const value = request.call.args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const firstBodyLine = (value: string | undefined): string | null => {
  if (!value) return null;
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
};

const extractTitle = (content: string): string =>
  content
    .split(/\r?\n/)
    .map((line) => /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim())
    .find((line): line is string => Boolean(line)) ?? "Nulldown Drop";

const extractExcerpt = (content: string): string => {
  const excerpt = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return excerpt.length > 180 ? `${excerpt.slice(0, 177)}...` : excerpt;
};

const escapeMarkdownLinkText = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");

const createNdInvoker = (
  bindings: CloudflareNullplugRuntimeBindings,
): NullplugRuntimeInvoker => async (request) => {
  const target = firstStringArg(request, "id") ?? firstBodyLine(request.call.body);
  if (!target) {
    throw new NullplugRuntimeError(
      "missing_target",
      "nd resolver requires args.id or a body drop id.",
    );
  }

  const dropIdentityRepository = createDropIdentityRepository({
    blobs: createCloudflareBlobStore(bindings.R2_BUCKET),
    sql: createCloudflareSqlStore(bindings.DB),
  });
  const resolvedDropId = await dropIdentityRepository.resolveRemoteDropId(target);
  if (!resolvedDropId) {
    throw new NullplugRuntimeError("drop_not_found", "Drop not found.");
  }

  const providerDrop = await readProviderDropPayload(bindings, resolvedDropId);
  if (!providerDrop) {
    throw new NullplugRuntimeError(
      "drop_unreadable",
      "Provider could not read the requested drop.",
    );
  }

  const title = extractTitle(providerDrop.payload.content);
  const excerpt = extractExcerpt(providerDrop.payload.content);
  const shortId = toShortDropId(providerDrop.dropId);
  return {
    result: {
      content: [`### [${escapeMarkdownLinkText(title)}](/d/${shortId})`, excerpt]
        .filter(Boolean)
        .join("\n\n"),
      metadata: {
        pluginId: "nd",
        resolvedDropId: providerDrop.dropId,
        shortId,
        title,
        excerpt,
      },
    },
    diagnostics: [
      {
        level: "info",
        message: "Resolved built-in nd nullplug through provider runtime.",
      },
    ],
  } satisfies NullplugInvokeResponse;
};

const permissionCapability = (permission: NullplugPermission): string =>
  permission.kind;

const remoteRequest = (
  request: NullplugInvokeRequest,
  record: RemoteNullplugRegistryRecord,
): NullplugInvokeRequest => {
  const declaredCapabilities = new Set(
    record.manifest.permissions.map(permissionCapability),
  );
  return {
    ...request,
    call: {
      ...request.call,
      version: record.manifest.version,
    },
    context: {
      ...request.context,
      capabilities: request.context.capabilities.filter((capability) =>
        declaredCapabilities.has(capability),
      ),
    },
  };
};

const hasInvokeContentType = (value: string | null): boolean => {
  if (!value) return false;
  const parts = value
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  return (
    parts[0] === "application/vnd.nulldown.nullplug.invoke+json" &&
    parts.includes("version=1")
  );
};

const invokeRemote = async (
  bindings: CloudflareNullplugRuntimeBindings,
  record: RemoteNullplugRegistryRecord,
  request: NullplugInvokeRequest,
): Promise<NullplugInvokeResponse> => {
  const fetchImpl = bindings.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(record.manifest.endpoint, {
      method: "POST",
      headers: {
        Accept: NULLPLUG_INVOKE_CONTENT_TYPE,
        "Content-Type": NULLPLUG_INVOKE_CONTENT_TYPE,
      },
      body: JSON.stringify(remoteRequest(request, record)),
      signal: AbortSignal.timeout(REMOTE_NULLPLUG_TIMEOUT_MS),
    });
  } catch (error) {
    throw new NullplugRuntimeError(
      "remote_unavailable",
      `Remote nullplug ${record.manifest.id} could not be reached.`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new NullplugRuntimeError(
      "remote_failed",
      `Remote nullplug ${record.manifest.id} returned HTTP ${response.status}.`,
    );
  }
  if (!hasInvokeContentType(response.headers.get("Content-Type"))) {
    throw new NullplugRuntimeError(
      "remote_protocol_invalid",
      `Remote nullplug ${record.manifest.id} returned an unsupported content type.`,
    );
  }

  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > REMOTE_NULLPLUG_RESPONSE_MAX_BYTES) {
    throw new NullplugRuntimeError(
      "remote_result_too_large",
      `Remote nullplug ${record.manifest.id} response exceeded the size limit.`,
    );
  }
  const rawBody = await response.text();
  if (textEncoder.encode(rawBody).byteLength > REMOTE_NULLPLUG_RESPONSE_MAX_BYTES) {
    throw new NullplugRuntimeError(
      "remote_result_too_large",
      `Remote nullplug ${record.manifest.id} response exceeded the size limit.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    parsed = null;
  }
  if (!isNullplugInvokeResponse(parsed)) {
    throw new NullplugRuntimeError(
      "remote_result_invalid",
      `Remote nullplug ${record.manifest.id} returned an invalid response.`,
    );
  }
  return parsed;
};

const readRemoteRecord = (
  bindings: CloudflareNullplugRuntimeBindings,
  request: NullplugInvokeRequest,
): Promise<RemoteNullplugRegistryRecord | null> =>
  request.call.version
    ? readRemoteNullplugManifest(
        bindings.R2_BUCKET,
        request.call.pluginId,
        request.call.version,
      )
    : readLatestRemoteNullplugManifest(
        bindings.R2_BUCKET,
        request.call.pluginId,
      );

/** Creates the Cloudflare resolver chain for trusted built-ins and remote HTTP manifests. */
export const createCloudflareNullplugRuntime = (
  bindings: CloudflareNullplugRuntimeBindings,
  policy: VoidRuntimePolicy,
): VoidNullplugRuntime => {
  const allowedHosts = parseAllowedHosts(
    bindings.NULLPLUG_REGISTRY_ALLOWED_HOSTS,
  );
  const builtInResolver: NullplugRuntimeResolver = {
    resolve: (request) =>
      request.call.pluginId === "nd" ? createNdInvoker(bindings) : null,
  };
  const remoteResolver: NullplugRuntimeResolver = {
    async resolve(request) {
      const record = await readRemoteRecord(bindings, request);
      if (
        !record ||
        record.status !== "active" ||
        record.manifest.contentType !== NULLPLUG_INVOKE_CONTENT_TYPE ||
        !isRemoteNullplugManifestAllowed(record.manifest, allowedHosts)
      ) {
        return null;
      }
      return (invokeRequest) => invokeRemote(bindings, record, invokeRequest);
    },
  };

  return createNullplugRuntime({
    resolvers: [builtInResolver, remoteResolver],
    policy,
  });
};
