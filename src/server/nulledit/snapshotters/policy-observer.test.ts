import {
  makeEvent,
  rootDropId,
} from "../../../../functions/api/_lib/diffs/testing/storage-fixture";
import type { DropDiffEvent } from "../../../../shared/drop/diff";
import { createNulleditPolicyObserverSnapshotter } from "./policy-observer";

describe("policy observer snapshotter contracts", () => {
  it("skips policy observer facts without accepted policy metadata", async () => {
    const event = {
      ...makeEvent({
        eventId: "evt-policy-skip",
        sourceClientId: "writer-policy-skip",
        text: "P",
        createdAt: 116,
      }),
      seq: 8,
      snapshotId: 4,
    } as DropDiffEvent;
    const writes: unknown[] = [];
    const snapshotter = createNulleditPolicyObserverSnapshotter();

    await snapshotter.snapshot({
      data: {
        putMany(records: unknown[]) {
          writes.push(...records);
        },
      } as never,
      rootDropId,
      branchId: "branch-policy-skip",
      snapshotId: 4,
      parentSnapshotId: 3,
      branch: {} as never,
      snapshot: {} as never,
      frame: { content: "P" },
      acceptedEvents: [event],
      acceptedDiffRefs: [],
      deduplicatedCount: 0,
      totalStored: 9,
    });

    expect(writes).toHaveLength(0);
  });
});
