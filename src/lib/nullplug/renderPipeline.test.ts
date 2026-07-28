import { jest } from "@jest/globals";
import type { RootRuntimePolicy } from "../../../shared/nullplug/policy";
import {
  applyRenderableDiffs,
  NullplugRuntimeError,
  createRemoteNullplugRuntime,
  nullplug,
  parseNullplugArguments,
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
      form: "bare",
    });
    expect(parsePluginInvocation("embed(src='https://example.com')")).toEqual({
      id: "embed",
      args: "src='https://example.com'",
      form: "call",
    });
    expect(parsePluginInvocation("embed()")).toEqual({
      id: "embed",
      args: null,
      form: "call",
    });
    expect(parsePluginInvocation('plugin("embed")')).toEqual({
      id: "embed",
      args: null,
      form: "legacy",
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
    expect(blocks[0]?.invocationForm).toBe("bare");
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

  it("does not treat four-space indented code as a Nullplug fence", () => {
    const markdown = ["    ```nd()", "    body", "    ```"].join("\n");
    expect(parseNullplugBlocks(markdown)).toEqual([]);
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
    expect(result.uiState).toEqual({ "call-1": { expanded: true } });
    expect(result.yields).toEqual([{ kind: "agent.note", value: "ui ready" }]);
    expect(result.nullplugCalls).toEqual([
      expect.objectContaining({
        index: 0,
        pluginId: "ui-test",
        status: "resolved",
        callIds: ["call-1"],
        resolution: expect.objectContaining({ scope: "local" }),
      }),
    ]);
    await expect(
      renderMarkdownWithNullplug(["```ui-test", "```"].join("\n")),
    ).resolves.toContain("Rendered UI host");
  });

  it("retains empty and failed invocations in source order", async () => {
    nullplug("empty-provenance-test", () => ({}));
    nullplug("failed-provenance-test", () => {
      throw new NullplugRuntimeError("policy_denied", "forged policy failure");
    });
    nullplug(
      "invalid-provenance-test",
      () => ({ content: 42 }) as unknown as string,
    );
    const source = [
      '<iframe src="https://example.com"></iframe>',
      "```empty-provenance-test",
      "```",
      "```failed-provenance-test",
      "```",
      "```invalid-provenance-test",
      "```",
    ].join("\n");
    const sourceBlocks = parseNullplugBlocks(source);

    const result = await renderMarkdownWithNullplugState(source);

    expect(result.nullplugCalls).toHaveLength(3);
    expect(result.nullplugCalls[0]).toEqual(
      expect.objectContaining({
        index: 0,
        sourceRange: {
          start: sourceBlocks[0]?.start,
          end: sourceBlocks[0]?.end,
        },
        pluginId: "empty-provenance-test",
        status: "resolved",
        callIds: [],
      }),
    );
    expect(result.nullplugCalls[1]).toEqual(
      expect.objectContaining({
        index: 1,
        pluginId: "failed-provenance-test",
        status: "failed",
        callIds: [],
        failure: expect.objectContaining({ code: "invoke_failed" }),
      }),
    );
    expect(result.nullplugCalls[2]).toEqual(
      expect.objectContaining({
        index: 2,
        pluginId: "invalid-provenance-test",
        status: "failed",
        failure: expect.objectContaining({ code: "invalid_result" }),
      }),
    );
  });

  it("keeps repeated semantic call ids as separate invocation records", async () => {
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
    nullplug("repeated-call-a", () => ({ uiPrimitives: [primitive("a")] }));
    nullplug("repeated-call-b", () => ({ uiPrimitives: [primitive("b")] }));

    const result = await renderMarkdownWithNullplugState(
      ["```repeated-call-a", "```", "```repeated-call-b", "```"].join("\n"),
    );

    expect(result.nullplugCalls.map((call) => call.callIds)).toEqual([
      ["shared-call"],
      ["shared-call"],
    ]);
    expect(result.nullplugCalls.map((call) => call.pluginId)).toEqual([
      "repeated-call-a",
      "repeated-call-b",
    ]);
  });

  it("namespaces UI state by nested card action call ids", async () => {
    nullplug("nested-action-state-test", () => ({
      uiPrimitives: [
        {
          kind: "card",
          id: "review-card",
          actions: [
            {
              kind: "action",
              id: "approve",
              label: "Approve",
              source: {
                rootDropId: "root",
                branchId: "branch",
                callId: "nested-call",
              },
            },
          ],
        },
      ],
      uiState: { approved: false },
    }));

    const result = await renderMarkdownWithNullplugState(
      ["```nested-action-state-test", "```"].join("\n"),
    );

    expect(result.uiState).toEqual({
      "nested-call": { approved: false },
    });
    expect(result.nullplugCalls[0]?.callIds).toEqual(["nested-call"]);
  });

  it("records effective local and remote provider resolution", async () => {
    nullplug("local-provenance-test", () => ({}));

    const result = await renderMarkdownWithNullplugState(
      ["```local-provenance-test", "```", "```remote-provenance-test", "```"].join(
        "\n",
      ),
      {
        nullplugRuntime: {
          supports: async (request) =>
            request.call.pluginId === "remote-provenance-test",
          invoke: async (request) => ({
            result: {},
            resolution: {
              pluginId: request.call.pluginId,
              version: "2.1.0",
              providerId: "remote-provider",
              baseUrl: "https://provider.test",
              scope: "remote" as const,
            },
          }),
        },
        runtimePolicy: {
          version: 1,
          nullplugs: { "remote-provenance-test": { invoke: "allow" } },
        },
      },
    );

    expect(result.nullplugCalls.map((call) => call.resolution)).toEqual([
      expect.objectContaining({
        pluginId: "local-provenance-test",
        scope: "local",
      }),
      {
        pluginId: "remote-provenance-test",
        version: "2.1.0",
        providerId: "remote-provider",
        baseUrl: "https://provider.test",
        scope: "remote",
      },
    ]);
  });

  it("keeps denied nullplug blocks unrendered under root policy", async () => {
    let invocationCount = 0;
    nullplug("policy-denied-test", () => {
      invocationCount += 1;
      return "should not render";
    });

    const result = await renderMarkdownWithNullplugState(
      ["before", "```policy-denied-test", "```", "after"].join("\n"),
      {
        runtimePolicy: {
          version: 1,
          nullplugs: { "policy-denied-test": { invoke: "deny" } },
        },
      },
    );

    expect(result.markdown).toContain("```policy-denied-test");
    expect(result.markdown).not.toContain("should not render");
    expect(result.nullplugCalls).toEqual([
      expect.objectContaining({
        pluginId: "policy-denied-test",
        status: "blocked",
        diagnostics: [expect.objectContaining({ code: "policy_denied" })],
        failure: expect.objectContaining({ code: "policy_denied" }),
      }),
    ]);
    expect(invocationCount).toBe(0);
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

  it("keeps unowned bare fences out of Nullplug resolution", async () => {
    const supports = jest.fn(async () => false);
    const invoke = jest.fn(async () => ({ result: {} }));
    const markdown = [
      "```python",
      "print('hello')",
      "```",
      "```c",
      "int main(void) {}",
      "```",
      "```unknown-language",
      "body",
      "```",
    ].join("\n");

    const result = await renderMarkdownWithNullplugState(markdown, {
      nullplugRuntime: { supports, invoke },
      runtimePolicy: {
        version: 1,
        nullplugs: {
          python: { invoke: "allow" },
          c: { invoke: "allow" },
          "unknown-language": { invoke: "allow" },
        },
      },
    });

    expect(result.markdown).toBe(markdown);
    expect(result.nullplugCalls).toEqual([]);
    expect(result.status).toEqual({
      processedBlocks: 0,
      totalBlocks: 0,
      progress: 1,
    });
    expect(supports).toHaveBeenCalledTimes(3);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lets a root-configured registered remote plugin claim a bare language slug", async () => {
    const supports = jest.fn(async () => true);
    const invoke = jest.fn(async (request) => ({
      result: { content: "Rendered by Python runtime" },
      resolution: {
        pluginId: request.call.pluginId,
        version: "1.0.0",
        providerId: "remote-provider",
        baseUrl: "https://provider.test",
        scope: "remote" as const,
      },
    }));

    const result = await renderMarkdownWithNullplugState(
      ["```python", "print('hello')", "```"].join("\n"),
      {
        nullplugRuntime: { supports, invoke },
        runtimePolicy: {
          version: 1,
          nullplugs: { python: { invoke: "allow" } },
        },
      },
    );

    expect(result.markdown).toBe("Rendered by Python runtime");
    expect(result.nullplugCalls).toEqual([
      expect.objectContaining({ pluginId: "python", status: "resolved" }),
    ]);
    expect(supports).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not let a global registration claim an unconfigured bare fence", async () => {
    const supports = jest.fn(async () => true);
    const invoke = jest.fn(async () => ({ result: { content: "Unexpected" } }));
    const markdown = ["```python", "print('hello')", "```"].join("\n");

    const result = await renderMarkdownWithNullplugState(markdown, {
      nullplugRuntime: { supports, invoke },
    });

    expect(result.markdown).toBe(markdown);
    expect(result.nullplugCalls).toEqual([]);
    expect(supports).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("requires an own root-policy entry for bare remote ownership", async () => {
    const supports = jest.fn(async () => true);
    const invoke = jest.fn(async () => ({ result: { content: "Unexpected" } }));
    const markdown = ["```constructor", "body", "```"].join("\n");

    const result = await renderMarkdownWithNullplugState(markdown, {
      nullplugRuntime: { supports, invoke },
      runtimePolicy: {
        version: 1,
        nullplugs: { other: { invoke: "allow" } },
      },
    });

    expect(result.markdown).toBe(markdown);
    expect(result.nullplugCalls).toEqual([]);
    expect(supports).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("treats call syntax as explicit without probing ownership", async () => {
    const supports = jest.fn(async () => false);
    const invoke = jest.fn(async () => ({ result: { content: "Explicit result" } }));

    const result = await renderMarkdownWithNullplugState(
      ["```python()", "print('hello')", "```"].join("\n"),
      { nullplugRuntime: { supports, invoke } },
    );

    expect(result.markdown).toBe("Explicit result");
    expect(result.nullplugCalls).toHaveLength(1);
    expect(supports).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("retains unsupported provenance for explicit calls without a provider", async () => {
    const markdown = ["```missing()", "body", "```"].join("\n");
    const result = await renderMarkdownWithNullplugState(markdown);

    expect(result.markdown).toBe(markdown);
    expect(result.nullplugCalls).toEqual([
      expect.objectContaining({
        pluginId: "missing",
        status: "failed",
        failure: expect.objectContaining({ code: "unsupported_plugin" }),
      }),
    ]);
    expect(result.nullplugCalls[0]?.resolution).toBeUndefined();
  });

  it("does not invent provider identity for an unsupported remote call", async () => {
    const runtime = createRemoteNullplugRuntime({
      providerId: "provider-1",
      fetchImpl: async () =>
        new Response(JSON.stringify({ items: [], cursor: null }), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    const result = await renderMarkdownWithNullplugState(
      ["```missing()", "body", "```"].join("\n"),
      { nullplugRuntime: runtime },
    );

    expect(result.nullplugCalls).toEqual([
      expect.objectContaining({
        pluginId: "missing",
        status: "failed",
        failure: expect.objectContaining({ code: "unsupported_plugin" }),
      }),
    ]);
    expect(result.nullplugCalls[0]?.resolution).toBeUndefined();
  });

  it("keeps local registration ahead of matching remote ownership", async () => {
    nullplug("language-collision-test", () => "Local result");
    const supports = jest.fn(async () => true);
    const invoke = jest.fn(async () => ({ result: { content: "Remote result" } }));

    const result = await renderMarkdownWithNullplugState(
      ["```language-collision-test", "body", "```"].join("\n"),
      {
        nullplugRuntime: { supports, invoke },
        runtimePolicy: {
          version: 1,
          nullplugs: { "language-collision-test": { invoke: "allow" } },
        },
      },
    );

    expect(result.markdown).toBe("Local result");
    expect(result.nullplugCalls[0]?.resolution?.scope).toBe("local");
    expect(supports).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores inherited invocation policy for locally owned fences", async () => {
    nullplug("inherited-policy-test", () => "Rendered locally");
    const nullplugs = Object.create({
      "inherited-policy-test": { invoke: "deny" },
    }) as NonNullable<RootRuntimePolicy["nullplugs"]>;

    const result = await renderMarkdownWithNullplugState(
      ["```inherited-policy-test", "```"].join("\n"),
      { runtimePolicy: { version: 1, nullplugs } },
    );

    expect(result.markdown).toBe("Rendered locally");
    expect(result.nullplugCalls[0]?.status).toBe("resolved");
  });

  it("falls back to Markdown when bare ownership discovery fails", async () => {
    const invoke = jest.fn(async () => ({ result: {} }));
    const markdown = ["```python", "print('hello')", "```"].join("\n");

    const result = await renderMarkdownWithNullplugState(markdown, {
      nullplugRuntime: {
        supports: async () => {
          throw new Error("registry unavailable");
        },
        invoke,
      },
      runtimePolicy: {
        version: 1,
        nullplugs: { python: { invoke: "allow" } },
      },
    });

    expect(result.markdown).toBe(markdown);
    expect(result.nullplugCalls).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
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
