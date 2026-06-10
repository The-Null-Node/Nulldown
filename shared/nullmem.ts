import { z } from "zod";
import type { JsonValue } from "./nullplug/types";
import type { RemoteNullplugRegistryRecord } from "./nullplug/registry";

export const NULLMEM_RECORD_VERSION = 1 as const;

/** Stable source reference used by NullMem records to cite primary evidence. */
export type NullMemSourceRef =
  | { kind: "drop"; rootDropId: string }
  | { kind: "branch"; rootDropId: string; branchId: string }
  | {
      kind: "snapshot";
      rootDropId: string;
      branchId: string;
      snapshotId: number;
    }
  | {
      kind: "diff";
      rootDropId: string;
      branchId: string;
      eventId: string;
      seq?: number;
    }
  | {
      kind: "node";
      rootDropId: string;
      branchId: string;
      resolverId: string;
      nodeId: string;
    }
  | {
      kind: "heap";
      rootDropId: string;
      branchId: string;
      resolverId: string;
      snapshotId: number;
    }
  | { kind: "nullplug"; pluginId: string; version?: string }
  | { kind: "tool"; toolId: string }
  | { kind: "theme"; themeId: string }
  | { kind: "mcp"; toolId: string };

/** Example attached to a capability to help agents decide how to use it. */
export interface NullMemCapabilityExample {
  title?: string;
  input?: JsonValue;
  output?: JsonValue;
  summary?: string;
}

/** Queryable capability memory for nullplugs, tools, themes, and future MCP tools. */
export interface NullMemCapabilityRecord {
  version: typeof NULLMEM_RECORD_VERSION;
  kind: "capability";
  recordId: string;
  capabilityKind: "nullplug" | "tool" | "theme" | "mcp";
  capabilityId: string;
  capabilityVersion?: string;
  title?: string;
  description: string;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  permissions?: JsonValue[];
  whenToUse?: string[];
  whenNotToUse?: string[];
  examples?: NullMemCapabilityExample[];
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, JsonValue>;
}

/** One step in a reusable procedure or reasoning trace. */
export interface NullMemProcedureStep {
  index: number;
  kind:
    | "tool.call"
    | "nullplug.call"
    | "mcp.call"
    | "diff.apply"
    | "query"
    | "deploy"
    | "test"
    | "note";
  name: string;
  argsSummary?: string;
  resultSummary?: string;
  status: "success" | "failed" | "skipped" | "partial";
  refs?: NullMemSourceRef[];
}

/** Reusable procedure memory that records how a goal was achieved. */
export interface NullMemProcedureRecord {
  version: typeof NULLMEM_RECORD_VERSION;
  kind: "procedure";
  recordId: string;
  rootDropId?: string;
  branchId?: string;
  goal: string;
  summary: string;
  steps: NullMemProcedureStep[];
  outcome: "success" | "partial" | "failed";
  reusableAs?: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, JsonValue>;
}

/** Branch-scoped memory annotation that does not mutate primary markdown. */
export interface NullMemFactRecord {
  version: typeof NULLMEM_RECORD_VERSION;
  kind: "fact";
  recordId: string;
  rootDropId?: string;
  branchId?: string;
  targetKind?: NullMemSourceRef["kind"] | "custom";
  targetId?: string;
  title?: string;
  text: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, JsonValue>;
}

/** Any persisted or built-in NullMem record. */
export type NullMemRecord =
  | NullMemCapabilityRecord
  | NullMemProcedureRecord
  | NullMemFactRecord;

/** Query shape for retrieving mixed NullMem capsules. */
export interface NullMemQuery {
  q?: string;
  kind?: NullMemRecord["kind"];
  labels?: string[];
  limit?: number;
}

/** Compact result returned to agents before expanding full source refs. */
export interface NullMemCapsule {
  recordId: string;
  kind: NullMemRecord["kind"];
  title?: string;
  summary: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  record: NullMemRecord;
}

const finiteNumberSchema = z.number().finite();

