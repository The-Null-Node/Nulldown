import { jest } from "@jest/globals";
import useEditorStore from "../../stores/editorStore";
import type {
  EditorNullplugRenderState,
  EditorRenderFrame,
} from "../../stores/editorStore";
import type { DropBranchRuntimeFact } from "../../../shared/drop/diff";
import {
  applyBranchRuntimeFacts,
  areNullplugRuntimeSelectionsEqual,
  readJsonPath,
  selectNullplugProviderStatuses,
  selectNullplugRuntime,
  selectNullplugStatePath,
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
  nullplugCalls: [
    {
      index: 0,
      sourceRange: { start: 0, end: 10 },
      pluginId: "approval",
      resolution: {
        pluginId: "approval",
        version: "1.2.0",
        providerId: "local-provider",
        baseUrl: "browser://local",
        scope: "local",
      },
      status: "resolved",
      callIds: ["call-1"],
      diagnostics: [],
    },
    {
      index: 1,
      sourceRange: { start: 11, end: 20 },
      pluginId: "approval",
      resolution: {
        pluginId: "approval",
        providerId: "remote-provider",
        baseUrl: "https://provider.test",
        scope: "remote",
      },
      status: "blocked",
      callIds: [],
      diagnostics: [
        {
          level: "warn",
          code: "policy_conditional",
          message: "Approval is required.",
        },
      ],
      failure: {
        code: "policy_conditional",
        message: "Approval is required.",
      },
    },
  ],
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

const createRuntimeFact = (
  fact: DropBranchRuntimeFact["fact"],
  overrides: Partial<DropBranchRuntimeFact> = {},
): DropBranchRuntimeFact => ({
  version: 1,
  rootDropId: "root-1",
  branchId: "branch-1",
  seq: 1,
  factId: `${fact.kind}:${fact.id}`,
  createdAt: 10,
  fact,
  ...overrides,
});

describe("nullplug React runtime selectors", () => {
  it("applies branch-scoped state and response facts to the current final frame", () => {
    const state = createRenderState();
    const frame = createFrame();
    const facts: DropBranchRuntimeFact[] = [
      createRuntimeFact({
        version: 1,
        kind: "ui.state.snapshot",
        id: "snapshot-1",
        callId: "call-1",
        createdAt: 1,
        source: {
          rootDropId: "root-1",
          branchId: "branch-1",
          snapshotId: 4,
          callId: "call-1",
        },
        state: { approved: false },
      }),
      createRuntimeFact({
        version: 1,
        kind: "ui.state.patch",
        id: "patch-1",
        callId: "call-1",
        createdAt: 2,
        source: {
          rootDropId: "root-1",
          branchId: "branch-1",
          snapshotId: 4,
          callId: "call-1",
        },
        patch: [{ op: "set", path: ["reason"], value: "approved remotely" }],
      }),
      createRuntimeFact({
        version: 1,
        kind: "ui.response",
        id: "response-1",
        primitiveId: "approve",
        createdAt: 3,
        source: {
          rootDropId: "root-1",
          branchId: "branch-1",
          snapshotId: 4,
          callId: "call-1",
        },
        data: { approved: true },
      }),
    ];

    const next = applyBranchRuntimeFacts(state, frame, facts);
    expect(next.uiState["call-1"]).toEqual({
      approved: false,
      reason: "approved remotely",
    });
    expect(next.yields).toContainEqual(
      expect.objectContaining({
        id: "response-1",
        kind: "ui.response",
        metadata: { callId: "call-1" },
      }),
    );
    expect(applyBranchRuntimeFacts(next, frame, facts)).toBe(next);
  });

  it("rejects facts for stale, mismatched, or absent calls", () => {
    const state = createRenderState();
    const frame = createFrame();
    const validFact = {
      version: 1 as const,
      kind: "ui.state.patch" as const,
      id: "patch-1",
      callId: "call-1",
      createdAt: 1,
      source: {
        rootDropId: "root-1",
        branchId: "branch-1",
        snapshotId: 4,
        callId: "call-1",
      },
      patch: [{ op: "set" as const, path: ["approved"], value: true }],
    };

    expect(
      applyBranchRuntimeFacts(state, frame, [
        createRuntimeFact(validFact, { branchId: "other-branch" }),
        createRuntimeFact({
          ...validFact,
          id: "wrong-snapshot",
          source: { ...validFact.source, snapshotId: 5 },
        }),
        createRuntimeFact({
          ...validFact,
          id: "missing-call",
          callId: "call-missing",
          source: { ...validFact.source, callId: "call-missing" },
        }),
      ]),
    ).toBe(state);

    expect(
      applyBranchRuntimeFacts(state, { ...frame, status: "stale" }, [
        createRuntimeFact(validFact),
      ]),
    ).toBe(state);
  });

  it("reads path-scoped JSON state", () => {
    expect(readJsonPath({ a: { b: true } }, ["a", "b"])).toBe(true);
    expect(readJsonPath({ a: { b: true } }, ["a", "c"])).toBeUndefined();
  });

  it("selects call-scoped primitives, state, mutations, yields, and refs", () => {
    const renderState = createRenderState();
    renderState.uiPrimitives.push({
      kind: "card",
      id: "nested-card",
      actions: [
        {
          kind: "action",
          id: "nested-approve",
          label: "Nested approve",
          source: {
            rootDropId: "root-1",
            branchId: "branch-1",
            callId: "call-1",
          },
        },
      ],
    });
    const selected = selectNullplugRuntime(renderState, createFrame(), {
      callId: "call-1",
    });

    expect(selected.status).toBe("ready");
    expect(selected.callId).toBe("call-1");
    expect(selected.primitives.map((primitive) => primitive.id)).toEqual([
      "approve",
      "nested-card",
    ]);
    expect(selected.providerStatuses).toEqual([
      expect.objectContaining({
        pluginId: "approval",
        status: "ready",
        scope: "local",
        providerId: "local-provider",
        version: "1.2.0",
      }),
    ]);
    expect(selected.diagnostics).toEqual([]);
    expect(selected.state).toEqual({ nested: { approved: true } });
    expect(
      selectNullplugStatePath(createRenderState(), {
        callId: "call-1",
        path: ["nested", "approved"],
      }),
    ).toBe(true);
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

  it("derives ordered ready, blocked, conditional, and failed provider status", () => {
    const baseCall = createFrame().nullplugCalls[0]!;
    const statuses = selectNullplugProviderStatuses([
      baseCall,
      {
        ...baseCall,
        index: 1,
        status: "blocked",
        callIds: [],
        failure: { code: "policy_denied", message: "Denied." },
      },
      {
        ...baseCall,
        index: 2,
        status: "blocked",
        callIds: [],
        resolution: {
          ...baseCall.resolution,
          providerId: "remote-provider",
          scope: "remote",
        },
        failure: {
          code: "policy_conditional",
          message: "Approval is required.",
        },
      },
      {
        ...baseCall,
        index: 3,
        status: "failed",
        callIds: ["call-1"],
        failure: { code: "provider_transport_failed", message: "Offline." },
      },
    ]);

    expect(statuses.map((entry) => entry.status)).toEqual([
      "ready",
      "blocked",
      "conditional",
      "failed",
    ]);
    expect(statuses[2]).toEqual(
      expect.objectContaining({
        index: 2,
        scope: "remote",
        providerId: "remote-provider",
        code: "policy_conditional",
        message: "Approval is required.",
      }),
    );
  });

  it("keeps unsupported calls unresolved instead of inventing provider identity", () => {
    const call = createFrame().nullplugCalls[0]!;
    const { resolution: _resolution, ...unresolvedCall } = call;
    const [status] = selectNullplugProviderStatuses([
      {
        ...unresolvedCall,
        status: "failed",
        failure: {
          code: "unsupported_plugin",
          message: "No resolver accepted missing.",
        },
      },
    ]);

    expect(status).toEqual(
      expect.objectContaining({
        effectivePluginId: call.pluginId,
        providerId: undefined,
        scope: undefined,
      }),
    );
  });

  it("preserves repeated call ids and keeps zero-output outcomes in broad status", () => {
    const calls = createFrame().nullplugCalls;
    const repeated = { ...calls[0]!, index: 2 };

    expect(selectNullplugProviderStatuses([...calls, repeated])).toHaveLength(3);
    expect(
      selectNullplugProviderStatuses([...calls, repeated], "call-1").map(
        (entry) => entry.index,
      ),
    ).toEqual([0, 2]);
  });

  it("treats element-identical call selections as equal", () => {
    const renderState = createRenderState();
    const frame = createFrame();
    const first = selectNullplugRuntime(renderState, frame, {
      callId: "call-1",
    });
    const equivalent = selectNullplugRuntime(
      {
        ...renderState,
        uiPrimitives: [...renderState.uiPrimitives],
        mutations: [...renderState.mutations],
        yields: [...renderState.yields],
        diagnostics: [...renderState.diagnostics],
        callIds: [...renderState.callIds],
      },
      { ...frame },
      { callId: "call-1" },
    );

    expect(areNullplugRuntimeSelectionsEqual(first, equivalent)).toBe(true);

    const changed = selectNullplugRuntime(
      {
        ...renderState,
        uiState: {
          ...renderState.uiState,
          "call-1": { nested: { approved: false } },
        },
      },
      frame,
      { callId: "call-1" },
    );
    expect(areNullplugRuntimeSelectionsEqual(first, changed)).toBe(false);

    const unrelatedCallChanged = selectNullplugRuntime(
      renderState,
      {
        ...frame,
        nullplugCalls: [
          frame.nullplugCalls[0]!,
          {
            ...frame.nullplugCalls[1]!,
            diagnostics: [
              {
                level: "error",
                code: "policy_denied",
                message: "Now denied.",
              },
            ],
            failure: {
              code: "policy_denied",
              message: "Now denied.",
            },
          },
        ],
      },
      { callId: "call-1" },
    );
    expect(areNullplugRuntimeSelectionsEqual(first, unrelatedCallChanged)).toBe(
      true,
    );
  });

  it("keeps explicit missing calls isolated from document state", () => {
    const renderState = createRenderState();
    const first = selectNullplugRuntime(renderState, createFrame(), {
      callId: "missing-call",
    });
    const second = selectNullplugRuntime(renderState, createFrame(), {
      callId: "missing-call",
    });

    expect(first.state).toEqual({});
    expect(areNullplugRuntimeSelectionsEqual(first, second)).toBe(true);
    expect(
      selectNullplugStatePath(renderState, {
        callId: "missing-call",
        path: ["call1Only"],
      }),
    ).toBeUndefined();
  });

  it("does not expose call outcomes from a stale frame", () => {
    const selection = selectNullplugRuntime(
      createRenderState(),
      { ...createFrame(), status: "stale" },
      { callId: "call-1" },
    );

    expect(selection.status).toBe("resolving");
    expect(selection.providerStatuses).toEqual([]);
    expect(selection.diagnostics).toEqual([]);
  });

  it("applies broad call equality to selector subscriptions", () => {
    const renderState = createRenderState();
    const frame = createFrame();
    useEditorStore.getState().setNullplugRenderState(renderState);
    useEditorStore.getState().setRenderFrame(frame);
    const listener = jest.fn();
    const unsubscribe = useEditorStore.subscribe(
      (state) =>
        selectNullplugRuntime(state.nullplugRenderState, state.renderFrame, {
          callId: "call-1",
        }),
      listener,
      { equalityFn: areNullplugRuntimeSelectionsEqual },
    );

    try {
      useEditorStore.getState().setTextContent("unrelated edit");
      useEditorStore.getState().setRenderProgress(0.5);
      useEditorStore.getState().setNullplugRenderState({
        ...renderState,
        uiPrimitives: [
          ...renderState.uiPrimitives,
          {
            kind: "action",
            id: "call-2-extra",
            label: "Call 2 extra",
            source: {
              rootDropId: "root-1",
              branchId: "branch-1",
              callId: "call-2",
            },
          },
        ],
        uiState: {
          ...renderState.uiState,
          "call-2": { changed: true },
        },
      });

      expect(listener).not.toHaveBeenCalled();

      useEditorStore.getState().setNullplugRenderState({
        ...renderState,
        uiState: {
          ...renderState.uiState,
          "call-1": { nested: { approved: false } },
        },
      });
      expect(listener).toHaveBeenCalledTimes(1);

      useEditorStore.getState().setRenderFrame({ ...frame, status: "error" });
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      useEditorStore.getState().clearStructuredRenderState();
      useEditorStore.getState().setTextContent("");
      useEditorStore.getState().setRenderProgress(1);
    }
  });

  it("notifies a path subscriber only when its observed leaf changes", () => {
    const renderState = createRenderState();
    const options = {
      callId: "call-1",
      path: ["nested", "approved"],
    } as const;
    useEditorStore.getState().setNullplugRenderState(renderState);
    const listener = jest.fn();
    const unsubscribe = useEditorStore.subscribe(
      (state) => selectNullplugStatePath(state.nullplugRenderState, options),
      listener,
    );

    try {
      useEditorStore.getState().setTextContent("unrelated edit");
      useEditorStore.getState().setRenderProgress(0.5);
      useEditorStore.getState().setNullplugRenderState({
        ...renderState,
        uiState: {
          ...renderState.uiState,
          "call-2": { nested: { approved: false } },
        },
      });
      useEditorStore.getState().setNullplugRenderState({
        ...renderState,
        uiState: {
          ...renderState.uiState,
          "call-1": {
            nested: { approved: true },
            unobserved: "changed",
          },
        },
      });

      expect(listener).not.toHaveBeenCalled();

      useEditorStore.getState().setNullplugRenderState({
        ...renderState,
        uiState: {
          ...renderState.uiState,
          "call-1": { nested: { approved: false } },
        },
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(false, true);
    } finally {
      unsubscribe();
      useEditorStore.getState().clearStructuredRenderState();
      useEditorStore.getState().setTextContent("");
      useEditorStore.getState().setRenderProgress(1);
    }
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
