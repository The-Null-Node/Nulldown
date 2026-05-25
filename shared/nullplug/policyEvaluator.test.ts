import {
  evaluateConditionalGrant,
  normalizePolicyEvaluatorReturn,
  type PolicyEvaluatorCallable,
} from "./policyEvaluator";
import type { ConditionalGrant, GrantEvaluationRequest } from "./policy";

const grant: ConditionalGrant = {
  id: "approve-agent-patch",
  trigger: { kind: "ui.response", responseOf: "approval", field: "approved" },
  evaluator: { kind: "builtin.nullplug", id: "approval-policy" },
  maxGrant: { kind: "drop.diff.apply", scope: "branch" },
  onError: "deny",
};

const request: GrantEvaluationRequest = {
  grantId: grant.id,
  rootDropId: "root-1",
  branchId: "clone_anonymous",
  requested: { kind: "drop.diff.apply", scope: "branch" },
  trigger: grant.trigger,
  facts: {
    responses: { approved: true },
  },
};

describe("policy evaluator adapter", () => {
  it("normalizes policy decisions from invoke responses with diagnostics", () => {
    expect(
      normalizePolicyEvaluatorReturn({
        result: {
          yields: [
            {
              kind: "policy.decision",
              value: {
                decision: "allow",
                grant: { kind: "drop.diff.apply", scope: "branch" },
              },
            },
          ],
        },
        diagnostics: [{ level: "info", message: "approved" }],
      }),
    ).toEqual({
      decision: {
        decision: "allow",
        grant: { kind: "drop.diff.apply", scope: "branch" },
      },
      diagnostics: [{ level: "info", message: "approved" }],
    });
  });

  it("allows requested grants within maxGrant", async () => {
    const evaluator: PolicyEvaluatorCallable = () => ({
      result: {
        yields: [
          {
            kind: "policy.decision",
            value: { decision: "allow" },
          },
        ],
      },
    });

    await expect(
      evaluateConditionalGrant(grant, request, evaluator),
    ).resolves.toEqual({
      decision: {
        decision: "allow",
        grant: { kind: "drop.diff.apply", scope: "branch" },
      },
      diagnostics: [],
    });
  });

  it("denies by default when evaluator returns no decision", async () => {
    await expect(
      evaluateConditionalGrant(grant, request, () => ({ result: { content: "no" } })),
    ).resolves.toEqual({
      decision: {
        decision: "deny",
        reason: "Policy evaluator did not return a decision.",
      },
      diagnostics: [
        { level: "warn", message: "Policy evaluator did not return a decision." },
      ],
    });
  });

  it("defers on evaluator failure when grant is configured to defer", async () => {
    await expect(
      evaluateConditionalGrant(
        { ...grant, onError: "defer" },
        request,
        () => {
          throw new Error("network timeout");
        },
      ),
    ).resolves.toEqual({
      decision: {
        decision: "defer",
        reason: "Policy evaluator failed: network timeout",
      },
      diagnostics: [
        { level: "error", message: "Policy evaluator failed: network timeout" },
      ],
    });
  });

  it("denies grants outside maxGrant", async () => {
    await expect(
      evaluateConditionalGrant(grant, request, () => ({
        decision: "allow",
        grant: { kind: "drop.diff.apply", scope: "root" },
      })),
    ).resolves.toEqual({
      decision: {
        decision: "deny",
        reason: "Policy evaluator returned a grant outside maxGrant.",
      },
      diagnostics: [],
    });
  });
});
