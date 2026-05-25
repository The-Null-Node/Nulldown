import {
  isNullplugInvokeResponse,
  isNullplugResult,
  type NullplugDiagnostic,
  type NullplugInvokeResponse,
  type NullplugResult,
} from "./types";
import {
  isPolicyDecisionValue,
  isRuntimeGrantWithinMaxGrant,
  type ConditionalGrant,
  type GrantEvaluationRequest,
  type PolicyDecisionValue,
  type RuntimeGrant,
} from "./policy";

export type PolicyEvaluatorReturn =
  | NullplugInvokeResponse
  | NullplugResult
  | PolicyDecisionValue
  | null
  | undefined;

export type PolicyEvaluatorCallable = (
  request: GrantEvaluationRequest,
) => PolicyEvaluatorReturn | Promise<PolicyEvaluatorReturn>;

export interface NormalizedPolicyEvaluatorReturn {
  decision: PolicyDecisionValue | null;
  diagnostics: NullplugDiagnostic[];
}

export interface PolicyEvaluationOutcome {
  decision: PolicyDecisionValue;
  diagnostics: NullplugDiagnostic[];
}

const diagnostic = (
  level: NullplugDiagnostic["level"],
  message: string,
): NullplugDiagnostic => ({ level, message });

const fallbackDecision = (
  grant: ConditionalGrant,
  reason: string,
): PolicyDecisionValue => ({
  decision: grant.onError === "defer" ? "defer" : "deny",
  reason,
});

const policyDecisionFromResult = (
  result: NullplugResult,
): PolicyDecisionValue | null => {
  const yieldValue = result.yields?.find(
    (entry) => entry.kind === "policy.decision" && isPolicyDecisionValue(entry.value),
  )?.value;

  return isPolicyDecisionValue(yieldValue) ? yieldValue : null;
};

export const normalizePolicyEvaluatorReturn = (
  value: unknown,
): NormalizedPolicyEvaluatorReturn => {
  if (isPolicyDecisionValue(value)) {
    return { decision: value, diagnostics: [] };
  }

  if (isNullplugInvokeResponse(value)) {
    return {
      decision: policyDecisionFromResult(value.result),
      diagnostics: value.diagnostics ?? [],
    };
  }

  if (isNullplugResult(value)) {
    return {
      decision: policyDecisionFromResult(value),
      diagnostics: [],
    };
  }

  return { decision: null, diagnostics: [] };
};

const requestedFitsReturnedGrant = (
  requested: RuntimeGrant,
  returnedGrant: RuntimeGrant,
): boolean => isRuntimeGrantWithinMaxGrant(requested, returnedGrant);

const constrainAllowedDecision = (
  grant: ConditionalGrant,
  request: GrantEvaluationRequest,
  decision: PolicyDecisionValue,
): PolicyDecisionValue => {
  if (decision.decision !== "allow") {
    return decision;
  }

  const effectiveGrant = decision.grant ?? request.requested;
  if (!isRuntimeGrantWithinMaxGrant(effectiveGrant, grant.maxGrant)) {
    return {
      decision: "deny",
      reason: "Policy evaluator returned a grant outside maxGrant.",
    };
  }

  if (!requestedFitsReturnedGrant(request.requested, effectiveGrant)) {
    return {
      decision: "deny",
      reason: "Requested grant exceeds policy evaluator decision.",
    };
  }

  return {
    ...decision,
    grant: effectiveGrant,
  };
};

export const evaluateConditionalGrant = async (
  grant: ConditionalGrant,
  request: GrantEvaluationRequest,
  evaluator: PolicyEvaluatorCallable,
): Promise<PolicyEvaluationOutcome> => {
  if (request.grantId !== grant.id) {
    return {
      decision: fallbackDecision(grant, "Grant request id does not match."),
      diagnostics: [diagnostic("error", "Grant request id does not match.")],
    };
  }

  let returned: PolicyEvaluatorReturn;
  try {
    returned = await evaluator(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      decision: fallbackDecision(grant, `Policy evaluator failed: ${message}`),
      diagnostics: [diagnostic("error", `Policy evaluator failed: ${message}`)],
    };
  }

  const normalized = normalizePolicyEvaluatorReturn(returned);
  if (!normalized.decision) {
    return {
      decision: fallbackDecision(grant, "Policy evaluator did not return a decision."),
      diagnostics: [
        ...normalized.diagnostics,
        diagnostic("warn", "Policy evaluator did not return a decision."),
      ],
    };
  }

  return {
    decision: constrainAllowedDecision(grant, request, normalized.decision),
    diagnostics: normalized.diagnostics,
  };
};
