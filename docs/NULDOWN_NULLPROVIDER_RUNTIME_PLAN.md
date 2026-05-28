# NullProvider Runtime And Provider Promotion Plan

Parent tracker: [Original tracker](https://nulldown.app/d/Nr3hhv)

Checklist: [Runtime checklist](https://nulldown.app/d/aN8B4B)

Status: The first provider nullplug boundary is implemented as `POST /api/nullplug/resolve`, supporting the trusted built-in `nd` resolver only. It accepts shared invoke DTOs, returns normalized `NullplugInvokeResponse` results, and rejects unsupported plugin ids instead of loading remote code. Atomic UI response facts can now be submitted through `POST /api/nullplug/submit` and stored immutably.

## Core Split

`VoidProvider` remains the app-facing drop runtime. `DropProviderPort` stays narrow as a child local, remote, or server capability port:

```text
DropProviderPort
  create(payload)
  get(id)
  delete(id)
  list()
  resolveGraph(id)
  sync(target)
```

`NullProvider` wraps it:

```text
NullProvider
  storage: DropProviderPort
  nullplug: NullplugService
  policy: RuntimePolicyService
  inference: NullCallService
  streams: StreamService
  index: ProviderIndex
  registry: NullplugRegistry
  memory?: NullMem
```

This preserves current provider guarantees while giving heavier runtime capabilities a clear home.

## Responsibilities

| Layer | Responsibility |
| --- | --- |
| `DropProviderPort` | Child drop CRUD, sealed envelope storage, plaintext payload access where allowed, sync, lineage graph. |
| `NullProvider` | Runtime orchestration across drops, nullplugs, streams, policy, inference, registry, and indexes. |
| `NullplugService` | Parse, resolve, invoke, stream, normalize, and index nullplug calls. |
| `RuntimePolicyService` | Evaluate root policy, conditional grants, callable handlers, and max-grant enforcement. |
| `NullCallService` | Future agentic orchestration framework for inference and tool-calling. |
| `StreamService` | Runtime-owned stream descriptors for plugins and future calls. |
| `ProviderIndex` | Search/index documents, nullplug dependency edges, semantic sidecars, resolved heaps. |
| `NullMem` | Future optional memory wrapper over diffs, snapshots, calls, and metadata. |

## Provider Capabilities

```ts
interface NullProviderCapabilities {
  storage: true;
  nullplug: boolean;
  remoteNullplug: boolean;
  typedNullplugPackages: boolean;
  runtimePolicy: boolean;
  conditionalGrants: boolean;
  nullCall: boolean;
  streams: boolean;
  semanticIndex: boolean;
  metadataSidecars: boolean;
  resolvedHeaps: boolean;
}
```

## Runtime Policy Is Root-Scoped

The root drop defines runtime authority beyond `allowedUrls`.

Related plan: [Runtime policy and conditional grants](https://nulldown.app/d/I1FGwa)

Policy controls:

- Network access.
- Drop read/write scope.
- Nullplug capabilities.
- Conditional grants.
- Whether UI responses or policy handlers can unlock mutations.

## API Shape

Provider runtime shape:

```ts
interface NullProvider {
  storage: DropProviderPort;
  nullplug: NullplugService;
  policy: RuntimePolicyService;
  inference?: NullCallService;
  streams?: StreamService;
  index?: ProviderIndex;
  memory?: NullMem;
}
```

Server HTTP shape can follow the same boundaries:

```text
POST /api/nullplug/resolve
POST /api/nullplug/invoke
POST /api/nullplug/submit
GET  /api/nullplug/stream/:streamId
POST /api/nullplug/register
GET  /api/nullplug/registry
GET  /api/nullplug/index
```

## New Chain Links

- [Nullplug runtime wrapper](https://nulldown.app/d/mAJODb)
- [Runtime policy and conditional grants](https://nulldown.app/d/I1FGwa)
- [Resolved heaps and context tokens](https://nulldown.app/d/hB70BJ)
- [Atomic UI nullplugs](https://nulldown.app/d/emEFnm)

## Non-Goals For First Pass

- Do not run arbitrary user TypeScript in provider runtime.
- Do not add `NullMem` as required infrastructure.
- Do not make nullplug rendering part of raw drop fetching.
- Do not let secondary snapshotters block primary text writes.
- Do not let conditional grant handlers exceed root-defined max authority.
