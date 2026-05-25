# Nullplug Registry, Remote Providers, And TypeScript Plugin Security Plan

Parent tracker: [Original tracker](https://nulldown.app/d/Nr3hhv)

Checklist: [Runtime checklist](https://nulldown.app/d/aN8B4B)

Status: Shared remote manifest, permission, registry record, deterministic key, allowlist gate, generic JSON read/write helpers, and registry HTTP endpoints are implemented. `POST /api/nullplug/registry` requires account auth plus HMAC manifest signature verification. Remote invocation remains disabled until timeout and policy enforcement are added.

## Resolver Paths

There should be two resolver paths.

1. Remote resolver: plugin runs on the plugin author's provider and Nulldown calls it through a constrained HTTP contract.
2. Typed package resolver: trusted TypeScript plugin package is compiled, typechecked, registered, indexed, and imported by a trusted runtime.

Remote resolver comes first.

## Runtime Wrapper

All resolver paths should pass through the same wrapper.

Related plan: [Nullplug runtime wrapper](https://nulldown.app/d/mAJODb)

```text
built-in handler
compiled package handler
remote DTO response
policy callable
null.call result
        ↓
normalize to NullplugResult
        ↓
validate against root policy
        ↓
render / store / propose / stream
```

## Remote Manifest

```ts
interface RemoteNullplugManifest {
  id: string;
  version: string;
  endpoint: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permissions: NullplugPermission[];
  signature?: string;
  author?: string;
  repository?: string;
  description?: string;
}
```

## Invocation Contract

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

## Permissions

Example permissions:

```ts
type NullplugPermission =
  | { kind: "network"; hosts: string[] }
  | { kind: "drop.read"; scope: "caller" | "explicit" }
  | { kind: "drop.diff.propose" }
  | { kind: "stream.create" }
  | { kind: "null.call" }
  | { kind: "policy.evaluate" };
```

Plugins get capabilities, not ambient access. Root policy and conditional grants decide actual authority.

Related plan: [Runtime policy and conditional grants](https://nulldown.app/d/I1FGwa)

## Security Rule

No arbitrary dynamic imports from user-provided URLs in the app or provider runtime.

Unsafe:

```ts
await import(userProvidedUrl)
```

Safer progression:

1. Built-in trusted plugins.
2. Remote HTTP resolver with schema validation, timeouts, signatures, and capability tokens.
3. Trusted package/import-map plugins.
4. Sandboxed TypeScript execution later using isolates, Workers, or a sandbox service.

## Registry Storage

Likely D1-backed index:

```text
nullplug_manifests
nullplug_versions
nullplug_permissions
nullplug_provider_refs
nullplug_usage_edges
nullplug_policy_edges
```

Usage edges matter because `nd` calls, atomic UIs, and policy handlers create dependency graphs across Nulldowns.

## Registry HTTP Contract

Implemented endpoint:

```text
GET  /api/nullplug/registry
POST /api/nullplug/registry
```

`GET` lists active latest manifests from registry storage. `POST` registers a signed remote manifest and stores both the immutable version key and latest key.

Required production controls:

- Account authentication through the existing account auth path.
- `NULLPLUG_REGISTRY_SIGNATURE_SECRET` for HMAC SHA-256 manifest signatures.
- `NULLPLUG_REGISTRY_ALLOWED_HOSTS` for endpoint and network-permission host allowlisting.

Manifest signatures use `sha256=<hex>` over canonical manifest JSON with the `signature` field excluded. Registry writes validate the manifest shape, signature, endpoint host, and declared network permission hosts before storage.

## Implementation Checklist

- [x] Add remote nullplug manifest model.
- [x] Add permission/capability DTOs including `policy.evaluate`.
- [x] Add allowlist-gated registry storage helpers.
- [x] Add registry HTTP endpoints with auth.
- [x] Add manifest signature verification.
- [ ] Add remote invocation timeout and policy enforcement.
- [ ] Defer trusted package plugins until remote HTTP plugins work.
