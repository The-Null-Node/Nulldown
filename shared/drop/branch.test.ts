import { isDropBranchRecord, isDropSnapshotRecord } from "./branch";

describe("legacy branch records", () => {
  it("accepts a pre-heap branch record without v2 cursor fields", () => {
    const raw =
      '{"version":1,"branchId":"clone:fixture-writer","rootDropId":"root-fixture","baseDropId":"base-fixture","mode":"clone","status":"active","ownerAccountId":"owner-fixture","writerAccountId":"writer-fixture","writerClientId":"client-fixture","headSnapshotId":7,"createdAt":1700000000000,"updatedAt":1700000001000}';
    const parsed = JSON.parse(raw) as unknown;
    const original = parsed;

    expect(isDropBranchRecord(parsed)).toBe(true);
    expect(parsed).toBe(original);
    expect(JSON.stringify(parsed)).toBe(raw);
    expect(parsed).toMatchObject({
      rootDropId: "root-fixture",
      branchId: "clone:fixture-writer",
      baseDropId: "base-fixture",
      ownerAccountId: "owner-fixture",
      writerAccountId: "writer-fixture",
      writerClientId: "client-fixture",
      headSnapshotId: 7,
    });
    expect(parsed).not.toHaveProperty("snapshotHeapVersion");
    expect(parsed).not.toHaveProperty("headEventSeq");
    expect(parsed).not.toHaveProperty("checkpointInterval");
  });

  it("accepts a legacy checkpoint snapshot and preserves branch identity and sequence", () => {
    const raw =
      '{"version":1,"snapshotId":7,"rootDropId":"root-fixture","branchId":"clone:fixture-writer","parentSnapshotId":6,"seq":12,"eventIds":["event-11","event-12"],"checkpointed":true,"checkpointKey":"snapshots/root-fixture/clone-fixture-writer/7.txt","textLength":42,"createdAt":1700000001000}';
    const parsed = JSON.parse(raw) as unknown;
    const original = parsed;

    expect(isDropSnapshotRecord(parsed)).toBe(true);
    expect(parsed).toBe(original);
    expect(JSON.stringify(parsed)).toBe(raw);
    expect(parsed).toMatchObject({
      snapshotId: 7,
      rootDropId: "root-fixture",
      branchId: "clone:fixture-writer",
      parentSnapshotId: 6,
      seq: 12,
      eventIds: ["event-11", "event-12"],
      checkpointed: true,
    });
    expect(parsed).not.toHaveProperty("patchStartSeq");
    expect(parsed).not.toHaveProperty("patchEndSeq");
  });
});
