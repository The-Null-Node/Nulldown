import createEditor from "./editor";
import useEditorStore from "../../stores/editorStore";
import { nullplug, parseNullplugBlocks } from "../nullplug";
import { computeDiffOps } from "../../../shared/nulledit/textDiff";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for editor render.");
};

describe("nulledit editor", () => {
  it("carries remote branch provenance into approval primitives", async () => {
    const editor = createEditor();
    editor.reset();
    editor.setRuntimeCaller({ dropId: "root-1", branchId: "branch-1" });

    try {
      editor.seedSnapshot(
        ['```approval(id="release-42")', "Approve release?", "```"].join("\n"),
      );
      await waitFor(
        () => useEditorStore.getState().renderFrame?.status === "final",
      );

      const state = useEditorStore.getState();
      expect(state.renderFrame).toEqual(
        expect.objectContaining({ rootDropId: "root-1", branchId: "branch-1" }),
      );
      expect(state.nullplugRenderState.uiPrimitives).toEqual([
        expect.objectContaining({
          id: "release-42",
          source: expect.objectContaining({
            rootDropId: "root-1",
            branchId: "branch-1",
            callId: "approval:release-42",
          }),
        }),
      ]);
    } finally {
      editor.reset();
    }
  });

  it("stores structured nullplug data from the winning render frame", async () => {
    nullplug("editor-structured-state-test", () => ({
      content: "Rendered action host",
      uiPrimitives: [
        {
          kind: "action",
          id: "approve",
          label: "Approve",
          source: {
            rootDropId: "root-1",
            branchId: "branch-1",
            callId: "call-1",
          },
        },
      ],
      uiState: { accepted: false },
      mutations: [
        {
          kind: "ui.state.patch",
          callId: "call-1",
          patch: [{ op: "set", path: ["accepted"], value: true }],
          reason: "User accepted.",
        },
      ],
      yields: [{ kind: "agent.note", value: "ready" }],
    }));

    const editor = createEditor();
    editor.reset();

    try {
      editor.seedSnapshot(
        ["before", "```editor-structured-state-test", "```", "after"].join(
          "\n",
        ),
      );
      await waitFor(
        () => useEditorStore.getState().renderFrame?.status === "final",
      );

      const state = useEditorStore.getState();
      expect(state.renderedMarkdown).toContain("Rendered action host");
      expect(state.renderFrame).toEqual(
        expect.objectContaining({
          renderedMarkdown: state.renderedMarkdown,
          status: "final",
          nullplugCalls: [
            expect.objectContaining({
              pluginId: "editor-structured-state-test",
              status: "resolved",
              callIds: ["call-1"],
            }),
          ],
          nullplugCallIds: ["call-1"],
        }),
      );
      expect(state.renderFrame?.sourceContentHash).toMatch(/^sha256:/);
      expect(state.renderFrame?.renderedContentHash).toMatch(/^sha256:/);
      expect(state.nullplugRenderState.uiPrimitives).toEqual([
        expect.objectContaining({ kind: "action", id: "approve" }),
      ]);
      expect(state.nullplugRenderState.uiState).toEqual({
        "call-1": { accepted: false },
      });
      expect(state.nullplugRenderState.mutations).toEqual([
        expect.objectContaining({ kind: "ui.state.patch", callId: "call-1" }),
      ]);
      expect(state.nullplugRenderState.yields).toEqual([
        { kind: "agent.note", value: "ready" },
      ]);
    } finally {
      editor.reset();
    }
  });

  it("invalidates structured state as soon as newer source arrives", async () => {
    let invocation = 0;
    let releaseRender: (() => void) | undefined;
    nullplug("editor-stale-frame-test", async () => {
      invocation += 1;
      if (invocation === 2) {
        await new Promise<void>((resolve) => {
          releaseRender = resolve;
        });
      }
      return {
        uiPrimitives: [
          {
            kind: "action",
            id: `action-${invocation}`,
            label: "Act",
            source: { callId: "stale-call" },
          },
        ],
      };
    });

    const editor = createEditor();
    editor.reset();
    const source = "```editor-stale-frame-test\n```";

    try {
      editor.seedSnapshot(source);
      await waitFor(
        () => useEditorStore.getState().renderFrame?.status === "final",
      );

      const firstFrameId = useEditorStore.getState().renderFrame?.frameId;
      const updatedSource = `updated\n${source}`;
      editor.addDiffs(computeDiffOps(source, updatedSource));

      expect(useEditorStore.getState().renderFrame).toEqual(
        expect.objectContaining({ frameId: firstFrameId, status: "stale" }),
      );
      expect(useEditorStore.getState().nullplugRenderState).toEqual({
        uiPrimitives: [],
        uiState: {},
        mutations: [],
        yields: [],
        diagnostics: [],
        callIds: [],
      });

      await waitFor(() => releaseRender !== undefined);
      expect(useEditorStore.getState().renderFrame?.status).toBe("stale");
      releaseRender?.();
      await waitFor(
        () => useEditorStore.getState().renderFrame?.status === "final",
      );

      expect(useEditorStore.getState().renderFrame).toEqual(
        expect.objectContaining({
          sourceMarkdown: updatedSource,
          status: "final",
        }),
      );
      expect(useEditorStore.getState().renderFrame?.frameId).not.toBe(
        firstFrameId,
      );
    } finally {
      releaseRender?.();
      editor.reset();
    }
  });

  it("stores empty and failed calls in the final frame", async () => {
    nullplug("editor-empty-provenance-test", () => ({}));
    nullplug("editor-failed-provenance-test", () => {
      throw new Error("editor invocation failed");
    });
    const editor = createEditor();
    editor.reset();

    try {
      editor.seedSnapshot(
        [
          "```editor-empty-provenance-test",
          "```",
          "```editor-failed-provenance-test",
          "```",
        ].join("\n"),
      );
      await waitFor(
        () => useEditorStore.getState().renderFrame?.status === "final",
      );

      const frame = useEditorStore.getState().renderFrame;
      expect(frame?.nullplugCalls).toEqual([
        expect.objectContaining({
          index: 0,
          pluginId: "editor-empty-provenance-test",
          status: "resolved",
          callIds: [],
        }),
        expect.objectContaining({
          index: 1,
          pluginId: "editor-failed-provenance-test",
          status: "failed",
          callIds: [],
          failure: expect.objectContaining({ code: "invoke_failed" }),
        }),
      ]);
      expect(frame?.nullplugCallIds).toEqual([]);
    } finally {
      editor.reset();
    }
  });

  it("applies the loaded root policy before invoking local nullplugs", async () => {
    let invoked = 0;
    nullplug("editor-policy-status-test", () => {
      invoked += 1;
      return "must not render";
    });
    const editor = createEditor();
    editor.reset();
    editor.setRuntimePolicy({
      version: 1,
      nullplugs: { "editor-policy-status-test": { invoke: "deny" } },
    });

    try {
      editor.seedSnapshot("```editor-policy-status-test\n```");
      await waitFor(
        () => useEditorStore.getState().renderFrame?.status === "final",
      );

      expect(invoked).toBe(0);
      expect(useEditorStore.getState().renderFrame?.nullplugCalls).toEqual([
        expect.objectContaining({
          pluginId: "editor-policy-status-test",
          status: "blocked",
          failure: expect.objectContaining({ code: "policy_denied" }),
        }),
      ]);
    } finally {
      editor.reset();
    }
  });

  it("preserves source ranges, repeated ids, and provider identity in the final frame", async () => {
    const primitive = (id: string) => ({
      kind: "action" as const,
      id,
      label: id,
      source: {
        rootDropId: "root",
        branchId: "branch",
        callId: "shared-call",
      },
    });
    nullplug("editor-local-provenance-test", () => ({
      uiPrimitives: [primitive("local")],
    }));
    const editor = createEditor({
      nullplugRuntime: {
        invoke: async (request) => ({
          result: { uiPrimitives: [primitive("remote")] },
          resolution: {
            pluginId: request.call.pluginId,
            version: "3.0.0",
            providerId: "remote-provider",
            baseUrl: "https://provider.test",
            scope: "remote" as const,
          },
        }),
      },
    });
    editor.reset();
    const source = [
      '<iframe src="https://example.com"></iframe>',
      "```editor-local-provenance-test",
      "```",
      "```editor-remote-provenance-test()",
      "```",
    ].join("\n");
    const blocks = parseNullplugBlocks(source);

    try {
      editor.seedSnapshot(source);
      await waitFor(
        () => useEditorStore.getState().renderFrame?.status === "final",
      );

      const frame = useEditorStore.getState().renderFrame;
      expect(frame?.nullplugCalls.map((call) => call.sourceRange)).toEqual(
        blocks.map((block) => ({ start: block.start, end: block.end })),
      );
      expect(frame?.nullplugCalls.map((call) => call.callIds)).toEqual([
        ["shared-call"],
        ["shared-call"],
      ]);
      expect(frame?.nullplugCalls[1]?.resolution).toEqual({
        pluginId: "editor-remote-provenance-test",
        version: "3.0.0",
        providerId: "remote-provider",
        baseUrl: "https://provider.test",
        scope: "remote",
      });
      expect(frame?.nullplugCallIds).toEqual(["shared-call"]);
    } finally {
      editor.reset();
    }
  });

  it("renders seeded content through the nullplug pipeline", async () => {
    nullplug("seed-render-test", () => "Rendered seed plugin\n");
    const editor = createEditor();
    editor.reset();

    const content = [
      "before",
      "```seed-render-test",
      "plugin body",
      "```",
      "after",
    ].join("\n");
    const snapshotId = editor.seedSnapshot(content);

    expect(useEditorStore.getState()).toEqual(
      expect.objectContaining({
        textContent: content,
        renderedMarkdown: "",
        renderStatus: "rendering",
        renderProgress: 0,
      }),
    );
    expect(editor.getSnapshotter().get(snapshotId)).toEqual(
      expect.objectContaining({
        content,
        renderedMarkdown: "",
        status: "pending",
      }),
    );
    expect(editor.getSnapshotter().list()).toHaveLength(0);

    await waitFor(() => useEditorStore.getState().renderStatus === "idle");

    expect(useEditorStore.getState()).toEqual(
      expect.objectContaining({
        textContent: content,
        renderedMarkdown: ["before", "Rendered seed plugin", "after"].join(
          "\n",
        ),
        renderStatus: "idle",
        renderProgress: 1,
      }),
    );
    expect(editor.getSnapshotter().get(snapshotId)).toEqual(
      expect.objectContaining({
        content,
        renderedMarkdown: ["before", "Rendered seed plugin", "after"].join(
          "\n",
        ),
        status: "rendered",
      }),
    );
    expect(editor.getSnapshotter().list()).toEqual([
      expect.objectContaining({ id: snapshotId }),
    ]);

    editor.reset();
  });
});
