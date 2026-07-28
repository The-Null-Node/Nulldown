import { NULLMEM_RECORD_VERSION, type NullMemCapabilityRecord } from "../types";

/** Returns built-in CLI operational capability records for repeatable agent workflows. */
export const createCliOperationalCapabilityRecords = (
  createdAt = 0,
): NullMemCapabilityRecord[] => [
  {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: "capability:tool:nd-create-seed",
    capabilityKind: "tool",
    capabilityId: "nd create --seed",
    title: "Create semantic seed drop",
    description:
      "Creates a tiny hosted Nulldown seed for branch-diff authoring and can resolve the authenticated branch.",
    whenToUse: [
      "Start a new hosted plan, checklist, strategy, or graph without creating repo-local markdown.",
      "Use before appending focused sections with atomic branch diffs.",
    ],
    whenNotToUse: [
      "Do not use as a full document rewrite path for existing hosted plans.",
    ],
    labels: [
      "tool",
      "cli",
      "nd-cli",
      "semantic-seed",
      "operational-procedure",
      "capability-memory",
    ],
    sourceRefs: [{ kind: "tool", toolId: "nd create --seed" }],
    createdAt,
  },
  {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: "capability:tool:nd-diff-apply",
    capabilityKind: "tool",
    capabilityId: "nd diff apply",
    title: "Apply atomic branch diff",
    description:
      "Applies a small insert or delete operation to a hosted branch with semantic diff metadata.",
    whenToUse: [
      "Update hosted plans, checklists, strategy docs, or graph nodes without full-body rewrites.",
      "Record focused state changes with metadata that later branch queries can retrieve.",
    ],
    whenNotToUse: [
      "Do not use offset edits before resolving current branch content or source ranges.",
      "Do not omit metadata for meaningful planning or memory changes.",
    ],
    labels: [
      "tool",
      "cli",
      "nd-cli",
      "branch-diff",
      "atomic-diff",
      "operational-procedure",
      "capability-memory",
    ],
    sourceRefs: [{ kind: "tool", toolId: "nd diff apply" }],
    createdAt,
  },
  {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: "capability:tool:nd-branch-query",
    capabilityKind: "tool",
    capabilityId: "nd branch query",
    title: "Query branch semantic heap",
    description:
      "Retrieves the smallest relevant resolved branch nodes before reading full hosted content.",
    whenToUse: [
      "Find the active plan slice, source range, checklist item, or verification block before editing.",
      "Verify that hosted branch diffs and strategy updates are semantically retrievable.",
    ],
    whenNotToUse: [
      "Do not use as proof when exact raw text or byte offsets are required; read branch content then.",
    ],
    labels: [
      "tool",
      "cli",
      "nd-cli",
      "semantic-query",
      "branch-query",
      "operational-procedure",
      "capability-memory",
    ],
    sourceRefs: [{ kind: "tool", toolId: "nd branch query" }],
    createdAt,
  },
  {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: "capability:tool:nd-branch-memory-procedure",
    capabilityKind: "tool",
    capabilityId: "nd branch memory procedure",
    title: "Record reusable procedure memory",
    description:
      "Stores a branch-scoped procedure memory record for workflows that future agents should repeat.",
    whenToUse: [
      "Capture successful repeated workflows with source refs after verification.",
      "Record operational playbooks such as deploy, smoke, query, or review sequences.",
    ],
    whenNotToUse: [
      "Do not use procedure memory as a substitute for authoritative branch document changes.",
    ],
    labels: [
      "tool",
      "cli",
      "nd-cli",
      "nullmem",
      "procedure-memory",
      "operational-procedure",
      "capability-memory",
    ],
    sourceRefs: [{ kind: "tool", toolId: "nd branch memory procedure" }],
    createdAt,
  },
  {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: "capability:tool:nd-serve",
    capabilityKind: "tool",
    capabilityId: "nd serve",
    title: "Run local Nulldown server",
    description:
      "Starts the packageable Bun-backed local Nulldown server with filesystem blobs and optional SQLite metadata.",
    whenToUse: [
      "Run local end-to-end smoke tests for create, diff, branch content, and branch query behavior.",
      "Validate portable backend behavior outside Cloudflare before deployment.",
    ],
    whenNotToUse: [
      "Do not use as proof of Cloudflare binding behavior; run Pages or production smoke for adapter-specific checks.",
    ],
    labels: [
      "tool",
      "cli",
      "nd-cli",
      "local-server",
      "portable-backend",
      "operational-procedure",
      "capability-memory",
    ],
    sourceRefs: [{ kind: "tool", toolId: "nd serve" }],
    createdAt,
  },
];

