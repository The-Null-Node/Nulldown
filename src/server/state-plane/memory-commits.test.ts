import { describe, expect, it, jest } from "@jest/globals";
import {
  BranchAppendCommand,
  BranchStateQuery,
  BranchStateError,
  requireBranchCommitCapability,
  type BranchAppendRecord,
  type BranchContentQuery,
} from "../../../shared/drop/branch-state";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import { prepareBranchCommit } from "../../../shared/drop/branch-commit";
import { DiffOp } from "../../../shared/nulledit/types";
import { MemoryBranchCommitStatePlane } from "./memory-commits";
import { createBranchStatePlane, createLocalBranchStatePlane } from "./gateway";
import { appendEventsToBranch } from "../../../functions/api/_lib/nulledit/service";
import {
  accountId,
  createSeededBucket,
  makeEvent,
  rootDropId,
} from "../../../functions/api/_lib/diffs/testing/storage-fixture";

const fixture = async () => {
  const blobs = createSeededBucket();
  const legacy = createBranchStatePlane({ blobs });
  const { branch } = await legacy.branches.resolveForActor(
    rootDropId,
    accountId,
    null,
  );
  const content = await legacy.snapshots.readContent(
    rootDropId,
    branch.branchId,
    0,
  );
  const query = {
    target: { rootDropId, branchId: branch.branchId },
    placement: { routingVersion: 1, generation: 7 },
  };
  const memory = await MemoryBranchCommitStatePlane.create(
    [{ branch, content: content!, placement: query.placement }],
    () => 1000,
  );
  const plane = createLocalBranchStatePlane({
    mode: "local-test",
    commits: memory,
  });
  const initial = await plane.readHead(query);
  const command = (
    await BranchAppendCommand.create({
      ...query,
      expected: initial.version,
      event: makeEvent({
        eventId: "event-1",
        sourceClientId: "writer",
        text: "A",
        createdAt: 101,
        metadata: { followsSeq: -1 },
      }),
    })
  ).toRecord();
  return {
    blobs,
    legacy,
    branch,
    content,
    query,
    memory,
    plane,
    initial,
    command,
  };
};

// Keep real hashing, but hold its completion to exercise either await deterministically.
const pauseDigest = (atCall: number) => {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let calls = 0;
  const spy = jest
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (algorithm, data) => {
      const call = ++calls;
      const result = await digest(algorithm, data);
      if (call === atCall) {
        enter();
        await released;
      }
      return result;
    });
  return { entered, resume, restore: () => spy.mockRestore() };
};

