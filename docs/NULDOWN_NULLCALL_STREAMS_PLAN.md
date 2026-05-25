# Null.Call, Streams, Atomic UIs, And Future NullMem Plan

Parent tracker: [Original tracker](https://nulldown.app/d/Nr3hhv)

Checklist: [Runtime checklist](https://nulldown.app/d/aN8B4B)

## Null.Call

`null.call` is the future agentic orchestration framework. It should compose inference, tools, nullplugs, streams, diffs, provider state, root policy, and resolved heaps.

A call can produce:

- Renderable content.
- UI state.
- Proposed diffs.
- Accepted diffs, if authorized.
- Metadata annotations.
- Streams.
- Follow-up calls.
- Policy decision yields.

## Atomic UIs

Related plan: [Atomic UI nullplugs](https://nulldown.app/d/emEFnm)

Nullplugs can render forms, action cards, approval UIs, or live agent panes. Submissions become atomic facts first; content mutations remain permissioned branch diffs.

```text
nullplug block -> UI -> response fact -> resolved heap -> proposed mutation -> policy grant -> accepted diff
```

## Call Contract

```ts
interface NullCallRequest {
  callId: string;
  goal: string;
  context: {
    dropId?: string;
    branchId?: string;
    snapshotId?: number;
    selectedText?: string;
    metadata?: Record<string, JsonValue>;
    resolvedHeapRefs?: string[];
  };
  tools: Array<"drop.read" | "diff.propose" | "diff.apply" | "nullplug.invoke" | "stream.create" | "policy.evaluate">;
}
```

```ts
interface NullCallResult {
  message?: string;
  proposedDiffs?: DropDiffEnvelope;
  appliedDiffs?: DropDiffEnvelope;
  metadata?: Record<string, JsonValue>;
  streams?: NullplugStreamDescriptor[];
  followups?: NullCallRequest[];
  yields?: NullplugYield[];
}
```

## Streams

Nullplugs and null.call can spawn streams.

Examples:

- Long-running render stream.
- Model token stream.
- Plugin output stream.
- Background indexing stream.
- Import/build/typecheck stream for TypeScript nullplugs.

```ts
interface NullplugStreamDescriptor {
  id: string;
  kind: "render" | "inference" | "build" | "index" | "custom";
  url?: string;
  status: "pending" | "running" | "complete" | "failed";
  metadata?: Record<string, JsonValue>;
}
```

## NullMem

`NullMem` should be a wrapper that composes everything after the event/snapshot/metadata model is stable.

It observes:

- Diff events.
- Snapshot records.
- Sidecar annotations.
- Resolved heaps.
- Nullplug invocations.
- Nullplug outputs.
- Null.call results.
- Runtime policy decisions.
- Provider indexes.

It should not be required for primary editing or replay.

## Non-Goals For Now

- No memory dependency in primary branch append path.
- No blocking inference during text writes.
- No automatic agent edits without explicit authorization or grants.
- No hidden mutation of event logs.
