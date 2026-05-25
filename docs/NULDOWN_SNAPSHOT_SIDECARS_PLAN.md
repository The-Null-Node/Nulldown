# Snapshot Heap, Metadata Sidecars, And Snapshotter Orchestration Plan

Parent tracker: [Original tracker](https://nulldown.app/d/Nr3hhv)

Checklist: [Runtime checklist](https://nulldown.app/d/aN8B4B)

Status: Shared sidecar record types, validation guards, deterministic R2-compatible key helpers, and generic JSON read/write helpers are implemented in `shared/drop/sidecar.ts` for event and snapshot metadata sidecars. Branch append observers now dispatch after primary write success with `waitUntil` support and isolated observer errors.

## Existing Primary Heap

Current branch heap v2 stores:

```text
__drop_branch__/<root>/<branch>.json
__drop_snapshot__/<root>/<branch>/<snapshotId>.json
__drop_checkpoint__/<root>/<branch>/<snapshotId>.txt
__drop_branch_diff_events__/<root>/<branch>/<seq>.json
__drop_branch_diff_event_ids__/<root>/<branch>/<eventId>.txt
```

This is the authoritative replay path. Do not destabilize it.

## Sidecar Principle

Accepted diff events and primary snapshots are immutable facts. Agents and secondary systems can add interpretation later through mutable sidecars.

```text
__drop_diff_event_metadata__/<root>/<branch>/<seq>.json
__drop_snapshot_metadata__/<root>/<branch>/<snapshotterId>/<snapshotId>.json
__drop_resolved_heap__/<root>/<branch>/<resolverId>/<snapshotId>.json
```

Sidecars and resolved heaps can evolve without corrupting replay.

## Resolved Heaps

Resolved heaps are materialized views over primary heaps and sidecars.

Related plan: [Resolved heaps and context tokens](https://nulldown.app/d/hB70BJ)

Examples:

- Checklist state with item ids, checked state, source ranges, and importance.
- Nullplug dependency edges and referenced drop ids.
- Policy facts and pending conditional grants.
- Agent summary state and useful context capsules.

## Event Metadata Sidecars

```ts
interface DropDiffEventMetadataSidecar {
  version: 1;
  rootDropId: string;
  branchId: string;
  seq: number;
  eventId: string;
  updatedAt: number;
  updatedBy: string;
  annotations: Array<{
    kind: "summary" | "semantic-tag" | "ranking" | "plugin-reference" | "agent-note" | "policy-decision" | "ui-response";
    value: JsonValue;
    confidence?: number;
    source?: string;
  }>;
}
```

## Snapshot Metadata Sidecars

```ts
interface DropSnapshotMetadataSidecar {
  version: 1;
  snapshotterId: string;
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  tags?: string[];
  embeddingRef?: string;
  pluginRefs?: string[];
  memoryRefs?: string[];
  resolvedHeapRefs?: string[];
}
```

## Snapshotter Observers

Primary heap emits. Secondary snapshotters subscribe.

```ts
interface SnapshotterObserver {
  id: string;
  onDiffAccepted?(event: DropDiffEvent, context: SnapshotterContext): Promise<void>;
  onSnapshotCreated?(snapshot: DropSnapshotRecord, context: SnapshotterContext): Promise<void>;
  onHeapify?(context: HeapifyContext): Promise<void>;
  iter?(query: SnapshotQuery): AsyncIterable<SnapshotRecord>;
}
```

## Snapshotter Roles

| Snapshotter | Role |
| --- | --- |
| PrimaryTextSnapshotter | Authoritative text, checkpoints, diff replay. |
| PluginIndexSnapshotter | Tracks nullplug calls, dependency edges, output refs. |
| ResolvedChecklistSnapshotter | Tracks checklist item state for fast planning queries. |
| PolicyFactSnapshotter | Tracks policy decisions, pending grants, and audit refs. |
| SemanticSnapshotter | Summaries, tags, explanations, ranking hints. |
| NullMem | Future agentic memory wrapper, composed later. |

## Write Safety

- Primary writes must not wait on secondary snapshotters.
- Secondary writes must be idempotent.
- Sidecar writes carry updater identity and timestamps.
- Agent annotations are append/merge safe.
- Replay must not depend on sidecars or resolved heaps.

## Implementation Checklist

- [x] Add event metadata sidecar record types, guards, keys, and read/write helpers.
- [x] Add snapshot metadata sidecar record types, guards, keys, and read/write helpers.
- [x] Add resolved heap storage helpers.
- [x] Add branch append observer hooks after primary write success.
- [ ] Add idempotent sidecar write tests.