describe("local branch commit contract", () => {
  it.each([1, 2])(
    "captures the entire seed batch before hashing, including during digest %i",
    async (atCall) => {
      const f = await fixture();
      const seeds = ["first-before", "later-before"].map((content, index) => ({
        branch: { ...f.branch, branchId: `seed-${index}` },
        content,
        placement: { ...f.query.placement },
      }));
      const original = structuredClone(seeds);
      const paused = pauseDigest(atCall);
      try {
        const pending = MemoryBranchCommitStatePlane.create(seeds, () => 1000);
        await paused.entered;
        for (const seed of seeds) {
          seed.content = "mutated";
          seed.branch.branchId = "mutated";
          seed.branch.headSnapshotId = 50;
          seed.placement.generation = 99;
        }
        seeds.splice(0, seeds.length, {
          ...original[0],
          branch: { ...original[0].branch, branchId: "injected" },
        });
        paused.resume();
        const plane = await pending;
        for (const seed of original) {
          const query = {
            target: { rootDropId, branchId: seed.branch.branchId },
            placement: seed.placement,
          };
          const head = await plane.readHead(query);
          expect(head.branch).toEqual(seed.branch);
          expect(head.version.sourceContentHash).toBe(
            await hashNulldownSourceContent(seed.content),
          );
          expect(
            (await plane.readContent({ ...query, version: head.version }))
              .content,
          ).toBe(seed.content);
          const command = (
            await BranchAppendCommand.create({
              ...query,
              expected: head.version,
              event: f.command.event,
            })
          ).toRecord();
          const accepted = await plane.append(command);
          expect(
            (
              await plane.readContent({
                ...query,
                version: accepted.receipt.version,
              })
            ).content,
          ).toBe(`A${seed.content}`);
        }
        await expect(
          plane.readHead({
            ...f.query,
            target: { rootDropId, branchId: "injected" },
          }),
        ).rejects.toThrow("branch_not_found");
      } finally {
        paused.resume();
        paused.restore();
      }
    },
  );

  it("validates later seeds before hashing and preserves the captured typed failure", async () => {
    const f = await fixture();
    const seeds = [
      {
        branch: { ...f.branch },
        content: "valid",
        placement: { ...f.query.placement },
      },
      {
        branch: { ...f.branch, branchId: "later", headSnapshotId: 1 },
        content: "invalid",
        placement: { ...f.query.placement },
      },
    ];
    const pending = MemoryBranchCommitStatePlane.create(seeds);
    seeds[1].branch.headSnapshotId = 0;
    await expect(pending).rejects.toBeInstanceOf(BranchStateError);
    await expect(pending).rejects.toMatchObject({ code: "invalid_command" });
  });

  it.each([1, 2])(
    "captures preparation command/head across digest %i without changing event or transaction identity",
    async (atCall) => {
      const f = await fixture();
      const command = (
        await BranchAppendCommand.create({
          ...f.command,
          event: {
            ...f.command.event,
            metadata: { followsSeq: -1, args: { nested: ["original"] } },
          },
        })
      ).toRecord();
      const head = structuredClone(f.initial);
      const originalCommand = structuredClone(command);
      const originalHead = structuredClone(head);
      const paused = pauseDigest(atCall);
      try {
        const pending = prepareBranchCommit(command, head, f.content!, 1000);
        await paused.entered;
        command.event.ops[0].text = "MUTATED";
        command.event.metadata!.args!.nested = ["mutated"];
        command.event.eventId = "mutated";
        command.target.branchId = "other";
        command.placement.generation = 99;
        command.expected.snapshotId = 50;
        command.payloadHash = head.version.sourceContentHash;
        head.target.branchId = "other";
        head.branch.branchId = "other";
        head.branch.headSnapshotId = 50;
        head.placement.generation = 99;
        head.version.snapshotId = 50;
        head.version.eventSeq = 50;
        head.version.sourceContentHash = originalCommand.payloadHash;
        paused.resume();
        const prepared = await pending;
        expect(prepared.content).toBe(`A${f.content}`);
        expect(prepared.event).toEqual({
          ...originalCommand.event,
          seq: 0,
          snapshotId: 1,
        });
        expect(prepared.branch).toEqual({
          ...originalHead.branch,
          headSnapshotId: 1,
          headEventSeq: 0,
          updatedAt: 1000,
        });
        expect(prepared.snapshot).toMatchObject({
          ...originalCommand.target,
          snapshotId: 1,
          parentSnapshotId: 0,
          eventIds: [originalCommand.event.eventId],
          textLength: prepared.content.length,
        });
        const sourceContentHash = await hashNulldownSourceContent(
          prepared.content,
        );
        expect(prepared.snapshot.sourceContentHash).toBe(sourceContentHash);
        expect(prepared.receipt).toEqual({
          target: originalCommand.target,
          placement: originalCommand.placement,
          eventId: originalCommand.event.eventId,
          payloadHash: originalCommand.payloadHash,
          version: { snapshotId: 1, eventSeq: 0, sourceContentHash },
        });
        const revalidated = await BranchAppendCommand.fromRecord({
          ...originalCommand,
          event: prepared.event,
        });
        expect(revalidated.toRecord().payloadHash).toBe(
          prepared.receipt.payloadHash,
        );
        expect(prepared.outbox).toEqual({
          id: JSON.stringify([
            "branch.commit.v1",
            rootDropId,
            originalCommand.target.branchId,
            originalCommand.event.eventId,
          ]),
          kind: "branch.commit.v1",
          receipt: prepared.receipt,
        });
      } finally {
        paused.resume();
        paused.restore();
      }
    },
  );

  it("retains native-operation precedence and checks preparation identity before returning transaction rows", async () => {
    const f = await fixture();
    const command = (
      await BranchAppendCommand.create({
        ...f.command,
        event: {
          ...f.command.event,
          ops: [
            {
              type: "insert",
              start: 0,
              end: 0,
              text: "ignored legacy text",
              native: {
                op: DiffOp.INSERT,
                data: "Tg==",
                range: { start: 0, end: 0 },
              },
            },
          ],
        },
      })
    ).toRecord();
    const receipt = (await f.plane.append(command)).receipt;
    const legacy = await appendEventsToBranch(f.blobs, f.branch, [
      command.event,
    ]);
    expect(
      (await f.plane.readContent({ ...f.query, version: receipt.version }))
        .content,
    ).toBe(legacy.content);
    expect(legacy.content).toBe(`N${f.content}`);
    await expect(
      prepareBranchCommit(
        command,
        { ...f.initial, target: { ...f.initial.target, branchId: "other" } },
        f.content!,
        1000,
      ),
    ).rejects.toThrow("state_corrupt");
    await expect(
      prepareBranchCommit(command, f.initial, "corrupt", 1000),
    ).rejects.toThrow("state_corrupt");
    await expect(
      prepareBranchCommit(command, f.initial, f.content!, -1),
    ).rejects.toThrow("invalid_command");
  });

  it("matches legacy content, assigned event identity and receipts while preserving the default gateway", async () => {
    const f = await fixture();
    const local = await f.plane.append(f.command);
    const old = await appendEventsToBranch(f.blobs, f.branch, [
      f.command.event,
    ]);
    const query = { ...f.query, version: local.receipt.version };
    expect((await f.plane.readContent(query)).content).toBe(old.content);
    expect(local.receipt.version).toEqual({
      snapshotId: old.snapshot!.snapshotId,
      eventSeq: old.acceptedEvents[0].seq,
      sourceContentHash: old.snapshot!.sourceContentHash,
    });
    expect(
      await f.plane.readEvents({ ...query, startSeq: 0, endSeq: 0 }),
    ).toEqual(old.acceptedEvents);
    expect(
      await f.legacy.snapshots.readEventsBySeqRange(
        rootDropId,
        f.branch.branchId,
        0,
        0,
      ),
    ).toEqual(old.acceptedEvents);
    expect(await f.plane.append(f.command)).toEqual({
      status: "duplicate",
      receipt: local.receipt,
    });
    expect(f.memory.inspectOutbox(f.query)).toEqual([
      {
        id: JSON.stringify([
          "branch.commit.v1",
          rootDropId,
          f.branch.branchId,
          f.command.event.eventId,
        ]),
        kind: "branch.commit.v1",
        receipt: local.receipt,
      },
    ]);
    expect(f.legacy).toHaveProperty("maintenance");
    expect(f.plane).not.toHaveProperty("maintenance");
    expect(() => requireBranchCommitCapability("memory")).toThrow(
      "capability_unsupported",
    );
  });

  it("keeps the original receipt and historical content after later commits and caller mutation", async () => {
    const f = await fixture();
    const accepted = await f.plane.append(f.command);
    const original = structuredClone(accepted.receipt);
    const second = (
      await BranchAppendCommand.create({
        ...f.query,
        expected: accepted.receipt.version,
        event: {
          ...f.command.event,
          eventId: "event-2",
          metadata: { followsSeq: 0 },
        },
      })
    ).toRecord();
    await f.plane.append(second);
    accepted.receipt.version.snapshotId = 999;
    const replay = await f.plane.append(f.command);
    expect(replay.receipt).toEqual(original);
    expect((await f.plane.readHead(f.query)).version.snapshotId).toBe(2);
    expect(
      (await f.plane.readContent({ ...f.query, version: f.initial.version }))
        .content,
    ).toBe(f.content);
    expect(
      (
        await f.plane.readEvents({
          ...f.query,
          version: original.version,
          startSeq: 0,
          endSeq: 0,
        })
      )[0].snapshotId,
    ).toBe(1);
    expect(f.memory.inspectOutbox(f.query)).toHaveLength(2);
  });

  it("serializes concurrent identical retries into one commit and rejects competing stale predecessors", async () => {
    const f = await fixture();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => f.plane.append(f.command)),
    );
    expect(outcomes.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect(new Set(outcomes.map((r) => JSON.stringify(r.receipt))).size).toBe(
      1,
    );
    const next = await f.plane.readHead(f.query);
    const commands = await Promise.all(
      ["race-a", "race-b"].map(async (eventId) =>
        (
          await BranchAppendCommand.create({
            ...f.query,
            expected: next.version,
            event: { ...f.command.event, eventId, metadata: { followsSeq: 0 } },
          })
        ).toRecord(),
      ),
    );
    const raced = await Promise.allSettled(
      commands.map((c) => f.plane.append(c)),
    );
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(raced.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "diff_predecessor_mismatch" },
    });
    expect(f.memory.inspectOutbox(f.query)).toHaveLength(2);
  });

  it("fences generation before duplicate receipts and rejects payload reuse before stale predecessor", async () => {
    const f = await fixture();
    await f.plane.append(f.command);
    await expect(
      f.plane.append({
        ...f.command,
        placement: { ...f.command.placement, generation: 6 },
      }),
    ).rejects.toThrow("routing_generation_mismatch");
    const reused = (
      await BranchAppendCommand.create({
        ...f.command,
        event: { ...f.command.event, createdAt: 102 },
      })
    ).toRecord();
    await expect(f.plane.append(reused)).rejects.toThrow(
      "diff_event_id_reused",
    );
    const stale = (
      await BranchAppendCommand.create({
        ...f.command,
        event: { ...f.command.event, eventId: "stale" },
      })
    ).toRecord();
    await expect(f.plane.append(stale)).rejects.toThrow(
      "diff_predecessor_mismatch",
    );
    expect(f.memory.inspectOutbox(f.query)).toHaveLength(1);
  });

  it("rejects forged hashes, malformed commands, wrong head hashes and invalid ranges without writes", async () => {
    const f = await fixture();
    await expect(
      f.plane.append({
        ...f.command,
        payloadHash: await hashNulldownSourceContent("forged"),
      }),
    ).rejects.toThrow("invalid_command");
    await expect(
      f.plane.append(null as unknown as BranchAppendRecord),
    ).rejects.toThrow("invalid_command");
    await expect(
      f.plane.append({
        ...f.command,
        expected: {
          ...f.command.expected,
          sourceContentHash: await hashNulldownSourceContent("wrong"),
        },
      }),
    ).rejects.toThrow("diff_predecessor_mismatch");
    await expect(
      f.plane.readHead({
        ...f.query,
        placement: { ...f.query.placement, routingVersion: 2 },
      }),
    ).rejects.toThrow("routing_version_unsupported");
    await expect(
      f.plane.readHead({
        ...f.query,
        target: { ...f.query.target, branchId: "absent" },
      }),
    ).rejects.toThrow("branch_not_found");
    await expect(
      f.plane.readContent({
        ...f.query,
        version: { ...f.initial.version, snapshotId: 5 },
      }),
    ).rejects.toThrow("snapshot_not_found");
    await expect(
      f.plane.readContent({
        ...f.query,
        version: { ...f.initial.version, eventSeq: 0 },
      }),
    ).rejects.toThrow("snapshot_version_mismatch");
    await expect(
      f.plane.readEvents({
        ...f.query,
        version: f.initial.version,
        startSeq: 0,
        endSeq: 0,
      }),
    ).rejects.toThrow("invalid_command");
    expect(await f.plane.readHead(f.query)).toEqual(f.initial);
    expect(f.memory.inspectOutbox(f.query)).toEqual([]);
  });

  it("uses canonical payload identity, not input sequence or object insertion order", async () => {
    const f = await fixture();
    const reordered = {
      ...f.command.event,
      seq: 100,
      snapshotId: 30,
      metadata: { args: { b: 2, a: 1 }, followsSeq: -1 },
    };
    const a = await BranchAppendCommand.create({
      ...f.command,
      event: reordered,
    });
    const b = await BranchAppendCommand.create({
      ...f.command,
      event: {
        ...reordered,
        seq: -1,
        snapshotId: undefined,
        metadata: { followsSeq: -1, args: { a: 1, b: 2 } },
      },
    });
    expect(a.toRecord().payloadHash).toBe(b.toRecord().payloadHash);
    const captured = a.toRecord();
    captured.event.ops[0].text = "mutated";
    expect(a.toRecord().event.ops[0].text).toBe("A");
    expect(new BranchStateError("state_unavailable").toRecord()).toEqual({
      code: "state_unavailable",
      status: 503,
      outcome: "unknown",
      retry: "same-command",
    });
  });

  it("keys exact queries by branch, placement and complete version, including snapshot zero", async () => {
    const f = await fixture();
    const base: BranchContentQuery = { ...f.query, version: f.initial.version };
    const variants = [
      base,
      { ...base, target: { ...base.target, branchId: "other" } },
      { ...base, placement: { ...base.placement, generation: 8 } },
      { ...base, version: { ...base.version, eventSeq: 0 } },
      {
        ...base,
        version: {
          ...base.version,
          sourceContentHash: await hashNulldownSourceContent("other"),
        },
      },
    ];
    expect(
      new Set(variants.map((q) => BranchStateQuery.key("content", q))).size,
    ).toBe(variants.length);
    expect(() =>
      BranchStateQuery.key("events", {
        ...base,
        version: { ...base.version, eventSeq: 200 },
        startSeq: 0,
        endSeq: 200,
      }),
    ).toThrow("invalid_command");
  });
});
