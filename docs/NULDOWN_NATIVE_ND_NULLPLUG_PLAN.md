# Native `nd` Nullplug And Nulldown Composition Plan

Parent tracker: [Original tracker](https://nulldown.app/d/Nr3hhv)

Checklist: [Runtime checklist](https://nulldown.app/d/aN8B4B)

Status: Implemented, Phase 1 card mode.

## Current Syntax

Preferred explicit syntax:

````markdown
```nd(id="dkfewwf")
```
````

Body fallback syntax:

````markdown
```nd
dkfewwf
```
````

Optional future fields:

````markdown
```nd(id="dkfewwf" mode="card" depth="1")
```
````

## Implemented Behavior

- Parses ID from args or body.
- Resolves through the active browser provider where available.
- Renders compact cards by default.
- Includes title, preview, link, and metadata hints.
- Avoids iframe embedding for Nulldown drops.
- Adds initial shared nullplug call/result contracts.

## Rendering Modes

| Mode | Behavior | Status |
| --- | --- | --- |
| `card` | Title, preview, metadata, link. Best default. | Implemented |
| `inline` | Render child markdown inline with recursion guards. | Future |
| `raw` | Show source markdown. Useful for docs/debugging. | Future |
| `summary` | Provider/semantic-index generated summary. | Future |

Default is `card`. Inline rendering waits for stronger recursion, cycle, permission, and provider-level resolver rules.

## Resolver Contract

The browser and provider should converge on the same resolver shape:

```ts
interface NativeNulldownResolveInput {
  id: string;
  mode?: "card" | "inline" | "raw" | "summary";
  branchId?: string;
  snapshotId?: number;
  depth: number;
  maxDepth: number;
  visitedDropIds: string[];
}
```

```ts
interface NativeNulldownResolveResult {
  id: string;
  canonicalId?: string;
  url?: string;
  title?: string;
  content?: string;
  renderedContent?: string;
  metadata?: Record<string, JsonValue>;
  uiState?: Record<string, JsonValue>;
  blocked?: boolean;
  reason?: string;
}
```

## New Chain Links

- Resolved heaps and token-saving reloads: [Resolved heaps and context tokens](https://nulldown.app/d/hB70BJ)
- Runtime wrapper and remote DTO normalization: [Nullplug runtime wrapper](https://nulldown.app/d/mAJODb)
- Root policy and callable grants: [Runtime policy and conditional grants](https://nulldown.app/d/I1FGwa)
- Atomic UI output and streams: [Atomic UI nullplugs](https://nulldown.app/d/emEFnm)

## Diff Behavior

Inserting an `nd` block is still markdown text and should be published as a normal branch diff. The event should include semantic metadata:

```ts
metadata: {
  kind: "nullplug.invoke",
  pluginId: "nd",
  args: { id: "dkfewwf", mode: "card" },
  intent: "embed Nulldown child plan"
}
```

This makes reference edges indexable without changing the source-of-truth markdown.

## Next Work

- [ ] Emit semantic metadata for `nd` block insertions.
- [ ] Add explicit cycle detection and provenance for future inline mode.
- [x] Let resolved heaps index `nd` dependency edges.
- [x] Add provider-level `nd` resolution through `POST /api/nullplug/resolve`.
