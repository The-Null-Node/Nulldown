import {
  DEFAULT_IFRAME_ALLOWLIST,
  normalizeIframeAllowlist,
  parseIframeAllowlistInput,
  resolveIframeAllowlist,
} from "./iframeAllowlist";

describe("iframe allowlist", () => {
  it("normalizes hostnames from URLs and raw host entries", () => {
    const normalized = normalizeIframeAllowlist([
      "https://www.youtube.com/watch?v=demo",
      "player.vimeo.com",
      "HTTPS://YOUTU.BE/abc",
      "youtube.com/path",
      "",
      "not a valid host !!!",
    ]);

    expect(normalized).toEqual([
      "www.youtube.com",
      "player.vimeo.com",
      "youtu.be",
      "youtube.com",
    ]);
  });

  it("deduplicates entries while preserving order", () => {
    const normalized = normalizeIframeAllowlist([
      "youtube.com",
      "https://youtube.com",
      "www.youtube.com",
      "www.youtube.com",
    ]);

    expect(normalized).toEqual(["youtube.com", "www.youtube.com"]);
  });

  it("parses newline and comma separated input", () => {
    const parsed = parseIframeAllowlistInput(
      "https://youtube.com\nplayer.vimeo.com, youtu.be",
    );

    expect(parsed).toEqual(["youtube.com", "player.vimeo.com", "youtu.be"]);
  });

  it("keeps a non-empty built-in default allowlist", () => {
    expect(DEFAULT_IFRAME_ALLOWLIST.length).toBeGreaterThan(0);
  });

  it("falls back to built-in defaults when no source allowlist exists", () => {
    expect(resolveIframeAllowlist(undefined)).toEqual([...DEFAULT_IFRAME_ALLOWLIST]);
  });

  it("uses normalized source allowlists when present", () => {
    expect(
      resolveIframeAllowlist([
        "HTTPS://WWW.YouTube.com/embed/demo",
        "player.vimeo.com",
        "not a host",
      ]),
    ).toEqual(["www.youtube.com", "player.vimeo.com"]);
  });
});
