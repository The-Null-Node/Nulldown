import type {
  EditorNullplugRenderState,
  EditorRenderFrame,
} from "../../stores/editorStore";
import {
  readJsonPath,
  selectNullplugRuntime,
} from "./reactRuntime";

const createFrame = (): EditorRenderFrame => ({
  frameId: "render:1:1",
  rootDropId: "root-1",
  branchId: "branch-1",
  versionId: 4,
  sourceMarkdown: "source",
  renderedMarkdown: "rendered",
  sourceContentHash: "sha256:source",
  renderedContentHash: "sha256:rendered",
  acceptedDiffRefs: [],
  resolverRefs: [],
  nullplugCallIds: ["call-1", "call-2"],
  diagnostics: [],
  status: "final",
});

const createRenderState = (): EditorNullplugRenderState => ({
  uiPrimitives: [
    {
      kind: "action",
      id: "approve",
      label: "Approve",
      source: { rootDropId: "root-1", branchId: "branch-1", callId: "call-1" },
    },
    {
      kind: "action",
      id: "reject",
      label: "Reject",
      source: { rootDropId: "root-1", branchId: "branch-1", callId: "call-2" },
    },
  ],
  uiState: {
    call1Only: false,
    "call-1": { nested: { approved: true } },
  },
  mutations: [
    {
      kind: "ui.state.patch",
      callId: "call-1",
      patch: [{ op: "set", path: ["nested", "approved"], value: true }],
    },
    {
      kind: "ui.state.patch",
      callId: "call-2",
      patch: [{ op: "set", path: ["nested", "approved"], value: false }],
    },
  ],
  yields: [
    { kind: "agent.note", value: "call 1", metadata: { callId: "call-1" } },
    { kind: "agent.note", value: "call 2", metadata: { callId: "call-2" } },
  ],
  diagnostics: [{ level: "info", message: "ready" }],
  callIds: ["call-1", "call-2"],
});

describe("nullplug React runtime selectors", () => {
  it("reads path-scoped JSON state", () => {
    expect(readJsonPath({ a: { b: true } }, ["a", "b"])).toBe(true);
    expect(readJsonPath({ a: { b: true } }, ["a", "c"])).toBeUndefined();
  });

  it("selects call-scoped primitives, state, mutations, yields, and refs", () => {
    const selected = selectNullplugRuntime(createRenderState(), createFrame(), {
      callId: "call-1",
      path: ["nested", "approved"],
    });

    expect(selected.status).toBe("ready");
    expect(selected.callId).toBe("call-1");
    expect(selected.primitives.map((primitive) => primitive.id)).toEqual([
      "approve",
    ]);
    expect(selected.state).toEqual({ nested: { approved: true } });
    expect(selected.stateValue).toBe(true);
    expect(selected.mutations).toHaveLength(1);
    expect(selected.yields).toEqual([
      { kind: "agent.note", value: "call 1", metadata: { callId: "call-1" } },
    ]);
    expect(selected.refs).toEqual(
      expect.objectContaining({
        frameId: "render:1:1",
        rootDropId: "root-1",
        branchId: "branch-1",
        versionId: 4,
        callId: "call-1",
      }),
    );
  });

  it("falls back to document scope when no render frame exists", () => {
    const selected = selectNullplugRuntime(
      {
        uiPrimitives: [],
        uiState: {},
        mutations: [],
        yields: [],
        diagnostics: [],
        callIds: [],
      },
      null,
    );

    expect(selected.status).toBe("idle");
    expect(selected.callId).toBe("document");
    expect(selected.refs).toEqual({ callId: "document" });
  });
});
