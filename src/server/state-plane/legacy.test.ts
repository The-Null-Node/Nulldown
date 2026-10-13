import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  readBranchContent,
  readBranchEventsBySeqRange,
} from "../../../functions/api/_lib/branches/content/replay";
import { resolveBranchForActor } from "../../../functions/api/_lib/branches/lifecycle";
import { createBranchRepository } from "../../../functions/api/_lib/branches/storage/repository";
import {
  accountId,
  createSeededBucket,
  makeEvent,
  rootDropId,
} from "../../../functions/api/_lib/diffs/testing/storage-fixture";
import { appendEventsToBranch } from "../../../functions/api/_lib/nulledit/service";
import { createBranchStatePlane } from "./gateway";

afterEach(() => jest.restoreAllMocks());

describe("legacy State Plane parity", () => {
  it("preserves actor IDs, creation/reuse, listing cursors, and missing branch semantics", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1700000000000);
    const direct = createSeededBucket();
    const routed = createSeededBucket();
    const plane = createBranchStatePlane({ blobs: routed });
    const repository = createBranchRepository({ blobs: direct });
    expect(routed.getCalls).toEqual([]);
    expect(routed.listCalls).toEqual([]);

    for (const actor of [
      accountId,
      "reader-account",
      accountId,
      "reader-account",
    ]) {
      const expected = await resolveBranchForActor(
        direct,
        rootDropId,
        actor,
        "client",
      );
      const actual = await plane.branches.resolveForActor(
        rootDropId,
        actor,
        "client",
      );
      expect(actual).toEqual(expected);
      expect(
        await plane.branches.readBranch(rootDropId, actual.branch.branchId),
      ).toEqual(
        await repository.readBranch(rootDropId, expected.branch.branchId),
      );
    }
    expect(await plane.branches.listBranchesForRoot(rootDropId)).toEqual(
      await repository.listBranchesForRoot(rootDropId),
    );
    const first = await plane.maintenance.listBranchesForRootPage(
      rootDropId,
      1,
    );
    expect(first).toEqual(
      await repository.listBranchesForRootPage(rootDropId, 1),
    );
    expect(
      await plane.maintenance.listBranchesForRootPage(
        rootDropId,
        1,
        first.cursor ?? undefined,
      ),
    ).toEqual(
      await repository.listBranchesForRootPage(
        rootDropId,
        1,
        first.cursor ?? undefined,
      ),
    );
    expect(await plane.branches.readBranch(rootDropId, "missing")).toBeNull();
    expect(
      await plane.maintenance.backfillSnapshotHeap(rootDropId, "missing"),
    ).toBeNull();
    expect(
      await plane.snapshots.readContent(rootDropId, "missing", 0),
    ).toBeNull();
  });

  it("preserves committed snapshot hashes, replay content, and inclusive event provenance", async () => {
    const blobs = createSeededBucket();
    const plane = createBranchStatePlane({ blobs });
    const repository = createBranchRepository({ blobs });
    const { branch } = await plane.branches.resolveForActor(
      rootDropId,
      accountId,
      null,
    );
    const appended = await appendEventsToBranch(blobs, branch, [
      makeEvent({
        eventId: "state-plane-parity-event",
        sourceClientId: "state-plane-parity-client",
        text: "P",
        createdAt: 107,
      }),
    ]);
    const snapshotId = appended.branch.headSnapshotId;
    expect(
      await plane.snapshots.readSnapshot(
        rootDropId,
        branch.branchId,
        snapshotId,
      ),
    ).toEqual(
      await repository.readSnapshot(rootDropId, branch.branchId, snapshotId),
    );
    expect(appended.snapshot?.sourceContentHash).toBeTruthy();
    expect(
      await plane.snapshots.readContent(
        rootDropId,
        branch.branchId,
        snapshotId,
      ),
    ).toBe(appended.content);
    expect(
      await plane.snapshots.readContent(
        rootDropId,
        branch.branchId,
        snapshotId,
      ),
    ).toBe(
      await readBranchContent(blobs, rootDropId, branch.branchId, snapshotId),
    );
    expect(
      await plane.snapshots.readEventsBySeqRange(
        rootDropId,
        branch.branchId,
        0,
        0,
      ),
    ).toEqual(
      await readBranchEventsBySeqRange(
        blobs,
        rootDropId,
        branch.branchId,
        0,
        0,
      ),
    );
    expect(
      await plane.snapshots.listSnapshotsForBranch(rootDropId, branch.branchId),
    ).toEqual(
      await repository.listSnapshotsForBranch(rootDropId, branch.branchId),
    );
    expect(
      await plane.maintenance.backfillSnapshotHeap(rootDropId, branch.branchId),
    ).toEqual(appended.branch);
  });

  it("preserves initialization failure without translating the legacy error", async () => {
    const blobs = createSeededBucket();
    const plane = createBranchStatePlane({ blobs });
    await expect(
      plane.branches.resolveForActor("missing-root", accountId, null),
    ).rejects.toThrow(
      "Remote branch editing is not available for encrypted drop envelopes yet.",
    );
    expect(await plane.branches.listBranchesForRoot("missing-root")).toEqual(
      [],
    );
  });
});
