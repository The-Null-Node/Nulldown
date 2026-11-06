import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  accountId,
  createSeededBucket,
  makeEvent,
  MemoryD1Database,
  rootDropId,
} from "../../../functions/api/_lib/diffs/testing/storage-fixture";
import {
  backfillBranchToSnapshotHeap,
  resolveBranchForActor,
} from "../../../functions/api/_lib/branches/lifecycle";
import { createBranchRepository } from "../../../functions/api/_lib/branches/storage/repository";
import { createSnapshotKey } from "../../../functions/api/_lib/branches/storage/keys";
import { appendEventsToBranch } from "../../../functions/api/_lib/nulledit/service";
import { createNullMemService } from "../../../functions/api/_lib/nullmem/service";
import { createCloudflareBackendRuntime } from "../../../functions/api/_lib/core/platform/cloudflare/runtime/composition";
import { createMemoryRuntimeDataStore } from "../memory-data-store";
import { LocalBranchSqlite } from "./local-sqlite";
import { SqliteSourceWriteFence } from "./source-fence";
import { createLegacySourceWriter } from "./legacy-source-writer";

const target = { rootDropId, branchId: "owner" };
const certificate = {
  target,
  sourceGeneration: 0,
  migrationId: "application-writer",
};
const connections: LocalBranchSqlite[] = [];
const fixture = (register = true) => {
  const sql = new LocalBranchSqlite();
  connections.push(sql);
  const gate = new SqliteSourceWriteFence(sql);
  if (register) gate.register(target);
  const blobs = createSeededBucket();
  const writer = createLegacySourceWriter({
    target,
    generation: 0,
    admission: gate,
  });
  const repository = createBranchRepository({ blobs });
  const resolve = () =>
    resolveBranchForActor(
      blobs,
      rootDropId,
      accountId,
      null,
      undefined,
      undefined,
      writer,
    );
  return { gate, blobs, writer, repository, resolve };
};
afterEach(() => {
  for (const sql of connections.splice(0)) sql.close();
});

describe("legacy application source-writer boundaries", () => {
  it("requires durable admission before creation and rejects resolution/backfill after freeze", async () => {
    const f = fixture(false);
    await expect(f.resolve()).rejects.toMatchObject({
      code: "branch_not_found",
    });
    expect(await f.repository.readBranch(rootDropId, "owner")).toBeNull();
    f.gate.register(target);
    const { branch, created } = await f.resolve();
    expect(created).toBe(true);
    expect(branch).toMatchObject({ ...target, headSnapshotId: 0 });
    expect(f.gate.read(target).active).toBe(0);
    await backfillBranchToSnapshotHeap(
      f.blobs,
      rootDropId,
      "owner",
      undefined,
      f.writer,
    );
    f.gate.fence(certificate);
    await expect(f.resolve()).rejects.toMatchObject({
      code: "routing_placement_mismatch",
    });
    await expect(
      backfillBranchToSnapshotHeap(
        f.blobs,
        rootDropId,
        "owner",
        undefined,
        f.writer,
      ),
    ).rejects.toMatchObject({ code: "routing_placement_mismatch" });
    expect(await f.repository.readBranch(rootDropId, "owner")).toEqual(branch);
  });

  it("keeps a partial branch initialization admitted when one concurrent storage write fails", async () => {
    const f = fixture();
    const put = f.blobs.put.bind(f.blobs);
    jest
      .spyOn(f.blobs, "put")
      .mockImplementation(async (key, value, options) => {
        if (key === createSnapshotKey(rootDropId, "owner", 0))
          throw Error("snapshot unavailable");
        return put(key, value, options);
      });
    await expect(f.resolve()).rejects.toThrow("snapshot unavailable");
    expect(f.gate.fence(certificate)).toMatchObject({
      phase: "draining",
      active: 1,
    });
  });

  it("holds the append permit through built-in memory snapshotters while freeze drains", async () => {
    const f = fixture();
    const { branch } = await f.resolve();
    const db = new MemoryD1Database();
    const runtime = createCloudflareBackendRuntime({
      R2_BUCKET: f.blobs as unknown as R2Bucket,
      DB: db as unknown as D1Database,
      legacySourceWriter: f.writer,
    });
    const forbidden = jest.fn(async () => undefined);
    const appended = await runtime.nulledit.appendDiffEvents({
      branch,
      events: [
        makeEvent({
          eventId: "fenced-append",
          text: "A",
          sourceClientId: "writer",
          createdAt: 101,
        }),
      ],
      snapshotters: [
        {
          id: "freeze-before-memory",
          phase: "primary",
          async snapshot() {
            expect(f.gate.fence(certificate)).toMatchObject({
              phase: "draining",
              active: 1,
            });
            await expect(
              f.writer.run(target, "memory", forbidden),
            ).rejects.toMatchObject({ code: "routing_placement_mismatch" });
          },
        },
      ],
    });
    expect(appended.acceptedEvents).toHaveLength(1);
    expect(forbidden).not.toHaveBeenCalled();
    expect(db.nullmemRecords.size).toBe(1);
    expect(f.gate.fence(certificate)).toMatchObject({
      phase: "frozen",
      active: 0,
    });
  });

  it("retains swallowed snapshotter failure despite a durable append and duplicate retry", async () => {
    const f = fixture();
    const { branch } = await f.resolve();
    const event = makeEvent({
      eventId: "partial-append",
      text: "A",
      sourceClientId: "writer",
      createdAt: 102,
    });
    await expect(
      appendEventsToBranch(f.blobs, branch, [event], {
        sourceWriter: f.writer,
        data: createMemoryRuntimeDataStore(),
        snapshotters: [
          {
            id: "failed-memory",
            snapshot() {
              throw Error("memory write uncertain");
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "state_unavailable" });
    const stored = await f.repository.readBranch(rootDropId, "owner");
    expect(stored?.headSnapshotId).toBe(1);
    const retry = await appendEventsToBranch(f.blobs, stored!, [event], {
      sourceWriter: f.writer,
    });
    expect(retry.acknowledgements[0].status).toBe("duplicate");
    expect(f.gate.fence(certificate)).toMatchObject({
      phase: "draining",
      active: 1,
    });
  });

  it("fences standalone memory facts, procedures, deletes and cross-branch writes", async () => {
    const f = fixture();
    await f.resolve();
    const db = new MemoryD1Database();
    const memory = createNullMemService({
      blobs: f.blobs,
      sql: db,
      sourceWriter: f.writer,
    });
    await memory.createFact({
      ...target,
      fact: { recordId: "one", text: "fact" },
    });
    await memory.createProcedure({
      ...target,
      procedure: { recordId: "two", goal: "goal", summary: "summary" },
    });
    expect(db.nullmemRecords.size).toBe(2);
    expect(f.gate.read(target).active).toBe(0);
    const writes = db.runCalls;
    await expect(
      memory.createFact({
        ...target,
        branchId: "another",
        fact: { text: "outside" },
      }),
    ).rejects.toMatchObject({ code: "routing_placement_mismatch" });
    f.gate.fence(certificate);
    await expect(
      memory.createFact({ ...target, fact: { text: "closed" } }),
    ).rejects.toMatchObject({ code: "routing_placement_mismatch" });
    await expect(
      memory.createProcedure({
        ...target,
        procedure: { goal: "closed", summary: "closed" },
      }),
    ).rejects.toMatchObject({ code: "routing_placement_mismatch" });
    await expect(
      memory.delete({ ...target, recordId: "one" }),
    ).rejects.toMatchObject({ code: "routing_placement_mismatch" });
    expect(db.runCalls).toBe(writes);
  });
});
