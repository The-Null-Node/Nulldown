import {
  DEFAULT_RUNTIME_NETWORK_ALLOWLIST,
  isConditionalGrant,
  isPolicyDecisionValue,
  isRootRuntimePolicy,
  isRuntimeGrantWithinMaxGrant,
  normalizeAllowedHosts,
  resolveRootRuntimePolicy,
} from "./policy";

describe("runtime policy helpers", () => {
  it("normalizes allowed hosts from URLs and legacy allowedUrls", () => {
    expect(
      normalizeAllowedHosts([
        "https://www.youtube.com/watch?v=demo",
        "player.vimeo.com",
        "HTTPS://YOUTU.BE/abc",
        "youtube.com/path",
        "not a valid host !!!",
      ]),
    ).toEqual(["www.youtube.com", "player.vimeo.com", "youtu.be", "youtube.com"]);

    expect(
      resolveRootRuntimePolicy({
        allowedUrls: ["HTTPS://WWW.YouTube.com/embed/demo", "player.vimeo.com"],
      }),
    ).toEqual({
      version: 1,
      network: { allowedHosts: ["www.youtube.com", "player.vimeo.com"] },
    });
  });

  it("prefers normalized runtimePolicy hosts while preserving legacy fallback", () => {
    expect(
      resolveRootRuntimePolicy({
        allowedUrls: ["youtube.com"],
        runtimePolicy: {
          version: 1,
          network: { allowedHosts: ["https://nulldown.app/d/demo"] },
          drops: { read: "linked", write: "propose" },
        },
      }),
    ).toEqual({
      version: 1,
      network: { allowedHosts: ["nulldown.app"] },
      drops: { read: "linked", write: "propose" },
    });

    expect(resolveRootRuntimePolicy(undefined).network?.allowedHosts).toEqual([
      ...DEFAULT_RUNTIME_NETWORK_ALLOWLIST,
    ]);
  });

  it("validates root policy and conditional grants", () => {
    const policy = {
      version: 1,
      network: { allowedHosts: ["nulldown.app"] },
      nullplugs: {
        nd: {
          invoke: "conditional",
          capabilities: ["render"],
          maxGrants: [{ kind: "drop.diff.apply", scope: "branch" }],
        },
      },
      conditionalGrants: [
        {
          id: "approve-agent-patch",
          trigger: { kind: "ui.response", responseOf: "approval", field: "approved" },
          evaluator: { kind: "builtin.nullplug", id: "approval-policy" },
          maxGrant: { kind: "drop.diff.apply", scope: "branch" },
          onError: "deny",
        },
      ],
    };

    expect(isRootRuntimePolicy(policy)).toBe(true);
    expect(isConditionalGrant(policy.conditionalGrants[0])).toBe(true);
    expect(
      isConditionalGrant({
        ...policy.conditionalGrants[0],
        evaluator: { kind: "remote.nullplug", id: "remote" },
      }),
    ).toBe(false);
  });

  it("enforces requested grants within max grants", () => {
    expect(
      isRuntimeGrantWithinMaxGrant(
        { kind: "drop.diff.apply", scope: "branch" },
        { kind: "drop.diff.apply", scope: "branch" },
      ),
    ).toBe(true);
    expect(
      isRuntimeGrantWithinMaxGrant(
        { kind: "drop.diff.apply", scope: "root" },
        { kind: "drop.diff.apply", scope: "branch" },
      ),
    ).toBe(false);
    expect(
      isRuntimeGrantWithinMaxGrant(
        { kind: "nullplug.invoke", capabilities: ["render"] },
        { kind: "nullplug.invoke", capabilities: ["render", "policy.evaluate"] },
      ),
    ).toBe(true);
    expect(
      isRuntimeGrantWithinMaxGrant(
        { kind: "nullplug.invoke", capabilities: ["render", "network"] },
        { kind: "nullplug.invoke", capabilities: ["render"] },
      ),
    ).toBe(false);
  });

  it("validates policy decision values", () => {
    expect(
      isPolicyDecisionValue({
        decision: "allow",
        grant: { kind: "drop.diff.apply", scope: "branch" },
        reason: "approved",
      }),
    ).toBe(true);
    expect(isPolicyDecisionValue({ decision: "allow", grant: { kind: "bad" } })).toBe(
      false,
    );
  });
});
