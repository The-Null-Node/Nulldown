import type { JsonValue } from "./types";
import { serializeCanonicalJson } from "../drop/types";

export const NULLPLUG_REGISTRY_MANIFEST_KEY_PREFIX = "__nullplug_registry__/manifests/";
export const NULLPLUG_REGISTRY_LATEST_KEY_PREFIX = "__nullplug_registry__/latest/";
export const NULLPLUG_MANIFEST_SIGNATURE_PREFIX = "sha256=";

export type NullplugPermission =
  | { kind: "network"; hosts: string[] }
  | { kind: "drop.read"; scope: "caller" | "explicit" }
  | { kind: "drop.diff.propose" }
  | { kind: "stream.create" }
  | { kind: "null.call" }
  | { kind: "policy.evaluate" };

export interface RemoteNullplugManifest {
  id: string;
  version: string;
  endpoint: string;
  inputSchema: Record<string, JsonValue>;
  outputSchema: Record<string, JsonValue>;
  permissions: NullplugPermission[];
  signature?: string;
  author?: string;
  repository?: string;
  description?: string;
}

export interface RemoteNullplugRegistryRecord {
  version: 1;
  manifest: RemoteNullplugManifest;
  status: "active" | "disabled";
  createdAt: number;
  updatedAt: number;
  registeredBy?: string;
}

export interface NullplugRegistryJsonObject {
  json(): Promise<unknown>;
}

export interface NullplugRegistryJsonStore {
  get(key: string): Promise<NullplugRegistryJsonObject | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isJsonValue = (value: unknown, depth = 0): value is JsonValue => {
  if (depth > 24) return false;
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
};

const isJsonRecord = (value: unknown): value is Record<string, JsonValue> =>
  isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry));

export const sanitizeNullplugRegistryKeyPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9._:-]/g, "_");

export const remoteNullplugManifestKey = (id: string, version: string): string =>
  `${NULLPLUG_REGISTRY_MANIFEST_KEY_PREFIX}${sanitizeNullplugRegistryKeyPart(
    id,
  )}/${sanitizeNullplugRegistryKeyPart(version)}.json`;

export const remoteNullplugLatestKey = (id: string): string =>
  `${NULLPLUG_REGISTRY_LATEST_KEY_PREFIX}${sanitizeNullplugRegistryKeyPart(id)}.json`;

const isNullplugPermission = (value: unknown): value is NullplugPermission => {
  if (!isRecord(value)) return false;
  if (value.kind === "network") return isStringArray(value.hosts);
  if (value.kind === "drop.read") {
    return value.scope === "caller" || value.scope === "explicit";
  }
  return (
    value.kind === "drop.diff.propose" ||
    value.kind === "stream.create" ||
    value.kind === "null.call" ||
    value.kind === "policy.evaluate"
  );
};

export const isRemoteNullplugManifest = (
  value: unknown,
): value is RemoteNullplugManifest => {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isString(value.version) || !isString(value.endpoint)) {
    return false;
  }
  if (!isJsonRecord(value.inputSchema) || !isJsonRecord(value.outputSchema)) {
    return false;
  }
  if (
    !Array.isArray(value.permissions) ||
    !value.permissions.every(isNullplugPermission)
  ) {
    return false;
  }
  if (value.signature !== undefined && !isString(value.signature)) return false;
  if (value.author !== undefined && !isString(value.author)) return false;
  if (value.repository !== undefined && !isString(value.repository)) return false;
  if (value.description !== undefined && !isString(value.description)) return false;
  return true;
};

export const isRemoteNullplugRegistryRecord = (
  value: unknown,
): value is RemoteNullplugRegistryRecord => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isRemoteNullplugManifest(value.manifest)) return false;
  if (value.status !== "active" && value.status !== "disabled") return false;
  if (!isNumber(value.createdAt) || !isNumber(value.updatedAt)) return false;
  if (value.registeredBy !== undefined && !isString(value.registeredBy)) {
    return false;
  }
  return true;
};

const endpointHost = (endpoint: string): string | null => {
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

export const isRemoteNullplugManifestAllowed = (
  manifest: RemoteNullplugManifest,
  allowedHosts: readonly string[],
): boolean => {
  const host = endpointHost(manifest.endpoint);
  if (!host || !allowedHosts.includes(host)) return false;

  return manifest.permissions.every((permission) => {
    if (permission.kind !== "network") return true;
    return permission.hosts.every((permissionHost) =>
      allowedHosts.includes(permissionHost.toLowerCase()),
    );
  });
};

export const serializeRemoteNullplugManifestForSignature = (
  manifest: RemoteNullplugManifest,
): string => {
  const { signature: _signature, ...signable } = manifest;
  return serializeCanonicalJson(signable);
};

export const readRemoteNullplugManifest = async (
  store: NullplugRegistryJsonStore,
  id: string,
  version: string,
): Promise<RemoteNullplugRegistryRecord | null> => {
  const object = await store.get(remoteNullplugManifestKey(id, version));
  if (!object) return null;
  try {
    const parsed = await object.json();
    return isRemoteNullplugRegistryRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeRemoteNullplugManifest = async (
  store: NullplugRegistryJsonStore,
  record: RemoteNullplugRegistryRecord,
  allowedHosts: readonly string[],
): Promise<void> => {
  if (!isRemoteNullplugRegistryRecord(record)) {
    throw new Error("Invalid remote nullplug registry record.");
  }
  if (!isRemoteNullplugManifestAllowed(record.manifest, allowedHosts)) {
    throw new Error("Remote nullplug manifest is not allowed by registry host policy.");
  }

  const body = JSON.stringify(record);
  await store.put(
    remoteNullplugManifestKey(record.manifest.id, record.manifest.version),
    body,
    { httpMetadata: { contentType: "application/json" } },
  );
  await store.put(remoteNullplugLatestKey(record.manifest.id), body, {
    httpMetadata: { contentType: "application/json" },
  });
};
