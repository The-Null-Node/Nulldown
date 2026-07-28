import { renderMarkdownWithNullplugState } from "../renderPipeline";

describe("approval nullplug", () => {
  it("renders a branch-scoped non-mutating approval form", async () => {
    const result = await renderMarkdownWithNullplugState(
      [
        "Before",
        '```approval(id="release-42")',
        "Approve the production release?",
        "```",
        "After",
      ].join("\n"),
      {
        caller: {
          dropId: "root-1",
          branchId: "branch-1",
          snapshotId: 8,
        },
      },
    );

    expect(result.markdown).toBe("Before\nAfter");
    expect(result.uiPrimitives).toEqual([
      expect.objectContaining({
        kind: "form",
        id: "release-42",
        description: "Approve the production release?",
        source: {
          rootDropId: "root-1",
          branchId: "branch-1",
          callId: "approval:release-42",
        },
      }),
    ]);
    expect(result.uiPrimitives[0]).toEqual(
      expect.objectContaining({
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: "approved",
            defaultValue: false,
          }),
        ]),
      }),
    );
    expect(result.mutations).toEqual([]);
  });

  it("requires a stable explicit id", async () => {
    const result = await renderMarkdownWithNullplugState(
      ["```approval", "Approve this?", "```"].join("\n"),
    );

    expect(result.markdown).toContain("Invalid approval block");
    expect(result.uiPrimitives).toEqual([]);
  });
});
