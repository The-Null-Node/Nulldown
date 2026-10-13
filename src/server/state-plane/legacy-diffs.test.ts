import { describe, expect, it } from "@jest/globals";
import { appendEventsToBranch } from "../../../functions/api/_lib/nulledit/service";
import {
  accountId,
  createSeededBucket,
  makeEvent,
  rootDropId,
} from "../../../functions/api/_lib/diffs/testing/storage-fixture";
import { createBranchStatePlane, createDiffCommandStatePlane } from "./gateway";

describe("legacy diff State Plane commands", () => {
  it("retains receipt identity across retries and rejects conflicts without advancing the poll stream", async () => {
    const blobs = createSeededBucket();
    const plane = createBranchStatePlane({ blobs });
    const commands = createDiffCommandStatePlane({
      appendDiffEvents: ({ branch, events, ...options }) =>
        appendEventsToBranch(blobs, branch, events, options),
    });
    const { branch } = await plane.branches.resolveForActor(
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "command-receipt",
      sourceClientId: "writer",
      text: "A",
      createdAt: 101,
      metadata: { followsSeq: -1 },
    });
    const accepted = await commands.appendDiffEvents({
      branch,
      events: [event],
    });
    const repeated = await commands.appendDiffEvents({
      branch,
      events: [event],
    });
    expect(accepted.acknowledgements).toEqual([
      { eventId: event.eventId, seq: 0, snapshotId: 1, status: "accepted" },
    ]);
    expect(repeated.acknowledgements).toEqual([
      { eventId: event.eventId, seq: 0, snapshotId: 1, status: "duplicate" },
    ]);
    expect(repeated.snapshot).toBeNull();
    expect(repeated.deduplicatedCount).toBe(1);
    await expect(
      commands.appendDiffEvents({
        branch,
        events: [{ ...event, createdAt: 102 }],
      }),
    ).rejects.toThrow("diff_event_id_reused");
    await expect(
      commands.appendDiffEvents({
        branch,
        events: [{ ...event, eventId: "stale-predecessor" }],
      }),
    ).rejects.toThrow("diff_predecessor_mismatch");

    const polled = await plane.diffs.poll({
      rootDropId,
      branch: accepted.branch,
      cursor: null,
      limit: 1,
      factLimit: 1,
    });
    expect(polled.response.events).toEqual(accepted.acceptedEvents);
    expect(polled.response.cursor).toBe("0");
    expect(polled.totalStored).toBe(1);
    expect(polled.response).not.toHaveProperty("facts");
    expect(
      await plane.branches.readBranch(rootDropId, branch.branchId),
    ).toEqual(accepted.branch);

    const excluded = await plane.diffs.poll({
      rootDropId,
      branch: accepted.branch,
      cursor: null,
      excludeClient: "writer",
      limit: 1,
      factLimit: 1,
    });
    expect(excluded.response).toEqual({ events: [], cursor: "0" });
  });

  it("preserves latest handshakes and empty-stream cursors without reading unrequested facts", async () => {
    const blobs = createSeededBucket();
    const plane = createBranchStatePlane({ blobs });
    const { branch } = await plane.branches.resolveForActor(
      rootDropId,
      accountId,
      null,
    );
    blobs.clearReadMetrics();
    expect(
      await plane.diffs.poll({
        rootDropId,
        branch,
        cursor: "__latest__",
        limit: 50,
        factLimit: 50,
      }),
    ).toEqual({
      response: { events: [], cursor: null },
      totalStored: 0,
      totalFacts: 0,
    });
    expect(blobs.getCalls).toEqual([]);
    expect(blobs.listCalls).toEqual([]);
    expect(
      (
        await plane.diffs.poll({
          rootDropId,
          branch,
          cursor: "__latest__",
          factCursor: "-1",
          limit: 50,
          factLimit: 50,
        })
      ).response,
    ).toEqual({ events: [], cursor: null, facts: [], factCursor: "-1" });
    expect(
      (
        await plane.diffs.poll({
          rootDropId,
          branch,
          cursor: null,
          factCursor: "__latest__",
          limit: 50,
          factLimit: 50,
        })
      ).response,
    ).toEqual({ events: [], cursor: null, facts: [], factCursor: "-1" });
  });
});
