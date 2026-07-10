import {
  compareDropRuntimeVersions,
  createBranchContentVersionReader,
  createDropProviderRuntime,
  createRemoteBranchContentVersionReader,
  versionRefFromBranchContent,
} from "./providerRuntime";
import type { DropRuntimeVersionRef } from "../../../shared/drop/runtime";

const version = (
  overrides: Partial<DropRuntimeVersionRef> = {},
): DropRuntimeVersionRef => ({
  rootDropId: "root",
  branchId: "branch",
  snapshotId: 1,
  eventSeq: 1,
  contentHash: "content-a",
  metadataHash: "metadata-a",
  runtimeHeapHash: "heap-a",
  ...overrides,
});

describe("provider runtime adapters", () => {
  it("compares equal versions", () => {
    expect(compareDropRuntimeVersions(version(), version())).toEqual({
      status: "equal",
      local: version(),
      remote: version(),
      reasons: [],
    });
  });

  it("detects local and remote ahead states from event sequences", () => {
    expect(
      compareDropRuntimeVersions(version({ eventSeq: 3 }), version({ eventSeq: 2 }))
        .status,
    ).toBe("local-ahead");

    expect(
      compareDropRuntimeVersions(version({ eventSeq: 2 }), version({ eventSeq: 3 }))
        .status,
    ).toBe("remote-ahead");
  });

  it("detects content, metadata, and heap divergence", () => {
    expect(
      compareDropRuntimeVersions(
        version({ contentHash: "content-a" }),
        version({ contentHash: "content-b" }),
      ).status,
    ).toBe("diverged");

    expect(
      compareDropRuntimeVersions(
        version({ metadataHash: "metadata-a" }),
        version({ metadataHash: "metadata-b" }),
      ).status,
    ).toBe("metadata-diverged");

    expect(
      compareDropRuntimeVersions(
        version({ runtimeHeapHash: "heap-a" }),
        version({ runtimeHeapHash: "heap-b" }),
      ).status,
    ).toBe("heap-diverged");

    expect(
      compareDropRuntimeVersions(
        version({ contentHash: "content-a", metadataHash: "metadata-a" }),
        version({ contentHash: "content-b", metadataHash: "metadata-b" }),
      ).status,
    ).toBe("diverged");
  });

  it("wraps provider scopes and compares through injected version readers", async () => {
    const local = createDropProviderRuntime({
      provider: { scope: "local" },
      readVersion: async () => version({ eventSeq: 2 }),
    });
    const remote = createDropProviderRuntime({
      provider: { scope: "remote" },
      readVersion: async () => version({ eventSeq: 1 }),
    });

    await expect(
      local.compare(remote, { rootDropId: "root", branchId: "branch" }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "local-ahead",
        reasons: ["local-version-newer"],
      }),
    );
  });

  it("builds version refs from branch content sources", async () => {
    await expect(
      versionRefFromBranchContent({
        rootDropId: "root",
        branchId: "branch",
        snapshotId: 4,
        headEventSeq: 7,
        content: "# Hello",
        metadata: { themeId: "system" },
        runtimeHeapHash: "sha256:runtime",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        rootDropId: "root",
        branchId: "branch",
        snapshotId: 4,
        eventSeq: 7,
        contentHash: expect.stringMatching(/^sha256:/),
        metadataHash: expect.stringMatching(/^sha256:/),
        runtimeHeapHash: "sha256:runtime",
      }),
    );
  });

  it("creates injected and remote branch content version readers", async () => {
    const localReader = createBranchContentVersionReader(async () => ({
      rootDropId: "root",
      branchId: "branch",
      snapshotId: 1,
      content: "local",
    }));
    const remoteReader = createRemoteBranchContentVersionReader({
      getBranchContent: async () => ({
        rootDropId: "root",
        branchId: "branch",
        snapshotId: 2,
        content: "remote",
      }),
    });

    await expect(
      localReader({ rootDropId: "root", branchId: "branch" }),
    ).resolves.toEqual(expect.objectContaining({ snapshotId: 1 }));
    await expect(
      remoteReader({ rootDropId: "root", branchId: "branch" }),
    ).resolves.toEqual(expect.objectContaining({ snapshotId: 2 }));
  });
});
