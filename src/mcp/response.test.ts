import { asCompact as asSourceCompact } from "./response";
import { asCompact as asPackageCompact } from "../../packages/nulldown-mcp/src/response";

describe.each([
  ["source", asSourceCompact],
  ["package", asPackageCompact],
])("asCompact (%s)", (_name, asCompact) => {
  it("preserves small responses as valid JSON", () => {
    const response = asCompact({ ok: true }, { maxTokens: 100 });

    expect(JSON.parse(response.content[0]!.text)).toEqual({ ok: true });
  });

  it("returns a valid truncation envelope within the requested budget", () => {
    const response = asCompact({ content: "x".repeat(1_000) }, { maxTokens: 100 });
    const text = response.content[0]!.text;
    const parsed = JSON.parse(text) as {
      truncated: boolean;
      maxTokens: number;
      totalChars: number;
      preview: string;
    };

    expect(text.length).toBeLessThanOrEqual(400);
    expect(parsed).toMatchObject({ truncated: true, maxTokens: 100 });
    expect(parsed.totalChars).toBeGreaterThan(text.length);
    expect(parsed.preview.length).toBeGreaterThan(0);
  });
});
