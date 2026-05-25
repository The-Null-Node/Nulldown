import {
  applyNullplugUiStatePatch,
  isNullplugUiPrimitive,
  isNullplugUiResponseFact,
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
  nullplugUiResponseFactToYield,
  nullplugUiStatePatchFactKey,
  nullplugUiStateSnapshotKey,
} from "./ui";

const envelope = {
  version: 1 as const,
  events: [
    {
      eventId: "event-1",
      seq: 0,
      dropId: "drop-1",
      sourceClientId: "ui",
      createdAt: 123,
      ops: [{ type: "insert" as const, start: 0, end: 0, text: "accepted" }],
    },
  ],
};

describe("atomic nullplug UI DTOs", () => {
  it("validates form, action, and card primitives", () => {
    expect(
      isNullplugUiPrimitive({
        kind: "form",
        id: "approval-form",
        title: "Approve patch",
        fields: [
          { name: "approved", type: "boolean", label: "Approve?" },
          {
            name: "reason",
            type: "select",
            options: [
              { label: "Looks good", value: "ok" },
              { label: "Needs work", value: "revise" },
            ],
          },
        ],
        source: { rootDropId: "root", branchId: "branch", snapshotId: 1 },
      }),
    ).toBe(true);
    expect(
      isNullplugUiPrimitive({
        kind: "action",
        id: "run-agent",
        label: "Run agent",
        requiresConfirmation: true,
      }),
    ).toBe(true);
    expect(
      isNullplugUiPrimitive({
        kind: "card",
        id: "status-card",
        title: "Status",
        actions: [{ kind: "action", id: "retry", label: "Retry" }],
      }),
    ).toBe(true);
    expect(isNullplugUiPrimitive({ kind: "form", id: "bad", fields: [{}] })).toBe(
      false,
    );
  });

  it("validates UI response facts with optional proposed diffs", () => {
    expect(
      isNullplugUiResponseFact({
        version: 1,
        kind: "ui.response",
        id: "response-1",
        primitiveId: "approval-form",
        createdAt: 123,
        source: { rootDropId: "root", branchId: "branch", snapshotId: 1 },
        data: { approved: true, reason: "ok" },
        proposedDiffs: envelope,
      }),
    ).toBe(true);
    expect(
      isNullplugUiResponseFact({
        version: 1,
        kind: "ui.response",
        id: "response-1",
        primitiveId: "approval-form",
        createdAt: 123,
        source: { rootDropId: "root" },
        data: { approved: undefined },
      }),
    ).toBe(false);
  });

  it("converts response facts to ui.response yields", () => {
    const fact = {
      version: 1 as const,
      kind: "ui.response" as const,
      id: "response-1",
      primitiveId: "approval-form",
      createdAt: 123,
      source: { rootDropId: "root", branchId: "branch" },
      data: { approved: true },
      metadata: { actor: "human" },
    };

    expect(nullplugUiResponseFactToYield(fact)).toEqual({
      id: "response-1",
      kind: "ui.response",
      value: fact,
      createdAt: 123,
      metadata: { actor: "human" },
    });
    expect(() =>
      nullplugUiResponseFactToYield({ ...fact, data: { approved: undefined } }),
    ).toThrow("Invalid nullplug UI response fact.");
  });

  it("validates and keys nullplug UI state facts", () => {
    const patchFact = {
      version: 1 as const,
      kind: "ui.state.patch" as const,
      id: "patch-1",
      callId: "call-1",
      createdAt: 124,
      source: { rootDropId: "root", branchId: "branch", callId: "call-1" },
      patch: [
        { op: "set" as const, path: ["form", "open"], value: true },
        { op: "delete" as const, path: ["pending"] },
      ],
      reason: "response applied",
    };
    const snapshot = {
      version: 1 as const,
      kind: "ui.state.snapshot" as const,
      id: "snapshot-1",
      callId: "call-1",
      createdAt: 125,
      source: { rootDropId: "root", branchId: "branch", callId: "call-1" },
      state: { form: { open: true } },
      patchIds: ["patch-1"],
    };

    expect(isNullplugUiStatePatchFact(patchFact)).toBe(true);
    expect(isNullplugUiStateSnapshot(snapshot)).toBe(true);
    expect(nullplugUiStatePatchFactKey(patchFact)).toBe(
      "__nullplug_ui_state_patch_fact__/root/branch/call-1/patch-1.json",
    );
    expect(nullplugUiStateSnapshotKey(snapshot)).toBe(
      "__nullplug_ui_state_snapshot__/root/branch/call-1/snapshot-1.json",
    );
    expect(
      applyNullplugUiStatePatch(
        { pending: true, form: { open: false } },
        patchFact.patch,
      ),
    ).toEqual({ form: { open: true } });
    expect(
      isNullplugUiStatePatchFact({ ...patchFact, patch: [{ op: "delete", path: [] }] }),
    ).toBe(false);
  });
});