/** Canonical JSON value schema used by NullMem metadata and capability schemas. */
export const NullMemJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finiteNumberSchema,
    z.string(),
    z.array(NullMemJsonValueSchema),
    z.record(z.string(), NullMemJsonValueSchema),
  ]),
);

/** Canonical JSON object schema used by NullMem records. */
export const NullMemJsonRecordSchema = z.record(
  z.string(),
  NullMemJsonValueSchema,
);

/** Canonical schema for source references attached to NullMem records. */
export const NullMemSourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drop"), rootDropId: z.string() }),
  z.object({
    kind: z.literal("branch"),
    rootDropId: z.string(),
    branchId: z.string(),
  }),
  z.object({
    kind: z.literal("snapshot"),
    rootDropId: z.string(),
    branchId: z.string(),
    snapshotId: finiteNumberSchema,
  }),
  z.object({
    kind: z.literal("diff"),
    rootDropId: z.string(),
    branchId: z.string(),
    eventId: z.string(),
    seq: finiteNumberSchema.optional(),
  }),
  z.object({
    kind: z.literal("node"),
    rootDropId: z.string(),
    branchId: z.string(),
    resolverId: z.string(),
    nodeId: z.string(),
  }),
  z.object({
    kind: z.literal("heap"),
    rootDropId: z.string(),
    branchId: z.string(),
    resolverId: z.string(),
    snapshotId: finiteNumberSchema,
  }),
  z.object({
    kind: z.literal("nullplug"),
    pluginId: z.string(),
    version: z.string().optional(),
  }),
  z.object({ kind: z.literal("tool"), toolId: z.string() }),
  z.object({ kind: z.literal("theme"), themeId: z.string() }),
  z.object({ kind: z.literal("mcp"), toolId: z.string() }),
]) satisfies z.ZodType<NullMemSourceRef>;

const NullMemSourceRefsSchema = z.array(NullMemSourceRefSchema).optional();

/** Returns true when a value is a valid NullMem source reference. */
export const isNullMemSourceRef = (
  value: unknown,
): value is NullMemSourceRef => NullMemSourceRefSchema.safeParse(value).success;

/** Canonical schema for capability usage examples. */
export const NullMemCapabilityExampleSchema = z.object({
  title: z.string().optional(),
  input: NullMemJsonValueSchema.optional(),
  output: NullMemJsonValueSchema.optional(),
  summary: z.string().optional(),
}) satisfies z.ZodType<NullMemCapabilityExample>;

/** Canonical schema for capability memory records. */
export const NullMemCapabilityRecordSchema = z.object({
  version: z.literal(NULLMEM_RECORD_VERSION),
  kind: z.literal("capability"),
  recordId: z.string(),
  capabilityKind: z.enum(["nullplug", "tool", "theme", "mcp"]),
  capabilityId: z.string(),
  capabilityVersion: z.string().optional(),
  title: z.string().optional(),
  description: z.string(),
  inputSchema: NullMemJsonValueSchema.optional(),
  outputSchema: NullMemJsonValueSchema.optional(),
  permissions: z.array(NullMemJsonValueSchema).optional(),
  whenToUse: z.array(z.string()).optional(),
  whenNotToUse: z.array(z.string()).optional(),
  examples: z.array(NullMemCapabilityExampleSchema).optional(),
  labels: z.array(z.string()).optional(),
  priority: finiteNumberSchema.optional(),
  confidence: finiteNumberSchema.optional(),
  sourceRefs: NullMemSourceRefsSchema,
  createdAt: finiteNumberSchema,
  updatedAt: finiteNumberSchema.optional(),
  metadata: NullMemJsonRecordSchema.optional(),
}) satisfies z.ZodType<NullMemCapabilityRecord>;

/** Returns true when a value is a valid NullMem capability record. */
export const isNullMemCapabilityRecord = (
  value: unknown,
): value is NullMemCapabilityRecord =>
  NullMemCapabilityRecordSchema.safeParse(value).success;

