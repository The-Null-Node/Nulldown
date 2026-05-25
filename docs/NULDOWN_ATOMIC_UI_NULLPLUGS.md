# Atomic UI Nullplugs, Streams, And Agent Output Plan

Parent tracker: [NullProvider, Nullplug, Snapshotter, And Null.Call](https://nulldown.app/d/Nr3hhv)

Checklist: [Nulldown runtime implementation checklist](https://nulldown.app/d/aN8B4B)

Status: Shared form/action/card primitive DTOs, immutable `ui.response` fact shape, optional proposed diff envelopes, guards, `ui.response` yield conversion, response-fact storage keys, and `POST /api/nullplug/submit` are implemented. Submitted response facts are stored immutably; proposed diffs remain data until a separate policy grant accepts them.

## Core Idea

Nullplug blocks can render atomic UIs, not just static embeds or cards. A form, approval panel, action card, or live stream can be a callable UI inside a Nulldown.

```text
nullplug block      -> callable tool invocation
rendered UI         -> atomic UI state
submit              -> immutable response fact
stream              -> live output channel
agent               -> long-running null.call attached to a drop or branch
resolved heap       -> queryable current state
```

## Atomic UI Rule

UI responses and agent outputs become facts first. Mutating document content is a separate permissioned step.

Recommended default:

```text
submit form     -> response fact / sidecar
agent result    -> proposed diff or mutation intent
explicit grant  -> accepted branch diff
```

## Result Envelope

No standalone UI response contract is required. UI state, mutations, yields, streams, and follow-up calls should live in the normalized `NullplugResult` envelope.

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

## Example Atomic Form

```markdown
```form(id="fix-title" schema="title-edit.v1")
Please suggest a better title.
```
```

The form renders from `content` and `uiState`. Submission writes a fact linked to source provenance.

```ts
interface NullplugYield {
  kind: "ui.response" | "policy.decision" | "stream.event" | "agent.note";
  id: string;
  createdAt: number;
  data: Record<string, JsonValue>;
  source: {
    rootDropId: string;
    branchId?: string;
    snapshotId?: number;
    eventId?: string;
    callId?: string;
  };
}
```

## Agent-In-Nulldown Loop

```text
agent null.call starts
  -> emits stream descriptor
  -> writes token chunks or status to stream heap
  -> proposes diffs or sidecar annotations
  -> finalizes with result yield
  -> resolved heaps and checklist state update
```

## Streams

Streams represent long-running output.

```ts
interface NullplugStreamDescriptor {
  id: string;
  kind: "render" | "inference" | "build" | "index" | "custom";
  status: "pending" | "running" | "complete" | "failed";
  url?: string;
  metadata?: Record<string, JsonValue>;
}
```

## Implementation Checklist

- [x] Add normalized `mutations` and `yields` to `NullplugResult`.
- [x] Define yield kinds for UI response, policy decision, stream event, and agent note.
- [x] Add form/action/card nullplug primitives.
- [x] Add submit endpoint or provider method for atomic UI response facts.
- [x] Store response facts as sidecars or resolved heap facts.
- [x] Let responses carry optional proposed diffs.
- [x] Add stream descriptors for long-running agent/plugin output.
- [x] Teach resolved heaps to index pending responses and proposed mutations.
