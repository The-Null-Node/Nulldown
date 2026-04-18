import {
  applyRenderableDiffs,
  parseNullplugBlocks,
  parsePluginId,
  parsePluginInvocation,
  renderMarkdownWithNullplug,
} from "./index";

describe("nullplug render pipeline", () => {
  it("parses plugin identifiers from fenced code info", () => {
    expect(parsePluginId('plugin("embed")')).toBe("embed");
    expect(parsePluginId("plugin('EMBED')")).toBe("embed");
    expect(parsePluginId("embed")).toBe("embed");
    expect(parsePluginId("embed(src='https://www.youtube.com/embed/demo')")).toBe(
      "embed",
    );
    expect(parsePluginId("embed(")).toBeNull();
  });

  it("parses keyword fence arguments", () => {
    expect(parsePluginInvocation("embed")).toEqual({
      id: "embed",
      args: null,
    });
    expect(parsePluginInvocation("embed(src='https://example.com')")).toEqual({
      id: "embed",
      args: "src='https://example.com'",
    });
    expect(parsePluginInvocation("embed()")).toEqual({
      id: "embed",
      args: null,
    });
  });

  it("finds plugin blocks in markdown", () => {
    const markdown = [
      "before",
      "```embed",
      "https://www.youtube.com/embed/demo",
      "```",
      "after",
    ].join("\n");

    const blocks = parseNullplugBlocks(markdown);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe("embed");
    expect(blocks[0]?.args).toBeNull();
    expect(blocks[0]?.content.trim()).toBe("https://www.youtube.com/embed/demo");
  });

  it("captures keyword arguments in parsed blocks", () => {
    const markdown = ["```embed(src='https://example.com')", "body", "```"].join(
      "\n",
    );

    const blocks = parseNullplugBlocks(markdown);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe("embed");
    expect(blocks[0]?.args).toBe("src='https://example.com'");
  });

  it("renders embed plugin blocks into iframe markup", async () => {
    const markdown = [
      "```embed",
      "https://www.youtube.com/embed/demo",
      "```",
    ].join("\n");

    const rendered = await renderMarkdownWithNullplug(markdown, {
      allowedUrls: ["www.youtube.com"],
    });

    expect(rendered).toContain('<iframe src="https://www.youtube.com/embed/demo"');
    expect(rendered).not.toContain("```embed");
  });

  it("renders embed blocks from invocation arguments", async () => {
    const markdown = ["```embed(src='https://www.youtube.com/embed/demo')", "```"].join(
      "\n",
    );

    const rendered = await renderMarkdownWithNullplug(markdown, {
      allowedUrls: ["www.youtube.com"],
    });

    expect(rendered).toContain('<iframe src="https://www.youtube.com/embed/demo"');
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
      "```unknown",
      "hello",
      "```",
    ].join("\n");

    const rendered = await renderMarkdownWithNullplug(markdown);
    expect(rendered).toContain("```unknown");
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
