import {
  isDropRuntimeCompareStatus,
  isDropRuntimeProviderScope,
  isDropRuntimeVersionRef,
} from "./runtime";
import type { DropRuntimeRenderFrame } from "./runtime";

describe("drop runtime contracts", () => {
  it("validates provider runtime scopes", () => {
    expect(isDropRuntimeProviderScope("local")).toBe(true);
    expect(isDropRuntimeProviderScope("remote")).toBe(true);
    expect(isDropRuntimeProviderScope("server")).toBe(false);
  });

  it("validates compare statuses", () => {
    expect(isDropRuntimeCompareStatus("equal")).toBe(true);
    expect(isDropRuntimeCompareStatus("heap-diverged")).toBe(true);
    expect(isDropRuntimeCompareStatus("dirty")).toBe(false);
  });

  it("validates runtime version refs", () => {
    expect(
      isDropRuntimeVersionRef({
        rootDropId: "root",
        branchId: "branch",
        snapshotId: 2,
        eventSeq: 5,
        contentHash: "sha256:test",
      }),
    ).toBe(true);

    expect(
      isDropRuntimeVersionRef({
        rootDropId: "root",
        branchId: "branch",
        snapshotId: "2",
      }),
    ).toBe(false);
  });

  it("preserves repeated semantic ids in ordered call provenance", () => {
    const frame: DropRuntimeRenderFrame = {
      frameId: "render:1",
      sourceMarkdown: "source",
      renderedMarkdown: "rendered",
      sourceContentHash: "sha256:source",
      renderedContentHash: "sha256:rendered",
      acceptedDiffRefs: [],
      resolverRefs: [],
      nullplugCalls: [
        {
          index: 0,
          sourceRange: { start: 0, end: 10 },
          pluginId: "first",
          resolution: {
            pluginId: "first",
            providerId: "browser",
            baseUrl: "browser://local",
            scope: "local",
          },
          status: "resolved",
          callIds: ["shared"],
          diagnostics: [],
        },
        {
          index: 1,
          sourceRange: { start: 11, end: 20 },
          pluginId: "second",
          resolution: {
            pluginId: "second",
            version: "1.0.0",
            providerId: "remote",
            baseUrl: "https://provider.test",
            scope: "remote",
          },
          status: "failed",
          callIds: ["shared"],
          diagnostics: [],
          failure: { code: "invoke_failed", message: "failed" },
        },
      ],
      nullplugCallIds: ["shared"],
      diagnostics: [],
      status: "final",
    };

    expect(frame.nullplugCalls.map((call) => call.callIds)).toEqual([
      ["shared"],
      ["shared"],
    ]);
  });
});
