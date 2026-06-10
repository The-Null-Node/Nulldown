import { z } from "zod";
import type { JsonValue } from "./types";
import type {
  NullplugPermission,
  RemoteNullplugManifest,
  RemoteNullplugRegistryRecord,
} from "./registry";

const finiteNumberSchema = z.number().finite();

export const NullplugRegistryJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finiteNumberSchema,
    z.string(),
    z.array(NullplugRegistryJsonValueSchema),
    z.record(z.string(), NullplugRegistryJsonValueSchema),
  ]),
);

export const NullplugRegistryJsonRecordSchema = z.record(
  z.string(),
  NullplugRegistryJsonValueSchema,
);

export const NullplugPermissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("network"), hosts: z.array(z.string()) }),
  z.object({
    kind: z.literal("drop.read"),
    scope: z.enum(["caller", "explicit"]),
  }),
  z.object({ kind: z.literal("drop.diff.propose") }),
  z.object({ kind: z.literal("stream.create") }),
  z.object({ kind: z.literal("null.call") }),
  z.object({ kind: z.literal("policy.evaluate") }),
]) satisfies z.ZodType<NullplugPermission>;

export const RemoteNullplugManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  endpoint: z.string(),
  inputSchema: NullplugRegistryJsonRecordSchema,
  outputSchema: NullplugRegistryJsonRecordSchema,
  permissions: z.array(NullplugPermissionSchema),
  signature: z.string().optional(),
  author: z.string().optional(),
  repository: z.string().optional(),
  description: z.string().optional(),
}) satisfies z.ZodType<RemoteNullplugManifest>;

export const RemoteNullplugRegistryRecordSchema = z.object({
  version: z.literal(1),
  manifest: RemoteNullplugManifestSchema,
  status: z.enum(["active", "disabled"]),
  createdAt: finiteNumberSchema,
  updatedAt: finiteNumberSchema,
  registeredBy: z.string().optional(),
}) satisfies z.ZodType<RemoteNullplugRegistryRecord>;
