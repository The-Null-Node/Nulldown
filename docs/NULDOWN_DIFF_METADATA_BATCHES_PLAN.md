# Batched Diff, Event Metadata, And Callable Drops Plan

Parent tracker: [Original tracker](https://nulldown.app/d/Nr3hhv)

Checklist: [Runtime checklist](https://nulldown.app/d/aN8B4B)

Status: Event metadata contracts, validation, API persistence, channel propagation, CLI `--metadata-file` for `apply`/`replace`, and `nd diff batch` are implemented.

## Existing Baseline

The current branch API already accepts batched events:

```ts
interface DropDiffEnvelope {
  version: 1;
  events: DropDiffEvent[];
}
```

The server assigns authoritative `seq` values and appends events to the branch heap.

## Event-Level Metadata

Add metadata to `DropDiffEvent` first:

```ts
interface DropDiffEvent {
  eventId: string;
  seq: number;
  dropId: string;
  sourceClientId: string;
  createdAt: number;
  snapshotId?: number;
  ops: DropDiffOp[];
  metadata?: DropDiffEventMetadata;
}
```

```ts
interface DropDiffEventMetadata {
  kind?: "user.edit" | "agent.edit" | "nullplug.invoke" | "nullplug.result" | "ui.response" | "policy.decision";
  intent?: string;
  pluginId?: string;
  args?: Record<string, JsonValue>;
  batchId?: string;
  batchIndex?: number;
  parentEventId?: string;
  followsSeq?: number;
  labels?: string[];
  confidence?: number;
  resultRef?: string;
  policyDecisionRef?: string;
}
```

Keep metadata at the event level before adding op-level metadata. Most useful meaning belongs to the action, not every character insert/delete.

## Nullplug Results And Mutations

Nullplug returns can include mutations and yields after normalization by the runtime wrapper.

Related plan: [Nullplug runtime wrapper](https://nulldown.app/d/mAJODb)

```ts
interface NullplugResult {
  content?: string;
  uiState?: Record<string, JsonValue>;
  metadata?: Record<string, JsonValue>;
  mutations?: NullplugMutation[];
  yields?: NullplugYield[];
  streams?: NullplugStreamDescriptor[];
  calls?: NullplugCall[];
}
```

Mutation intents can become proposed diffs, accepted diffs, metadata patches, or sidecar writes depending on root policy and conditional grants.

## Batched Diffs

A batch is a group of related events posted together.

Use cases:

- Agent applies multiple edits as one operation.
- Nullplug inserts source text and emits a follow-up normalization diff.
- Provider applies dependency updates after resolving references.
- CLI publishes a full planned change as ordered events.
- Conditional grant applies a previously proposed UI or agent mutation.

Rules:

1. Server `seq` stays authoritative.
2. `batchId` groups related events.
3. `batchIndex` preserves client-declared intent order inside the batch.
4. Server can reject malformed duplicate batch indexes but should not trust them for replay order.
5. Replay always sorts by server `seq`.

## Callable Drops

A callable drop invocation can be represented as:

```ts
metadata: {
  kind: "nullplug.invoke",
  pluginId: "nd",
  args: {
    id: "childDropId",
    mode: "card"
  }
}
```

The raw markdown block remains source of truth. Metadata makes it queryable and explainable.

## CLI Support

Implemented commands:

```bash
nd diff batch <dropId> --branch <branchId> --body-file batch.json
nd diff apply <dropId> --branch <branchId> --metadata-file event-meta.json --insert 0:text
nd diff replace <dropId> --branch <branchId> --metadata-file event-meta.json --to-file edited.md
```

## API Schema Work

Updated:

- `shared/drop/diff.ts`
- `shared/drop/diffSchemas.ts`
- `src/lib/diff/diffChannel.ts`
- `src/pages/editor/hooks/useDiffChannel.ts`
- `src/cli/index.ts`
- `functions/api/diff/[id].ts`

Verified with:

- Diff API contract tests for metadata persistence and validation.
- CLI `--metadata-file` smoke path through live diff polling.
- CLI `nd diff batch` smoke path with two ordered events and metadata.

## New Chain Links

- [Atomic UI nullplugs](https://nulldown.app/d/emEFnm)
- [Runtime policy and conditional grants](https://nulldown.app/d/I1FGwa)
- [Resolved heaps and context tokens](https://nulldown.app/d/hB70BJ)
