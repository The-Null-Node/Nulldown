import type { RemoteNullplugRegistryRecord } from "../../nullplug/registry";
import type { JsonValue } from "../../nullplug/types";
import { NULLMEM_RECORD_VERSION, type NullMemCapabilityRecord } from "../types";
import { jsonRecordWithDefinedValues, permissionLabel } from "./common";

/** Converts a registered remote nullplug manifest into queryable capability memory. */
export const createRemoteNullplugCapabilityRecord = (
  record: RemoteNullplugRegistryRecord,
): NullMemCapabilityRecord => {
  const { manifest } = record;
  const description =
    manifest.description ??
    `Remote nullplug ${manifest.id} registered at ${manifest.endpoint}.`;
  const permissionLabels = manifest.permissions.map((permission) =>
    permissionLabel(permission.kind),
  );

  return {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: `capability:nullplug:${manifest.id}:${manifest.version}`,
    capabilityKind: "nullplug",
    capabilityId: manifest.id,
    capabilityVersion: manifest.version,
    title: `Remote nullplug: ${manifest.id}`,
    description,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
    permissions: manifest.permissions.map(
      (permission) => permission as unknown as JsonValue,
    ),
    whenToUse: [
      `Use when an agent workflow needs the registered remote ${manifest.id} nullplug.`,
      "Use after checking permissions, host policy, and the caller's branch context.",
    ],
    whenNotToUse: [
      "Do not use for primary branch replay or as proof of source content.",
      "Do not call if the endpoint host or requested permissions are outside policy.",
    ],
    labels: [
      "nullplug",
      "remote-nullplug",
      "registered-manifest",
      "capability-memory",
      ...permissionLabels,
    ],
    priority: 1,
    confidence: 0.9,
    sourceRefs: [
      { kind: "nullplug", pluginId: manifest.id, version: manifest.version },
    ],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    metadata: jsonRecordWithDefinedValues({
      endpoint: manifest.endpoint,
      author: manifest.author,
      repository: manifest.repository,
      registryStatus: record.status,
      registeredBy: record.registeredBy,
    }),
  };
};
