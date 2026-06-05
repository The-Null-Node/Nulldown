import type { JsonValue } from "./nullplug/types";

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
  if (Array.isArray(value))
    return value.every((entry) => isJsonValue(entry, depth + 1));
  if (isRecord(value))
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  return false;
};

const isJsonRecord = (value: unknown): value is Record<string, JsonValue> =>
  isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry));

/** Returns true when a value is a valid NullMem source reference. */
export const isNullMemSourceRef = (
  value: unknown,
): value is NullMemSourceRef => {
  if (!isRecord(value) || !isString(value.kind)) return false;
  if (value.kind === "drop") return isString(value.rootDropId);
  if (value.kind === "branch")
    return isString(value.rootDropId) && isString(value.branchId);
  if (value.kind === "snapshot") {
    return (
      isString(value.rootDropId) &&
      isString(value.branchId) &&
      isNumber(value.snapshotId)
    );
  }
  if (value.kind === "diff") {
    return (
      isString(value.rootDropId) &&
      isString(value.branchId) &&
      isString(value.eventId) &&
      (value.seq === undefined || isNumber(value.seq))
    );
  }
  if (value.kind === "node") {
    return (
      isString(value.rootDropId) &&
      isString(value.branchId) &&
      isString(value.resolverId) &&
      isString(value.nodeId)
    );
  }
  if (value.kind === "heap") {
    return (
      isString(value.rootDropId) &&
      isString(value.branchId) &&
      isString(value.resolverId) &&
      isNumber(value.snapshotId)
    );
  }
  if (value.kind === "nullplug") {
    return (
      isString(value.pluginId) &&
      (value.version === undefined || isString(value.version))
    );
  }
  if (value.kind === "tool" || value.kind === "mcp")
    return isString(value.toolId);
  if (value.kind === "theme") return isString(value.themeId);
  return false;
};

const isSourceRefs = (value: unknown): value is NullMemSourceRef[] =>
  value === undefined ||
  (Array.isArray(value) && value.every(isNullMemSourceRef));

const isCapabilityExample = (
  value: unknown,
): value is NullMemCapabilityExample =>
  isRecord(value) &&
  (value.title === undefined || isString(value.title)) &&
  (value.input === undefined || isJsonValue(value.input)) &&
  (value.output === undefined || isJsonValue(value.output)) &&
  (value.summary === undefined || isString(value.summary));

/** Returns true when a value is a valid NullMem capability record. */
export const isNullMemCapabilityRecord = (
  value: unknown,
): value is NullMemCapabilityRecord => {
  if (!isRecord(value)) return false;
  if (value.version !== NULLMEM_RECORD_VERSION || value.kind !== "capability")
    return false;
  if (!isString(value.recordId) || !isString(value.capabilityId)) return false;
  if (
    !["nullplug", "tool", "theme", "mcp"].includes(String(value.capabilityKind))
  )
    return false;
  if (!isString(value.description) || !isNumber(value.createdAt)) return false;
  if (
    value.capabilityVersion !== undefined &&
    !isString(value.capabilityVersion)
  )
    return false;
  if (value.title !== undefined && !isString(value.title)) return false;
  if (value.inputSchema !== undefined && !isJsonValue(value.inputSchema))
    return false;
  if (value.outputSchema !== undefined && !isJsonValue(value.outputSchema))
    return false;
  if (
    value.permissions !== undefined &&
    (!Array.isArray(value.permissions) || !value.permissions.every(isJsonValue))
  )
    return false;
  if (value.whenToUse !== undefined && !isStringArray(value.whenToUse))
    return false;
  if (value.whenNotToUse !== undefined && !isStringArray(value.whenNotToUse))
    return false;
  if (
    value.examples !== undefined &&
    (!Array.isArray(value.examples) ||
      !value.examples.every(isCapabilityExample))
  )
    return false;
  if (value.labels !== undefined && !isStringArray(value.labels)) return false;
  if (value.priority !== undefined && !isNumber(value.priority)) return false;
  if (value.confidence !== undefined && !isNumber(value.confidence))
    return false;
  if (!isSourceRefs(value.sourceRefs)) return false;
  if (value.updatedAt !== undefined && !isNumber(value.updatedAt)) return false;
  if (value.metadata !== undefined && !isJsonRecord(value.metadata))
    return false;
  return true;
};

