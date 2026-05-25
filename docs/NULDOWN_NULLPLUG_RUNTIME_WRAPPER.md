# Nullplug Runtime Wrapper And Remote DTO Normalization Plan

Parent tracker: [NullProvider, Nullplug, Snapshotter, And Null.Call](https://nulldown.app/d/Nr3hhv)

Checklist: [Nulldown runtime implementation checklist](https://nulldown.app/d/aN8B4B)

Status: Shared `NullplugResult` DTOs now include `mutations`, `yields`, stream status/url fields, remote invoke request/response shapes, diagnostics, and runtime guards. The render pipeline now normalizes legacy handler returns, normalized result DTOs, and remote invoke responses through `normalizeNullplugRuntimeReturn` while preserving existing patch behavior, carrying diagnostics, optionally validating against root runtime policy, and normalizing privileged mutations.

## Core Idea

The nullplug wrapper is the compatibility boundary between existing compiled nullplugs, remote nullplug DTOs, policy callables, and future `null.call` outputs.

```text
compiled nullplug return
remote nullplug DTO
legacy renderable patch
future null.call result
        ↓
normalize to NullplugResult
        ↓
validate against root policy
        ↓
render / store / propose / stream
```

## Runtime Layers

```text
Root drop policy
  defines capabilities, conditional grants, resolver rules

Nullplug runtime wrapper
  invokes built-in, compiled, remote, or policy plugins and normalizes returns

Result application layer
  renders UI, records state, emits streams, proposes or applies mutations
```

## Normalized Result

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

Existing handlers that return `RenderablePatch` should adapt to `content`.

Remote handlers should return DTOs:

```ts
interface NullplugInvokeRequest {
  call: NullplugCall;
  context: {
    providerId: string;
    baseUrl: string;
    callerDropId?: string;
    branchId?: string;
    snapshotId?: number;
    capabilities: string[];
    rootPolicyRef?: string;
  };
}
```

```ts
interface NullplugInvokeResponse {
  result: NullplugResult;
  diagnostics?: Array<{ level: "info" | "warn" | "error"; message: string }>;
}
```

## Wrapper Responsibilities

- Parse invocation into a `NullplugCall`.
- Resolve plugin by built-in id, compiled registry, remote manifest, or policy callable.
- Invoke with bounded context and capabilities.
- Normalize return values to `NullplugResult`.
- Validate result against root policy.
- Reject or downgrade unsafe mutations.
- Emit metadata/yield/stream sidecars when appropriate.
- Preserve legacy `RenderablePatch` behavior until all built-ins migrate.

Implemented root policy hook behavior:

- Deny or defer explicit plugin invocations based on `policy.nullplugs[pluginId].invoke`.
- Filter top-level proposed diffs, mutations, nested calls, and streams that exceed root policy or plugin `maxGrants`.
- Enforce root network allowed hosts for stream URLs.
- Preserve existing content rendering when no root policy is provided.
- Normalize legacy top-level `diffs` into `drop.diff.propose` mutations.
- Downgrade `drop.diff.apply` mutations to proposals when apply authority is missing but proposal authority exists.

## Mutation Model

Mutations are intent, not automatic authority.

```ts
type NullplugMutation =
  | { kind: "drop.diff.propose"; envelope: DropDiffEnvelope; reason?: string }
  | { kind: "drop.diff.apply"; envelope: DropDiffEnvelope; grantId: string }
  | { kind: "metadata.patch"; patch: JsonValue; reason?: string }
  | { kind: "sidecar.write"; target: string; value: JsonValue };
```

Runtime policy decides whether each mutation is rendered as a proposal, applied, rejected, or deferred. Legacy top-level `diffs` are normalized into proposed mutations. Apply mutations are preserved only when apply authority exists; otherwise they downgrade to proposed mutations if proposal authority exists.

## Implementation Checklist

- [ ] Introduce `NullplugRuntime` wrapper.
- [x] Add adapter from current `NullplugHandler` return type to `NullplugResult`.
- [x] Add remote invoke DTOs.
- [x] Add root policy validation hook.
- [x] Add mutation normalization and downgrade rules.
- [x] Add diagnostics handling.
- [x] Add tests for built-in, remote-shaped, and policy-shaped returns.
