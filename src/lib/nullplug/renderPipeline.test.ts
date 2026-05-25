import {
  applyRenderableDiffs,
  nullplug,
  parseNullplugBlocks,
  parsePluginId,
  parsePluginInvocation,
  renderMarkdownWithNullplug,
  renderMarkdownWithNullplugState,
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

  it("renders nd plugin blocks into drop cards", async () => {
    const markdown = ["```nd(id=\"abc123def456\")", "```"].join("\n");

    const rendered = await renderMarkdownWithNullplug(markdown, {
      resolveDrop: async (id) => ({
        content: `# Linked Drop ${id}\n\nThis is the card preview body.`,
        metadata: {
          rootDropId: "root12345678",
          snapshotId: 4,
        },
      }),
    });

    expect(rendered).toContain('class="nd-card');
    expect(rendered).toContain("Linked Drop abc123def456");
    expect(rendered).toContain("This is the card preview body.");
    expect(rendered).toContain('/d/abc123');
    expect(rendered).not.toContain("```nd");
  });

  it("renders nd plugin blocks from body syntax", async () => {
    const markdown = ["```nd", "body123", "```"].join("\n");

    const rendered = await renderMarkdownWithNullplug(markdown, {
      resolveDrop: async () => ({
        content: "# Body Syntax",
      }),
    });

    expect(rendered).toContain("Body Syntax");
    expect(rendered).toContain('/d/body12');
  });

  it("renders normalized NullplugResult content", async () => {
    nullplug("result-test", () => ({
      content: "**Rendered from result**",
      yields: [{ kind: "agent.note", value: "normalized" }],
    }));

    const rendered = await renderMarkdownWithNullplug(
      ["before", "```result-test", "```", "after"].join("\n"),
    );

    expect(rendered).toContain("**Rendered from result**");
    expect(rendered).not.toContain("```result-test");
  });

  it("returns structured nullplug UI data without changing markdown compatibility", async () => {
    nullplug("ui-test", () => ({
      content: "Rendered UI host",
      uiPrimitives: [
        {
          kind: "action",
          id: "approve",
          label: "Approve",
          source: { rootDropId: "root", branchId: "branch", callId: "call-1" },
        },
      ],
      uiState: { expanded: true },
      yields: [{ kind: "agent.note", value: "ui ready" }],
    }));

    const result = await renderMarkdownWithNullplugState(
      ["before", "```ui-test", "```", "after"].join("\n"),
    );

    expect(result.markdown).toContain("Rendered UI host");
    expect(result.uiPrimitives).toEqual([
      expect.objectContaining({ kind: "action", id: "approve" }),
    ]);
    expect(result.uiState).toEqual({ expanded: true });
    expect(result.yields).toEqual([{ kind: "agent.note", value: "ui ready" }]);
    await expect(
      renderMarkdownWithNullplug(["```ui-test", "```"].join("\n")),
    ).resolves.toContain("Rendered UI host");
  });

  it("keeps denied nullplug blocks unrendered under root policy", async () => {
    nullplug("policy-denied-test", () => "should not render");

    const rendered = await renderMarkdownWithNullplug(
      ["before", "```policy-denied-test", "```", "after"].join("\n"),
      {
        runtimePolicy: {
          version: 1,
          nullplugs: { "policy-denied-test": { invoke: "deny" } },
        },
      },
    );

    expect(rendered).toContain("```policy-denied-test");
    expect(rendered).not.toContain("should not render");
  });

  it("uses root policy network hosts for nullplug rendering", async () => {
    const markdown = [
      "```embed",
      "https://www.youtube.com/embed/demo",
      "```",
    ].join("\n");

    const rendered = await renderMarkdownWithNullplug(markdown, {
      allowedUrls: ["www.youtube.com"],
      runtimePolicy: { version: 1, network: { allowedHosts: [] } },
    });

    expect(rendered).toContain("Blocked embed from untrusted host.");
    expect(rendered).not.toContain("<iframe");
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
