import {
  dropDiffEventMetadataSidecarKey,
  dropDiffEventMetadataSidecarPrefix,
  dropResolvedHeapKey,
  dropSnapshotMetadataSidecarKey,
  dropSnapshotMetadataSidecarPrefix,
  isDropDiffEventMetadataSidecar,
  isDropSnapshotMetadataSidecar,
  readDropDiffEventMetadataSidecar,
  readDropSnapshotMetadataSidecar,
  sanitizeSidecarKeyPart,
  writeDropDiffEventMetadataSidecar,
  writeDropSnapshotMetadataSidecar,
  type DropSidecarJsonStore,
} from "./sidecar";

const createMemoryStore = (): DropSidecarJsonStore & {
  values: Map<string, string>;
  contentTypes: Map<string, string | undefined>;
} => {
  const values = new Map<string, string>();
  const contentTypes = new Map<string, string | undefined>();
  return {
    values,
    contentTypes,
    async get(key) {
      const value = values.get(key);
      if (value === undefined) return null;
      return {
        async json() {
          return JSON.parse(value) as unknown;
        },
      };
    },
    async put(key, value, options) {
      values.set(key, value);
      contentTypes.set(key, options?.httpMetadata?.contentType);
    },
  };
};

describe("drop sidecar helpers", () => {
  it("builds deterministic sidecar keys", () => {
    expect(sanitizeSidecarKeyPart("resolver/id with spaces")).toBe(
      "resolver_id_with_spaces",
    );
    expect(dropDiffEventMetadataSidecarPrefix("root", "branch")).toBe(
      "__drop_diff_event_metadata__/root/branch/",
    );
    expect(dropDiffEventMetadataSidecarKey("root", "branch", 12)).toBe(
      "__drop_diff_event_metadata__/root/branch/0000000000000012.json",
    );
    expect(dropSnapshotMetadataSidecarPrefix("root", "branch", "snap/id")).toBe(
      "__drop_snapshot_metadata__/root/branch/snap_id/",
    );
    expect(dropSnapshotMetadataSidecarKey("root", "branch", "snap/id", 3)).toBe(
      "__drop_snapshot_metadata__/root/branch/snap_id/3.json",
    );
    expect(dropResolvedHeapKey("root", "branch", "resolver/id", 4)).toBe(
      "__drop_resolved_heap__/root/branch/resolver_id/4.json",
    );
  });

  it("validates event and snapshot sidecars", () => {
    expect(
      isDropDiffEventMetadataSidecar({
        version: 1,
        rootDropId: "root",
        branchId: "branch",
        seq: 1,
        eventId: "event-1",
        updatedAt: 123,
        updatedBy: "agent",
        annotations: [
          {
            kind: "summary",
            value: { text: "hello" },
            confidence: 0.8,
          },
        ],
      }),
    ).toBe(true);
    expect(
      isDropDiffEventMetadataSidecar({
        version: 1,
        rootDropId: "root",
        branchId: "branch",
        seq: 1,
        eventId: "event-1",
        updatedAt: 123,
        updatedBy: "agent",
        annotations: [{ kind: "summary", value: undefined }],
      }),
    ).toBe(false);
    expect(
      isDropSnapshotMetadataSidecar({
        version: 1,
        snapshotterId: "semantic",
        rootDropId: "root",
        branchId: "branch",
        snapshotId: 2,
        createdAt: 100,
        updatedAt: 101,
        tags: ["planning"],
        resolvedHeapRefs: ["heap-1"],
      }),
    ).toBe(true);
    expect(
      isDropSnapshotMetadataSidecar({
        version: 1,
        snapshotterId: "semantic",
        rootDropId: "root",
        branchId: "branch",
        snapshotId: 2,
        createdAt: 100,
        updatedAt: 101,
        tags: [42],
      }),
    ).toBe(false);
  });

  it("reads and writes event metadata sidecars", async () => {
    const store = createMemoryStore();
    const sidecar = {
      version: 1 as const,
      rootDropId: "root",
      branchId: "branch",
      seq: 2,
      eventId: "event-2",
      updatedAt: 123,
      updatedBy: "agent",
      annotations: [{ kind: "agent-note" as const, value: "note" }],
    };

    await writeDropDiffEventMetadataSidecar(store, sidecar);

    const key = dropDiffEventMetadataSidecarKey("root", "branch", 2);
    expect(store.contentTypes.get(key)).toBe("application/json");
    await expect(
      readDropDiffEventMetadataSidecar(store, "root", "branch", 2),
    ).resolves.toEqual(sidecar);
  });

  it("reads and writes snapshot metadata sidecars", async () => {
    const store = createMemoryStore();
    const sidecar = {
      version: 1 as const,
      snapshotterId: "semantic/snapshotter",
      rootDropId: "root",
      branchId: "branch",
      snapshotId: 5,
      createdAt: 100,
      updatedAt: 101,
      summary: "Current planning state.",
      tags: ["planning"],
      resolvedHeapRefs: ["heap-1"],
    };

    await writeDropSnapshotMetadataSidecar(store, sidecar);

    const key = dropSnapshotMetadataSidecarKey(
      "root",
      "branch",
      "semantic/snapshotter",
      5,
    );
    expect(store.contentTypes.get(key)).toBe("application/json");
    await expect(
      readDropSnapshotMetadataSidecar(
        store,
        "root",
        "branch",
        "semantic/snapshotter",
        5,
      ),
    ).resolves.toEqual(sidecar);
  });
});
