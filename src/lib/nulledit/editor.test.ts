import createEditor from "./editor";
import useEditorStore from "../../stores/editorStore";
import { nullplug } from "../nullplug";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for editor render.");
};

describe("nulledit editor nullplug render state", () => {
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
      await waitFor(() => useEditorStore.getState().renderFrame?.status === "final");

      const state = useEditorStore.getState();
      expect(state.renderedMarkdown).toContain("Rendered action host");
      expect(state.renderFrame).toEqual(
        expect.objectContaining({
          renderedMarkdown: state.renderedMarkdown,
          status: "final",
          nullplugCallIds: ["call-1"],
        }),
      );
      expect(state.renderFrame?.sourceContentHash).toMatch(/^sha256:/);
      expect(state.renderFrame?.renderedContentHash).toMatch(/^sha256:/);
      expect(state.nullplugRenderState.uiPrimitives).toEqual([
        expect.objectContaining({ kind: "action", id: "approve" }),
      ]);
      expect(state.nullplugRenderState.uiState).toEqual({ accepted: false });
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
});
