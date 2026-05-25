# Runtime Policy, Conditional Grants, And Callable Handlers Plan

Parent tracker: [NullProvider, Nullplug, Snapshotter, And Null.Call](https://nulldown.app/d/Nr3hhv)

Checklist: [Nulldown runtime implementation checklist](https://nulldown.app/d/aN8B4B)

Status: Shared runtime policy contracts, legacy `allowedUrls` normalization into `runtimePolicy.network.allowedHosts`, conditional grant DTOs, policy decision values, max-grant validation helpers, and callable policy evaluator normalization are implemented in `shared/nullplug/policy.ts` and `shared/nullplug/policyEvaluator.ts`.

## Core Idea

The root drop defines runtime authority. `metadata.allowedUrls` is only the first simple policy field. The full root policy should govern network access, drop reads, diff proposals, accepted mutations, streams, remote resolution, and conditional grants.

Conditional grants should have handlers. A handler can be another callable: built-in nullplug, remote nullplug, `null.call`, or provider policy handler.

## Root Runtime Policy

```ts
interface RootRuntimePolicy {
  version: 1;
  network?: { allowedHosts: string[] };
  drops?: {
    read?: "none" | "self" | "linked" | "explicit";
    write?: "none" | "propose" | "branch";
  };
  nullplugs?: Record<string, NullplugPermissionPolicy>;
  conditionalGrants?: ConditionalGrant[];
}
```

Root policy can live in drop metadata:

```json
{
  "runtimePolicy": {
    "version": 1,
    "network": { "allowedHosts": ["nulldown.app"] },
    "drops": { "read": "linked", "write": "propose" }
  }
}
```

## Callable Conditional Grants

```ts
interface ConditionalGrant {
  id: string;
  trigger: GrantTrigger;
  evaluator: CallableRef;
  maxGrant: RuntimeGrant;
  input?: PolicyInputSelector;
  onError?: "deny" | "defer";
}
```

```ts
type CallableRef =
  | { kind: "builtin.nullplug"; id: string }
  | { kind: "remote.nullplug"; id: string; endpoint: string }
  | { kind: "null.call"; id: string }
  | { kind: "policy.handler"; id: string };
```

## Safety Rule

Handlers can choose within `maxGrant`. They cannot invent authority beyond root policy.

```text
root policy defines max authority
conditional handler evaluates facts
runtime validates decision <= maxGrant
runtime applies or records decision
```

Example:

```ts
{
  id: "approve-agent-patch",
  trigger: {
    responseOf: "human-approval-form",
    field: "approved"
  },
  evaluator: {
    kind: "builtin.nullplug",
    id: "approval-policy"
  },
  maxGrant: {
    kind: "drop.diff.apply",
    scope: "branch"
  },
  onError: "deny"
}
```

## Policy Evaluation Request

```ts
interface GrantEvaluationRequest {
  grantId: string;
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  requested: RuntimeGrant;
  trigger: GrantTrigger;
  facts: {
    responses?: Record<string, JsonValue>;
    metadata?: Record<string, JsonValue>;
    resolvedHeapRefs?: string[];
  };
}
```

Policy handlers return a typed yield through `NullplugResult`:

```ts
interface PolicyDecisionYield {
  kind: "policy.decision";
  decision: "allow" | "deny" | "defer";
  grant?: RuntimeGrant;
  reason?: string;
  expiresAt?: number;
  metadata?: Record<string, JsonValue>;
}
```

## Runtime Constraints

- Deny by default.
- Deny on stale heap, timeout, schema mismatch, or evaluator failure unless `onError` is `defer`.
- Policy evaluation is side-effect-free by default.
- Policy handlers can call other callables only through explicit `policy.evaluate` capability.
- Evaluation needs timeout, depth, and cycle limits.
- Every decision gets an audit sidecar or event with input hash, evaluator id/version, decision, and source heap refs.

## Implementation Checklist

- [x] Define root runtime policy metadata shape.
- [x] Normalize `allowedUrls` into `runtimePolicy.network.allowedHosts` without breaking existing docs.
- [x] Add conditional grant types.
- [x] Add callable policy evaluator adapter.
- [x] Add max-grant validation.
- [x] Add policy decision yield type.
- [ ] Add audit sidecar for policy decisions.
- [x] Add tests for deny-by-default and max-grant enforcement.
