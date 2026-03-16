import {
  applyRenderableDiffs,
  parseNullplugBlocks,
  parsePluginId,
  renderMarkdownWithNullplug,
} from "./index";

describe("nullplug render pipeline", () => {
  it("parses plugin identifiers from fenced code info", () => {
    expect(parsePluginId('plugin("embed")')).toBe("embed");
    expect(parsePluginId("plugin('EMBED')")).toBe("embed");
    expect(parsePluginId("plugin(embed)")).toBeNull();
  });

  it("finds plugin blocks in markdown", () => {
    const markdown = [
      "before",
      "```plugin(\"embed\")",
      "https://www.youtube.com/embed/demo",
      "```",
      "after",
    ].join("\n");

    const blocks = parseNullplugBlocks(markdown);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe("embed");
    expect(blocks[0]?.content.trim()).toBe("https://www.youtube.com/embed/demo");
  });

  it("renders embed plugin blocks into iframe markup", async () => {
    const markdown = [
      "```plugin(\"embed\")",
      "https://www.youtube.com/embed/demo",
      "```",
    ].join("\n");

    const rendered = await renderMarkdownWithNullplug(markdown, {
      allowedUrls: ["www.youtube.com"],
    });

    expect(rendered).toContain('<iframe src="https://www.youtube.com/embed/demo"');
    expect(rendered).not.toContain("```plugin");
  });

  it("escapes raw iframe html authored in markdown", async () => {
    const markdown =
      '<iframe src="https://www.youtube.com/embed/demo"></iframe>';

    const rendered = await renderMarkdownWithNullplug(markdown, {
      allowedUrls: ["www.youtube.com"],
    });

    expect(rendered).toContain("&lt;iframe");
    expect(rendered).toContain("&lt;/iframe&gt;");
  });

  it("keeps unknown plugin blocks intact", async () => {
    const markdown = [
      "```plugin(\"unknown\")",
      "hello",
      "```",
    ].join("\n");

    const rendered = await renderMarkdownWithNullplug(markdown);
    expect(rendered).toContain("```plugin(\"unknown\")");
  });

  it("applies renderable diffs in descending order", () => {
    const source = "abcde";
    const patched = applyRenderableDiffs(source, [
      { start: 1, end: 2, text: "X" },
      { start: 3, end: 5, text: "YZ" },
    ]);

    expect(patched).toBe("aXcYZ");
  });
});