interface BuiltInMcpCapabilityDefinition {
  toolName: string;
  title: string;
  description: string;
  labels: string[];
  whenToUse: string[];
  whenNotToUse?: string[];
}

const builtInMcpCapabilityDefinitions: BuiltInMcpCapabilityDefinition[] = [
  {
    toolName: "strategy_search",
    title: "Search Nulldown Strategies",
    description:
      "Searches public Nulldown strategy and documentation drops through the Nulldown MCP server.",
    labels: ["strategy", "search", "query"],
    whenToUse: [
      "Find hosted strategy or documentation drops before planning local architecture work.",
    ],
  },
  {
    toolName: "strategy_get",
    title: "Get Nulldown Strategy",
    description:
      "Fetches a Nulldown strategy or documentation drop by canonical or short id through MCP.",
    labels: ["strategy", "drop-read"],
    whenToUse: [
      "Expand a known strategy or documentation drop after search has found the right id.",
    ],
  },
  {
    toolName: "drop_get",
    title: "Get Drop",
    description:
      "Fetches a Nulldown drop by canonical or short id through the Nulldown MCP server.",
    labels: ["drop", "drop-read"],
    whenToUse: [
      "Read a known drop when branch-specific state is not required.",
    ],
  },
  {
    toolName: "drop_create",
    title: "Create Drop",
    description:
      "Creates a plaintext Nulldown drop through MCP using the configured Nulldown client.",
    labels: ["drop", "drop-write", "mutation"],
    whenToUse: [
      "Create a new hosted strategy, evidence, or graph seed from an MCP client.",
    ],
    whenNotToUse: [
      "Do not use to update existing branch plans when an atomic branch diff is the smaller operation.",
    ],
  },
  {
    toolName: "branch_resolve",
    title: "Resolve Branch",
    description:
      "Resolves or creates the current actor branch for a root drop through MCP.",
    labels: ["branch", "auth", "resolve"],
    whenToUse: [
      "Establish the authenticated branch id before branch content, query, memory, or diff operations.",
    ],
  },
  {
    toolName: "branch_content",
    title: "Get Branch Content",
    description:
      "Fetches exact materialized branch content through the Nulldown MCP server.",
    labels: ["branch", "branch-content", "drop-read"],
    whenToUse: [
      "Read exact text or offsets after semantic branch query is too coarse.",
    ],
  },
  {
    toolName: "branch_query",
    title: "Query Branch Heap",
    description:
      "Queries a branch resolved heap through MCP with optional filters for snapshots, resolvers, kinds, and diff ranges.",
    labels: ["branch", "branch-query", "semantic-query", "query"],
    whenToUse: [
      "Retrieve the smallest relevant semantic block before reading full branch content.",
      "Verify that hosted plan or strategy diffs are retrievable.",
    ],
  },
  {
    toolName: "diff_apply",
    title: "Apply Branch Diff",
    description:
      "Posts one atomic branch diff event through MCP with server-side diff credential handling.",
    labels: ["diff", "branch-diff", "atomic-diff", "mutation"],
    whenToUse: [
      "Apply focused branch edits from an MCP client while preserving diff metadata.",
    ],
    whenNotToUse: [
      "Do not use for whole-document rewrites when a smaller insert or delete is available.",
    ],
  },
  {
    toolName: "memory_query",
    title: "Query NullMem",
    description:
      "Queries branch-scoped NullMem facts, procedures, and capabilities through MCP.",
    labels: ["nullmem", "memory-query", "query"],
    whenToUse: [
      "Find prior facts, procedures, and capability guidance before choosing tools or editing branches.",
    ],
  },
  {
    toolName: "memory_fact",
    title: "Create NullMem Fact",
    description: "Creates a branch-scoped NullMem fact through MCP.",
    labels: ["nullmem", "fact-memory", "memory-write", "mutation"],
    whenToUse: [
      "Record stable knowledge, verified implementation results, or stale-memory supersession notes from an MCP client.",
    ],
  },
  {
    toolName: "memory_procedure",
    title: "Create NullMem Procedure",
    description:
      "Creates a reusable branch-scoped NullMem procedure through MCP.",
    labels: ["nullmem", "procedure-memory", "memory-write", "mutation"],
    whenToUse: [
      "Capture a repeatable workflow with ordered steps and source refs after verification.",
    ],
  },
];