const isProcedureStep = (value: unknown): value is NullMemProcedureStep => {
  if (!isRecord(value)) return false;
  if (!isNumber(value.index) || !isString(value.kind) || !isString(value.name))
    return false;
  if (
    ![
      "tool.call",
      "nullplug.call",
      "mcp.call",
      "diff.apply",
      "query",
      "deploy",
      "test",
      "note",
    ].includes(value.kind)
  )
    return false;
  if (
    !["success", "failed", "skipped", "partial"].includes(String(value.status))
  )
    return false;
  if (value.argsSummary !== undefined && !isString(value.argsSummary))
    return false;
  if (value.resultSummary !== undefined && !isString(value.resultSummary))
    return false;
  return isSourceRefs(value.refs);
};

/** Returns true when a value is a valid NullMem procedure record. */
export const isNullMemProcedureRecord = (
  value: unknown,
): value is NullMemProcedureRecord => {
  if (!isRecord(value)) return false;
  if (value.version !== NULLMEM_RECORD_VERSION || value.kind !== "procedure")
    return false;
  if (
    !isString(value.recordId) ||
    !isString(value.goal) ||
    !isString(value.summary)
  )
    return false;
  if (!Array.isArray(value.steps) || !value.steps.every(isProcedureStep))
    return false;
  if (!["success", "partial", "failed"].includes(String(value.outcome)))
    return false;
  if (value.rootDropId !== undefined && !isString(value.rootDropId))
    return false;
  if (value.branchId !== undefined && !isString(value.branchId)) return false;
  if (value.reusableAs !== undefined && !isString(value.reusableAs))
    return false;
  if (value.labels !== undefined && !isStringArray(value.labels)) return false;
  if (value.priority !== undefined && !isNumber(value.priority)) return false;
  if (value.confidence !== undefined && !isNumber(value.confidence))
    return false;
  if (!isSourceRefs(value.sourceRefs)) return false;
  if (!isNumber(value.createdAt)) return false;
  if (value.updatedAt !== undefined && !isNumber(value.updatedAt)) return false;
  if (value.metadata !== undefined && !isJsonRecord(value.metadata))
    return false;
  return true;
};

/** Returns true when a value is a valid NullMem fact record. */
export const isNullMemFactRecord = (
  value: unknown,
): value is NullMemFactRecord => {
  if (!isRecord(value)) return false;
  if (value.version !== NULLMEM_RECORD_VERSION || value.kind !== "fact")
    return false;
  if (
    !isString(value.recordId) ||
    !isString(value.text) ||
    !isNumber(value.createdAt)
  )
    return false;
  if (value.rootDropId !== undefined && !isString(value.rootDropId))
    return false;
  if (value.branchId !== undefined && !isString(value.branchId)) return false;
  if (value.targetKind !== undefined && !isString(value.targetKind))
    return false;
  if (value.targetId !== undefined && !isString(value.targetId)) return false;
  if (value.title !== undefined && !isString(value.title)) return false;
  if (value.labels !== undefined && !isStringArray(value.labels)) return false;
  if (value.priority !== undefined && !isNumber(value.priority)) return false;
  if (value.confidence !== undefined && !isNumber(value.confidence))
    return false;
  if (!isSourceRefs(value.sourceRefs)) return false;
  if (value.updatedAt !== undefined && !isNumber(value.updatedAt)) return false;
  if (value.metadata !== undefined && !isJsonRecord(value.metadata))
    return false;
  return true;
};

/** Returns true when a value is any valid NullMem record. */
export const isNullMemRecord = (value: unknown): value is NullMemRecord =>
  isNullMemCapabilityRecord(value) ||
  isNullMemProcedureRecord(value) ||
  isNullMemFactRecord(value);

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
