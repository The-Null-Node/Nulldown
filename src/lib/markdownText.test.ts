import {
  mapMarkdownIndexToPlainTextOffset,
  mapPlainTextOffsetToMarkdownIndex,
} from "./markdownText";

const getVisibleLength = (markdown: string): number =>
  mapMarkdownIndexToPlainTextOffset(markdown, markdown.length);

describe("markdown cursor mapping", () => {
  it("round-trips plain-text offsets for rich markdown", () => {
    const markdown =
      "## Hello **world** and [friends](https://example.com)\nNew `line`";
    const visibleLength = getVisibleLength(markdown);

    for (let plainOffset = 0; plainOffset <= visibleLength; plainOffset += 1) {
      const markdownIndex = mapPlainTextOffsetToMarkdownIndex(
        markdown,
        plainOffset,
      );
      const roundTripOffset = mapMarkdownIndexToPlainTextOffset(
        markdown,
        markdownIndex,
      );

      expect(roundTripOffset).toBe(plainOffset);
    }
  });

  it("maps formatting markers to stable plain offsets", () => {
    const markdown = "**ab**";

    expect(mapPlainTextOffsetToMarkdownIndex(markdown, 0)).toBe(2);
    expect(mapPlainTextOffsetToMarkdownIndex(markdown, 1)).toBe(3);
    expect(mapPlainTextOffsetToMarkdownIndex(markdown, 2)).toBe(4);

    expect(mapMarkdownIndexToPlainTextOffset(markdown, 0)).toBe(0);
    expect(mapMarkdownIndexToPlainTextOffset(markdown, 1)).toBe(0);
    expect(mapMarkdownIndexToPlainTextOffset(markdown, 2)).toBe(0);
    expect(mapMarkdownIndexToPlainTextOffset(markdown, 3)).toBe(1);
    expect(mapMarkdownIndexToPlainTextOffset(markdown, 4)).toBe(2);
    expect(mapMarkdownIndexToPlainTextOffset(markdown, 6)).toBe(2);
  });

  it("skips heading and list prefixes from visible offsets", () => {
    const markdown = "## Title\n- item";

    expect(mapPlainTextOffsetToMarkdownIndex(markdown, 0)).toBe(3);
    expect(mapPlainTextOffsetToMarkdownIndex(markdown, 5)).toBe(8);

    expect(mapMarkdownIndexToPlainTextOffset(markdown, 0)).toBe(0);
    expect(mapMarkdownIndexToPlainTextOffset(markdown, 3)).toBe(0);
    expect(mapMarkdownIndexToPlainTextOffset(markdown, markdown.length)).toBe(
      getVisibleLength(markdown),
    );
  });
});