const createBuiltInMcpCapabilityRecord = (
  definition: BuiltInMcpCapabilityDefinition,
  createdAt: number,
): NullMemCapabilityRecord => ({
  version: NULLMEM_RECORD_VERSION,
  kind: "capability",
  recordId: `capability:mcp:nulldown:${definition.toolName}`,
  capabilityKind: "mcp",
  capabilityId: `nulldown.${definition.toolName}`,
  title: `Nulldown MCP: ${definition.title}`,
  description: definition.description,
  whenToUse: definition.whenToUse,
  whenNotToUse: [
    ...(definition.whenNotToUse ?? []),
    "Do not treat MCP capability metadata as proof of branch content; cite returned source refs or branch text when needed.",
  ],
  labels: [
    "mcp",
    "mcp-tool",
    "mcp-catalog",
    "nulldown-mcp",
    "capability-memory",
    ...definition.labels,
  ],
  priority: 0.8,
  confidence: 0.9,
  sourceRefs: [{ kind: "mcp", toolId: `nulldown/${definition.toolName}` }],
  createdAt,
  metadata: {
    command: "nulldown-mcp",
    packageName: "@thenullnode/nulldown-mcp",
    packageExport: "@thenullnode/nulldown-mcp/server",
    sourceFile: "packages/nulldown-mcp/src/server.ts",
    toolName: definition.toolName,
  },
});

/** Returns built-in Nulldown MCP server tool capability records. */
export const createBuiltInMcpCapabilityRecords = (
  createdAt = 0,
): NullMemCapabilityRecord[] =>
  builtInMcpCapabilityDefinitions.map((definition) =>
    createBuiltInMcpCapabilityRecord(definition, createdAt),
  );

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
    recordId: "capability:nullplug:approval",
    capabilityKind: "nullplug",
    capabilityId: "approval",
    title: "Built-in approval nullplug",
    description:
      "Renders an explicit human approval form and stores the submitted decision as an immutable branch-scoped response fact.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, body: { type: "string" } },
      required: ["id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        reason: { type: "string" },
      },
    },
    whenToUse: [
      "Request and durably record a human decision without applying document mutations.",
      "Use a stable id so agents can retrieve the response with a branch runtime-ref query.",
    ],
    whenNotToUse: [
      "Do not treat rendering the form as approval; authority comes only from a stored response fact.",
      "Do not use the response to apply diffs without a separate explicit policy grant.",
    ],
    labels: ["nullplug", "approval", "human-in-the-loop", "capability-memory"],
    sourceRefs: [{ kind: "nullplug", pluginId: "approval" }],
    priority: 0.9,
    confidence: 0.95,
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
  ...createCliOperationalCapabilityRecords(createdAt),
  ...createBuiltInMcpCapabilityRecords(createdAt),
  {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: "capability:tool:nd-branch-memory-stale-check",
    capabilityKind: "tool",
    capabilityId: "nd branch memory stale-check",
    title: "Check stale branch memory",
    description:
      "Evaluates branch-scoped NullMem records for staleness against current branch snapshot heads and explicit superseding labels.",
    whenToUse: [
      "Run before trusting current-work, procedure, or capability memory for priority decisions.",
      "Detect facts that cite older snapshots, carry stale-memory labels, or have been superseded by newer records.",
    ],
    whenNotToUse: [
      "Do not use as proof of primary branch content; the check only evaluates memory metadata and cited sources.",
    ],
    labels: [
      "tool",
      "nullmem",
      "stale-memory",
      "capability-memory",
      "freshness",
    ],
    sourceRefs: [{ kind: "tool", toolId: "nd branch memory stale-check" }],
    createdAt,
  },
  {
    version: NULLMEM_RECORD_VERSION,
    kind: "capability",
    recordId: "capability:tool:nd-branch-memory-delete",
    capabilityKind: "tool",
    capabilityId: "nd branch memory delete",
    title: "Delete stale branch memory",
    description:
      "Deletes a branch-scoped NullMem record by stable record id after a planning pass identifies it as stale or superseded.",
    whenToUse: [
      "Remove stale facts or procedures that conflict with newer hosted plan snapshots or verified code state.",
    ],
    whenNotToUse: [
      "Do not delete virtual capability records or authoritative branch content; write a superseding stale-memory fact if deletion is unavailable.",
    ],
    labels: ["tool", "nullmem", "delete", "stale-memory", "capability-memory"],
    sourceRefs: [{ kind: "tool", toolId: "nd branch memory delete" }],
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
