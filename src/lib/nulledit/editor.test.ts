import createEditor from "./editor";
import useEditorStore from "../../stores/editorStore";
import { nullplug } from "../nullplug";

const waitForQueuedRender = async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

describe("nulledit editor", () => {
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

    await waitForQueuedRender();

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