/** Canonical schema for reusable procedure steps. */
export const NullMemProcedureStepSchema = z.object({
  index: finiteNumberSchema,
  kind: z.enum([
    "tool.call",
    "nullplug.call",
    "mcp.call",
    "diff.apply",
    "query",
    "deploy",
    "test",
    "note",
  ]),
  name: z.string(),
  argsSummary: z.string().optional(),
  resultSummary: z.string().optional(),
  status: z.enum(["success", "failed", "skipped", "partial"]),
  refs: NullMemSourceRefsSchema,
}) satisfies z.ZodType<NullMemProcedureStep>;

/** Canonical schema for reusable procedure memory records. */
export const NullMemProcedureRecordSchema = z.object({
  version: z.literal(NULLMEM_RECORD_VERSION),
  kind: z.literal("procedure"),
  recordId: z.string(),
  rootDropId: z.string().optional(),
  branchId: z.string().optional(),
  goal: z.string(),
  summary: z.string(),
  steps: z.array(NullMemProcedureStepSchema),
  outcome: z.enum(["success", "partial", "failed"]),
  reusableAs: z.string().optional(),
  labels: z.array(z.string()).optional(),
  priority: finiteNumberSchema.optional(),
  confidence: finiteNumberSchema.optional(),
  sourceRefs: NullMemSourceRefsSchema,
  createdAt: finiteNumberSchema,
  updatedAt: finiteNumberSchema.optional(),
  metadata: NullMemJsonRecordSchema.optional(),
}) satisfies z.ZodType<NullMemProcedureRecord>;

/** Returns true when a value is a valid NullMem procedure record. */
export const isNullMemProcedureRecord = (
  value: unknown,
): value is NullMemProcedureRecord =>
  NullMemProcedureRecordSchema.safeParse(value).success;

/** Canonical schema for branch-scoped fact memory records. */
export const NullMemFactRecordSchema = z.object({
  version: z.literal(NULLMEM_RECORD_VERSION),
  kind: z.literal("fact"),
  recordId: z.string(),
  rootDropId: z.string().optional(),
  branchId: z.string().optional(),
  targetKind: z
    .enum([
      "drop",
      "branch",
      "snapshot",
      "diff",
      "node",
      "heap",
      "nullplug",
      "tool",
      "theme",
      "mcp",
      "custom",
    ])
    .optional(),
  targetId: z.string().optional(),
  title: z.string().optional(),
  text: z.string(),
  labels: z.array(z.string()).optional(),
  priority: finiteNumberSchema.optional(),
  confidence: finiteNumberSchema.optional(),
  sourceRefs: NullMemSourceRefsSchema,
  createdAt: finiteNumberSchema,
  updatedAt: finiteNumberSchema.optional(),
  metadata: NullMemJsonRecordSchema.optional(),
}) satisfies z.ZodType<NullMemFactRecord>;

/** Returns true when a value is a valid NullMem fact record. */
export const isNullMemFactRecord = (
  value: unknown,
): value is NullMemFactRecord =>
  NullMemFactRecordSchema.safeParse(value).success;

/** Canonical schema for any persisted or built-in NullMem record. */
export const NullMemRecordSchema = z.discriminatedUnion("kind", [
  NullMemCapabilityRecordSchema,
  NullMemProcedureRecordSchema,
  NullMemFactRecordSchema,
]) satisfies z.ZodType<NullMemRecord>;

/** Canonical schema for querying NullMem capsules. */
export const NullMemQuerySchema = z.object({
  q: z.string().optional(),
  kind: z.enum(["capability", "procedure", "fact"]).optional(),
  labels: z.array(z.string()).optional(),
  limit: finiteNumberSchema.optional(),
}) satisfies z.ZodType<NullMemQuery>;

/** Returns true when a value is any valid NullMem record. */
export const isNullMemRecord = (value: unknown): value is NullMemRecord =>
  NullMemRecordSchema.safeParse(value).success;

