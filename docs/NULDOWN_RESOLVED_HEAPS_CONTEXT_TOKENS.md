# Resolved Heaps And Context Tokens Plan

Parent tracker: [NullProvider, Nullplug, Snapshotter, And Null.Call](https://nulldown.app/d/Nr3hhv)

Checklist: [Nulldown runtime implementation checklist](https://nulldown.app/d/aN8B4B)

Status: Shared `ndctx.v1` context token types, source-content hash helpers, source hash keys, resolved heap record types, markdown checklist heapification, general document heapification, top-k document node queries, diff-range/event-metadata relevance, resolved heap storage helpers, nullplug dependency indexing, and UI response indexing are implemented in `shared/drop/resolved.ts`. Branch-level resolved document queries are available through `GET /api/branches/:rootId/:branchId/resolved/query` and `nd branch query`.

## Core Idea

Primary branch heaps remain authoritative. Resolved heaps are materialized, queryable views over drops, branches, snapshots, nullplug calls, checklists, and sidecars.

The goal is to replace large prompt reloads with small provenance tokens plus targeted heap queries.

```text
Primary branch heap      -> source of truth
Resolved snapshot heap   -> queryable current state
Semantic sidecars        -> summaries, importance, dependency edges, agent notes
Context token            -> pointer/provenance/query intent
Raw markdown             -> fallback when resolved heaps are stale or missing
```

## Why This Matters

Instead of loading a parent plan, six child plans, a checklist, raw diffs, and raw markdown, an agent can load a compact context capsule:

```ts
interface NulldownContextToken {
  version: 1;
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  checklistDropId?: string;
  resolvedHeapIds: string[];
  sourceHashes: Record<string, string>;
  queryHints: Array<{
    dropId: string;
    kind: "checklist.next" | "plan.status" | "dependency.edges" | "policy.pending";
  }>;
}
```

Portable encoding:

```text
ndctx.v1.<base64url-json>
```

The token is not secret and not authoritative. It is a reload key for what to fetch and what to trust if hashes and snapshot provenance still match.

## Resolved State Shape

A resolved Nulldown state should be keyed by source provenance and resolver version.

```ts
interface ResolvedNulldownState {
  version: 1;
  id: string;
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  sourceRevision?: string;
  sourceSeqRange?: { from: number; to: number };
  sourceContentHash: string;
  resolverId: string;
  resolverVersion: string;
  resolvedAt: number;
  title?: string;
  summary?: string;
  checklistItems?: ResolvedChecklistItem[];
  pluginRefs?: ResolvedPluginRef[];
  policyFacts?: ResolvedPolicyFact[];
  responseRefs?: ResolvedUiResponseRef[];
  importance?: Record<string, number>;
}
```

General document heaps add queryable structural nodes:

```ts
interface ResolvedDocumentNode {
  id: string;
  kind:
    | "document.title"
    | "section"
    | "heading"
    | "paragraph"
    | "list.item"
    | "checklist.item"
    | "code.block"
    | "nullplug.ref"
    | "link.ref"
    | "diff.region";
  text: string;
  sourceRange: { start: number; end: number };
  headingPath?: string[];
  sectionId?: string;
  pluginId?: string;
  dropId?: string;
  importance?: number;
}
```

Checklist item shape:

```ts
interface ResolvedChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  phase?: string;
  importance?: number;
  sourceRange?: { start: number; end: number };
  sourceHash: string;
}
```

## Query Flow

For planning:

```text
1. Read ndctx token or known checklist drop id.
2. Fetch latest resolved checklist heap.
3. Validate source hash, snapshot id, resolver id, and resolver version.
4. Query next unchecked item by importance.
5. Fetch raw markdown only if stale or missing.
```

Example query:

```text
drop aN8B4B -> latest resolved checklist heap -> unchecked items ordered by importance
```

General branch query:

```bash
bun run nd -- branch query <rootId> <branchId> --query "policy mutation" --top 10 --from-seq 18 --to-seq 20 --include-ancestors --json
```

The branch query fuses structural document nodes with diff event metadata. Without `--query`, it returns important/open/structural nodes. With `--from-seq` and `--to-seq`, it boosts nodes overlapping changed ranges and returns event metadata refs for later agent fetches.

## Heapify Rules

- Heapify is a rebuild or improvement of derived state from primary facts.
- Heapify must be resumable and cursor-based.
- Heapify must never rewrite authoritative branch events.
- Heapify writes sidecars or resolved heap records.
- Heapify records resolver id, resolver version, input refs, and source hashes.

## Token Savings Rule

Agents should carry Nulldown links, ids, context tokens, and heap refs across compaction. They should avoid carrying raw plan graphs unless a heap is stale or missing.

## Implementation Checklist

- [x] Define `ndctx.v1` context token shape.
- [x] Add source hash helper for markdown payloads and branch snapshots.
- [x] Add resolved heap record types.
- [x] Add resolved checklist parser/heapifier.
- [x] Add query helper for next unchecked important item.
- [x] Add general document heap parser for titles, headings, sections, content blocks, links, and nullplug refs.
- [x] Add top-k document node query with lexical, importance, structural, and diff-range scoring.
- [x] Add branch resolved query endpoint and CLI command.
- [x] Store resolver id/version and source provenance on every resolved heap.
- [ ] Add stale-heap fallback to raw markdown fetch.
- [x] Link resolved heaps to sidecar metadata and plugin refs.
