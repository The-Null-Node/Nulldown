import type { R2Bucket } from "@cloudflare/workers-types";
import { appendEventsToBranch } from "../../../../functions/api/_lib/nulledit/service";
import { resolveBranchForActor } from "../../../../functions/api/_lib/branches/lifecycle";
import {
  accountId,
  createSeededBucket,
  makeEvent,
  rootDropId,
} from "../../../../functions/api/_lib/diffs/testing/storage-fixture";
import type { DropDiffEvent } from "../../../../shared/drop/diff";
import type { NullMemProcedureRecord } from "../../../../shared/nullmem/records";
import { createNulleditNullMemObserverSnapshotter } from "./nullmem-observer";

describe("NullMem observer snapshotter contracts", () => {
  it("creates idempotent NullMem observer facts for accepted appends", async () => {
    const event = {
      ...makeEvent({
        eventId: "evt-nullmem-repeat",
        sourceClientId: "writer-nullmem-repeat",
        text: "M",
        createdAt: 115,
      }),
      seq: 7,
      snapshotId: 3,
    } as DropDiffEvent;
    const facts: Array<{ recordId: string }> = [];
    const byRecordId = new Map<string, string>();
    const snapshotter = createNulleditNullMemObserverSnapshotter({
      writeFact(fact) {
        facts.push(fact);
        byRecordId.set(fact.recordId, fact.text);
      },
    });
    const context = {
      data: {} as never,
      rootDropId,
      branchId: "branch-nullmem-repeat",
      snapshotId: 3,
      parentSnapshotId: 2,
      branch: {} as never,
      snapshot: {} as never,
      frame: { content: "M" },
      acceptedEvents: [event],
      acceptedDiffRefs: [],
      deduplicatedCount: 0,
      totalStored: 8,
    };

    await snapshotter.snapshot(context);
    await snapshotter.snapshot(context);

    expect(facts).toHaveLength(2);
    expect(facts[0]?.recordId).toBe(
      "memfact:observed-branch-append:AaBbCc112233:branch-nullmem-repeat:3:evt-nullmem-repeat:evt-nullmem-repeat",
    );
    expect(facts[1]?.recordId).toBe(facts[0]?.recordId);
    expect(byRecordId.size).toBe(1);
  });

  it("projects only explicit completed candidates as idempotent procedures", async () => {
    const candidate = {
      ...makeEvent({
        eventId: "evt-procedure-candidate",
        sourceClientId: "writer-procedure-candidate",
        text: "P",
        createdAt: 116,
        metadata: {
          intent: "Capture an accepted diff procedure.",
          args: {
            summary: "Apply the verified branch update.",
            procedureCandidate: {
              goal: "Apply a verified branch update",
              summary:
                "Persist the marked update and retain its diff evidence.",
              completed: true,
              reusableAs: "accepted-diff projection",
            },
          },
          labels: ["nullmem/procedure-candidate"],
          confidence: 0.8,
        },
      }),
      seq: 8,
      snapshotId: 4,
    } as DropDiffEvent;
    const ignored = {
      ...makeEvent({
        eventId: "evt-procedure-ignored",
        sourceClientId: "writer-procedure-ignored",
        text: "I",
        createdAt: 117,
        metadata: {
          labels: ["nullmem/procedure-candidate"],
          args: {
            procedureCandidate: {
              goal: "Missing completion",
              summary: "Ignore me",
            },
          },
        },
      }),
      seq: 9,
      snapshotId: 4,
    } as DropDiffEvent;
    const procedures: NullMemProcedureRecord[] = [];
    const snapshotter = createNulleditNullMemObserverSnapshotter({
      writeFact() {},
      writeProcedure(procedure) {
        procedures.push(procedure as NullMemProcedureRecord);
      },
    });
    const context = {
      data: {} as never,
      rootDropId,
      branchId: "branch-procedure-candidate",
      snapshotId: 4,
      parentSnapshotId: 3,
      branch: {} as never,
      snapshot: {} as never,
      frame: { content: "PI" },
      acceptedEvents: [candidate, ignored],
      acceptedDiffRefs: [],
      deduplicatedCount: 0,
      totalStored: 10,
    };

    await snapshotter.snapshot(context);
    await snapshotter.snapshot(context);

    expect(procedures).toHaveLength(2);
    expect(procedures[0]).toEqual(
      expect.objectContaining({
        recordId: `memproc:auto-accepted-diff:${rootDropId}:branch-procedure-candidate:evt-procedure-candidate`,
        goal: "Apply a verified branch update",
        outcome: "success",
        labels: [
          "procedure-memory",
          "auto-extracted",
          "needs-review",
          "accepted-diff",
        ],
        confidence: 0.5,
        sourceRefs: [
          {
            kind: "branch",
            rootDropId,
            branchId: "branch-procedure-candidate",
          },
          {
            kind: "diff",
            rootDropId,
            branchId: "branch-procedure-candidate",
            eventId: "evt-procedure-candidate",
            seq: 8,
          },
        ],
      }),
    );
    expect(procedures[0]?.steps).toEqual([
      expect.objectContaining({
        kind: "diff.apply",
        status: "success",
        name: "Capture an accepted diff procedure.",
        argsSummary: "Apply the verified branch update.",
      }),
    ]);
    expect(procedures[1]?.recordId).toBe(procedures[0]?.recordId);
  });

  it("isolates accepted-diff procedure projection failures", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-procedure-observer-error",
      sourceClientId: "writer-procedure-observer-error",
      text: "E",
      createdAt: 118,
      metadata: {
        labels: ["nullmem/procedure-candidate"],
        args: {
          procedureCandidate: {
            goal: "Exercise observer failure isolation",
            summary:
              "A failing procedure writer must not reject the accepted diff.",
            completed: true,
          },
        },
      },
    });
    const errors: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters: [
          createNulleditNullMemObserverSnapshotter({
            writeFact() {},
            writeProcedure() {
              throw new Error("procedure projection failed");
            },
          }),
        ],
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
        onSnapshotterError: (_error, snapshotterId) => {
          errors.push(snapshotterId);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    await waitUntilPromises[0];
    expect(errors).toEqual(["nulledit.nullmem-observer"]);
  });
});
