import {
  isDropRuntimeCompareStatus,
  isDropRuntimeProviderScope,
  isDropRuntimeVersionRef,
} from "./runtime";

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
});
