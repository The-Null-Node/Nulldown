import {
  isNullplugInvokeRequest,
  isNullplugInvokeResponse,
  isNullplugResult,
} from "./types";

const envelope = {
  version: 1 as const,
  events: [
    {
      eventId: "event-1",
      seq: 0,
      dropId: "drop-1",
      sourceClientId: "plugin",
      createdAt: 123,
      ops: [{ type: "insert" as const, start: 0, end: 0, text: "hello" }],
    },
  ],
};

describe("nullplug shared DTOs", () => {
  it("validates normalized results with mutations and yields", () => {
    expect(
      isNullplugResult({
        content: "Rendered content",
        uiPrimitives: [
          {
            kind: "action",
            id: "approve",
            label: "Approve",
            source: { rootDropId: "root", branchId: "branch", callId: "call-1" },
          },
        ],
        uiState: { expanded: true },
        metadata: { source: "test" },
        mutations: [
          { kind: "drop.diff.propose", envelope, reason: "suggest edit" },
          { kind: "drop.diff.apply", envelope, grantId: "grant-1" },
          { kind: "metadata.patch", patch: { title: "New" } },
          {
            kind: "ui.state.patch",
            callId: "call-1",
            patch: [{ op: "set", path: ["expanded"], value: true }],
            reason: "keep UI open",
          },
          { kind: "sidecar.write", target: "sidecar:key", value: ["note"] },
        ],
        yields: [
          { kind: "ui.response", value: { selected: "yes" }, createdAt: 123 },
          { kind: "policy.decision", value: "deferred" },
          { kind: "stream.event", value: { streamId: "stream-1" } },
          { kind: "agent.note", value: "done" },
        ],
        streams: [{ id: "stream-1", kind: "render", status: "running" }],
        calls: [
          {
            pluginId: "child",
            args: { id: "drop-2" },
            caller: { dropId: "drop-1" },
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects invalid result DTOs", () => {
    expect(isNullplugResult({ text: "legacy patch" })).toBe(false);
    expect(
      isNullplugResult({
        mutations: [{ kind: "drop.diff.apply", envelope }],
      }),
    ).toBe(false);
    expect(
      isNullplugResult({
        yields: [{ kind: "unknown", value: "bad" }],
      }),
    ).toBe(false);
    expect(
      isNullplugResult({
        uiPrimitives: [{ kind: "action", id: "bad" }],
      }),
    ).toBe(false);
    expect(
      isNullplugResult({
        mutations: [{ kind: "ui.state.patch", callId: "call-1", patch: [] }],
      }),
    ).toBe(false);
  });

  it("validates remote invoke DTOs", () => {
    expect(
      isNullplugInvokeRequest({
        call: {
          pluginId: "remote",
          args: { id: "drop-1" },
          caller: { dropId: "root", branchId: "clone" },
        },
        context: {
          providerId: "provider-1",
          baseUrl: "https://provider.example",
          capabilities: ["render"],
          rootPolicyRef: "policy-1",
        },
      }),
    ).toBe(true);
    expect(
      isNullplugInvokeResponse({
        result: { content: "ok" },
        diagnostics: [{ level: "info", message: "rendered" }],
      }),
    ).toBe(true);
    expect(isNullplugInvokeResponse({ result: { text: "bad" } })).toBe(false);
  });
});
