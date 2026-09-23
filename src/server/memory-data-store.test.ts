import { createMemoryRuntimeDataStore } from "./memory-data-store";

const rootDropId = "memory-root";
const branchId = "owner";

describe("Memory runtime data store contracts", () => {
  it("stores, lists, queries, paginates, and deletes indexed records", async () => {
    const data = createMemoryRuntimeDataStore();
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
    await data.put(
      otherKey,
      { kind: "heading", text: "Beta node" },
      {
        indexes: [
          { name: "kind", value: "heading" },
          { name: "text", value: "Beta node", mode: "fulltext" },
        ],
      },
    );

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

  it("stores multiple records through putMany and preserves ifAbsent conflicts", async () => {
    const data = createMemoryRuntimeDataStore();
    const keyA = {
      namespace: "resolved",
      collection: "document_nodes",
      scope: { rootDropId, branchId, snapshotId: 2, resolverId: "doc" },
      id: "node-a",
    };
    const keyB = { ...keyA, id: "node-b" };

    await data.putMany([
      {
        key: keyA,
        value: { kind: "paragraph", text: "Batch alpha node" },
        options: {
          indexes: [
            { name: "kind", value: "paragraph" },
            { name: "text", value: "Batch alpha node", mode: "fulltext" },
          ],
        },
      },
      {
        key: keyB,
        value: { kind: "heading", text: "Batch beta node" },
        options: { indexes: [{ name: "kind", value: "heading" }] },
      },
    ]);

    await expect(
      data.query({
        namespace: "resolved",
        collection: "document_nodes",
        scope: { rootDropId, branchId, snapshotId: 2, resolverId: "doc" },
        indexes: [{ name: "kind", value: "paragraph" }],
        text: "alpha",
      }),
    ).resolves.toEqual([{ kind: "paragraph", text: "Batch alpha node" }]);
    await expect(
      data.putMany([
        {
          key: keyA,
          value: { kind: "paragraph", text: "Duplicate" },
          options: { ifAbsent: true },
        },
      ]),
    ).rejects.toThrow("void_data_put_conflict");
  });
});