/** Builds searchable text for a NullMem record without copying full source content. */
export const nullMemRecordText = (record: NullMemRecord): string => {
  if (record.kind === "capability") {
    return [
      record.title,
      record.capabilityKind,
      record.capabilityId,
      record.description,
      ...(record.whenToUse ?? []),
      ...(record.whenNotToUse ?? []),
      ...(record.examples ?? []).map((example) =>
        [example.title, example.summary].filter(Boolean).join(" "),
      ),
      ...(record.labels ?? []),
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (record.kind === "procedure") {
    return [
      record.goal,
      record.summary,
      record.reusableAs,
      ...record.steps.map((step) =>
        [
          step.kind,
          step.name,
          step.argsSummary,
          step.resultSummary,
          step.status,
        ]
          .filter(Boolean)
          .join(" "),
      ),
      ...(record.labels ?? []),
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    record.title,
    record.text,
    record.targetKind,
    record.targetId,
    ...(record.labels ?? []),
  ]
    .filter(Boolean)
    .join(" ");
};

/** Converts a full NullMem record into the compact capsule returned by queries. */
export const nullMemRecordToCapsule = (
  record: NullMemRecord,
): NullMemCapsule => {
  if (record.kind === "capability") {
    return {
      recordId: record.recordId,
      kind: record.kind,
      title: record.title ?? record.capabilityId,
      summary: record.description,
      labels: record.labels,
      priority: record.priority,
      confidence: record.confidence,
      sourceRefs: record.sourceRefs,
      record,
    };
  }
  if (record.kind === "procedure") {
    return {
      recordId: record.recordId,
      kind: record.kind,
      title: record.goal,
      summary: record.summary,
      labels: record.labels,
      priority: record.priority,
      confidence: record.confidence,
      sourceRefs: record.sourceRefs,
      record,
    };
  }
  return {
    recordId: record.recordId,
    kind: record.kind,
    title: record.title,
    summary: record.text,
    labels: record.labels,
    priority: record.priority,
    confidence: record.confidence,
    sourceRefs: record.sourceRefs,
    record,
  };
};

const jsonRecordWithDefinedValues = (
  entries: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> =>
  Object.fromEntries(
    Object.entries(entries).filter(
      (entry): entry is [string, JsonValue] => entry[1] !== undefined,
    ),
  );

const permissionLabel = (kind: string): string =>
  `permission:${kind.replace(/[^a-z0-9._:-]/gi, "-").toLowerCase()}`;

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

/** Returns built-in capability records available before catalog ingestion runs. */
export const createBuiltInNullMemCapabilities = (
  createdAt = 0,
): NullMemCapabilityRecord[] => [
  {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: "capability:nullplug:nd",
    capabilityKind: "nullplug",
    capabilityId: "nd",
    title: "Built-in nd nullplug",
    description:
      "Resolves a Nulldown drop id into a compact rendered card with title, excerpt, and link.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    outputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
    },
    whenToUse: [
      "Embed or preview a Nulldown drop from markdown or a nullplug call.",
    ],
    whenNotToUse: [
      "Do not use for arbitrary remote code execution or long-running agent tasks.",
    ],
    labels: ["nullplug", "drop-preview", "capability-memory"],
    sourceRefs: [{ kind: "nullplug", pluginId: "nd" }],
    createdAt,
  },
  {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: "capability:tool:nd-branch-memory-query",
    capabilityKind: "tool",
    capabilityId: "nd branch memory query",
    title: "Query branch memory",
    description:
      "Retrieves mixed NullMem capsules for a branch, including facts, procedures, and capabilities.",
    whenToUse: [
      "Find prior procedures, capability guidance, or agent memory before acting.",
    ],
    whenNotToUse: [
      "Do not use as proof of primary branch replay; query branch content or diffs for authoritative text.",
    ],
    labels: ["tool", "nullmem", "query", "capability-memory"],
    sourceRefs: [{ kind: "tool", toolId: "nd branch memory query" }],
    createdAt,
  },
  {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: "capability:theme:system",
    capabilityKind: "theme",
    capabilityId: "system",
    title: "System theme",
    description:
      "Uses the current operating-system light or dark mode as the default Nulldown visual theme.",
    whenToUse: [
      "Use for neutral documents or when no explicit visual mood is needed.",
    ],
    labels: ["theme", "system", "capability-memory"],
    sourceRefs: [{ kind: "theme", themeId: "system" }],
    createdAt,
  },
];
