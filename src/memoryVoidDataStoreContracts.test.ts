import { createMemoryVoidDataStore } from "./server/memoryDataStore";
import {
  createNulleditResolvedDocumentSnapshotter,
  createResolvedHeapDataKey,
} from "./server/nulledit";
import type { DropBranchRecord, DropSnapshotRecord } from "../shared/drop/branch";
import { createDropDiffRef, type DropDiffEvent } from "../shared/drop/diff";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  type ResolvedDocumentNode,
  type ResolvedNulldownState,
} from "../shared/drop/resolved";

const rootDropId = "memory-root";
const branchId = "owner";

describe("Memory VoidDataStore contracts", () => {
  it("stores, lists, queries, paginates, and deletes indexed records", async () => {
    const data = createMemoryVoidDataStore();
    const key = {
      namespace: "resolved",
      collection: "document_nodes",
      scope: { rootDropId, branchId, snapshotId: 1, resolverId: "doc" },
      id: "node-a",
    };
    const otherKey = { ...key, id: "node-b" };
    const value = { kind: "paragraph", text: "Alpha policy node" };

    await data.put(key, value, {
      indexes: [
        { name: "kind", value: "paragraph" },
        { name: "labels", value: ["policy", "memory"] },
        { name: "text", value: value.text, mode: "fulltext" },
      ],
    });
    await data.put(otherKey, { kind: "heading", text: "Beta node" }, {
      indexes: [
        { name: "kind", value: "heading" },
        { name: "text", value: "Beta node", mode: "fulltext" },
      ],
    });

    await expect(data.get(key)).resolves.toEqual(value);
    await expect(data.put(key, value, { ifAbsent: true })).rejects.toThrow(
      "void_data_put_conflict",
    );
    await expect(
      data.list({
        namespace: "resolved",
        collection: "document_nodes",
        scope: { rootDropId, branchId },
        limit: 1,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ value })],
        cursor: "1",
        truncated: true,
      }),
    );
    await expect(
      data.query({
        namespace: "resolved",
        collection: "document_nodes",
        scope: { rootDropId, branchId, snapshotId: 1 },
        indexes: [{ name: "labels", value: "memory" }],
        text: "alpha",
      }),
    ).resolves.toEqual([value]);

    await data.delete(key);
    await expect(data.get(key)).resolves.toBeNull();
  });

  it("runs the resolved document snapshotter without Cloudflare test doubles", async () => {
    const data = createMemoryVoidDataStore();
    const branch: DropBranchRecord = {
      version: 1,
      branchId,
      rootDropId,
      baseDropId: rootDropId,
      mode: "owner",
      status: "active",
      ownerAccountId: "acct_1",
      writerAccountId: null,
      writerClientId: null,
      headSnapshotId: 1,
      snapshotHeapVersion: 2,
      headEventSeq: 0,
      createdAt: 100,
      updatedAt: 101,
    };
    const snapshot: DropSnapshotRecord = {
      version: 1,
      snapshotId: 1,
      rootDropId,
      branchId,
      parentSnapshotId: 0,
      seq: 1,
      eventIds: ["evt-1"],
      checkpointed: false,
      patchStartSeq: 0,
      patchEndSeq: 0,
      textLength: 34,
      createdAt: 102,
    };
    const event: DropDiffEvent = {
      eventId: "evt-1",
      seq: 0,
      dropId: rootDropId,
      sourceClientId: "agent",
      createdAt: 102,
      snapshotId: 1,
      ops: [{ type: "insert", start: 0, end: 0, text: "# Plan\n\nShip memory adapter." }],
    };

    await createNulleditResolvedDocumentSnapshotter().snapshot({
      data,
      rootDropId,
      branchId,
      snapshotId: 1,
      parentSnapshotId: 0,
      branch,
      snapshot,
      frame: { content: "# Plan\n\nShip memory adapter." },
      acceptedEvents: [event],
      acceptedDiffRefs: [
        createDropDiffRef({
          rootDropId,
          branchId,
          seq: event.seq,
          eventId: event.eventId,
          snapshotId: 1,
        }),
      ],
      deduplicatedCount: 0,
      totalStored: 1,
    });

    const heap = await data.get<ResolvedNulldownState>(
      createResolvedHeapDataKey({
        rootDropId,
        branchId,
        snapshotId: 1,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      }),
    );
    const nodes = await data.query<ResolvedDocumentNode>({
      namespace: "resolved",
      collection: "document_nodes",
      scope: { rootDropId, branchId, snapshotId: 1, resolverId: RESOLVED_DOCUMENT_RESOLVER_ID },
      indexes: [{ name: "kind", value: "paragraph" }],
      text: "adapter",
    });

    expect(heap).toEqual(
      expect.objectContaining({
        rootDropId,
        branchId,
        snapshotId: 1,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      }),
    );
    expect(nodes).toEqual([
      expect.objectContaining({ kind: "paragraph", text: "Ship memory adapter." }),
    ]);
  });
});
