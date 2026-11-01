import { describe, expect, it, jest } from "@jest/globals";
import {
  queryNullMemRecords,
  type BranchNullMemStatePlane,
} from "../../../shared/drop/branch-nullmem";
import { BranchStateError } from "../../../shared/drop/branch-state";
import type { NullMemFactRecord } from "../../../shared/nullmem/records";
import { MemoryBranchCommitStatePlane } from "./memory-commits";
import { createLocalNullMemService } from "./nullmem-application";
import type { LocalBranchApplicationSelection } from "./commit-application";
import type { LocalBranchLifecycle } from "./application-lifecycle";

const target = { rootDropId: "root", branchId: "owner" };
const placement = { routingVersion: 1, generation: 2 };
const fixture = async () => {
  const commits = await MemoryBranchCommitStatePlane.create([
    {
      placement,
      content: "source",
      branch: {
        version: 1,
        ...target,
        baseDropId: "root",
        mode: "owner",
        status: "active",
        ownerAccountId: "actor",
        writerAccountId: "actor",
        writerClientId: null,
        headSnapshotId: 0,
        headEventSeq: -1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ]);
  const head = await commits.readHead({ target, placement });
  const record: NullMemFactRecord = {
    version: 1,
    kind: "fact",
    recordId: "fact",
    ...target,
    text: "memory",
    createdAt: 10,
    sourceRefs: [{ kind: "snapshot", ...target, snapshotId: 0 }],
  };
  const backend = {
    queryNullMem: jest
      .fn<BranchNullMemStatePlane["queryNullMem"]>()
      .mockImplementation(async (query) => ({
        target,
        placement,
        head,
        memoryRevision: 1,
        records: queryNullMemRecords([structuredClone(record)], query),
      })),
    putNullMem: jest
      .fn<BranchNullMemStatePlane["putNullMem"]>()
      .mockImplementation(async (command) => ({
        target,
        placement,
        head,
        memoryRevision: 2,
        record: { ...command.record, createdAt: 20 },
      })),
    deleteNullMem: jest
      .fn<BranchNullMemStatePlane["deleteNullMem"]>()
      .mockImplementation(async (command) => ({
        target,
        placement,
        head,
        memoryRevision: 3,
        recordId: command.recordId,
      })),
  };
  const selection: LocalBranchApplicationSelection = {
    mode: "local-test",
    placement,
    commits,
    nullmem: { backend },
  };
  const service = createLocalNullMemService(selection, {
    actorAccountId: "actor",
    canReadSensitive: true,
  });
  return { selection, service, backend, head, record };
};

describe("local NullMem application boundary", () => {
  it("preserves mutable public write shapes, defaults, supplied metadata and backend timestamps", async () => {
    const { service, backend } = await fixture();
    const fact = await service.createFact({
      ...target,
      fact: {
        recordId: "fixed",
        text: "A",
        metadata: { actorAccountId: "client-data" },
      },
    });
    expect(fact.record).toMatchObject({
      recordId: "fixed",
      text: "A",
      createdAt: 20,
      metadata: { actorAccountId: "client-data" },
      sourceRefs: [{ kind: "branch", ...target }],
    });
    expect(backend.putNullMem.mock.calls[0][0]).toMatchObject({
      target,
      placement,
      actorAccountId: "actor",
    });
    expect(await service.delete({ ...target, recordId: "fixed" })).toEqual({
      ...target,
      recordId: "fixed",
    });
    const procedure = await service.createProcedure({
      ...target,
      procedure: {
        recordId: "fixed",
        goal: "goal",
        summary: "summary",
        sourceRefs: [],
      },
    });
    expect(procedure.record).toMatchObject({
      kind: "procedure",
      recordId: "fixed",
      steps: [],
      outcome: "success",
      sourceRefs: [],
      createdAt: 20,
    });
  });

  it("rejects substituted write replies and uncertain selected failures", async () => {
    const { service, backend, head, record } = await fixture();
    const base = { target, placement, head, memoryRevision: 2, record };
    for (const invalid of [
      { ...base, target: { ...target, branchId: "sibling" } },
      { ...base, placement: { ...placement, generation: 99 } },
      {
        ...base,
        head: { ...head, target: { ...target, rootDropId: "other" } },
      },
      { ...base, record: { ...record, text: "substituted" } },
      { ...base, memoryRevision: 0 },
    ]) {
      backend.putNullMem.mockResolvedValueOnce(invalid);
      await expect(
        service.createFact({
          ...target,
          fact: {
            recordId: record.recordId,
            text: record.text,
            sourceRefs: record.sourceRefs,
          },
        }),
      ).rejects.toThrow("state_corrupt");
    }
    backend.deleteNullMem.mockResolvedValueOnce({ ...base, recordId: "wrong" });
    await expect(
      service.delete({ ...target, recordId: "fact" }),
    ).rejects.toThrow("state_corrupt");
    backend.putNullMem.mockRejectedValueOnce(
      new BranchStateError("state_unavailable"),
    );
    await expect(
      service.createFact({ ...target, fact: { text: "new" } }),
    ).rejects.toThrow("state_unavailable");
  });

  it("pins freshness to the memory query head before catalog work and uses no watermark", async () => {
    const { selection, backend, head } = await fixture();
    const catalog = {
      readRecords: jest.fn(async () => {
        head.version.snapshotId = 99;
        head.branch.headSnapshotId = 99;
        return [];
      }),
    };
    const service = createLocalNullMemService(
      { ...selection, nullmem: { backend, catalog } },
      { actorAccountId: "actor", canReadSensitive: true },
    );
    const result = await service.query({
      ...target,
      kind: "fact",
      includeFreshness: true,
      currentSnapshotId: 99,
    });
    expect(result.freshness?.[0]).toMatchObject({
      currentSnapshotId: 0,
      status: "fresh",
    });
    expect(catalog.readRecords).toHaveBeenCalledWith({
      kind: "fact",
      canReadSensitive: true,
    });
  });

  it("never fetches sensitive catalogs for public reads and filters records plus capsules", async () => {
    const { selection, backend } = await fixture();
    const catalog = {
      readRecords: jest.fn(async () => {
        throw Error("private catalog must not be read");
      }),
    };
    const service = createLocalNullMemService(
      { ...selection, nullmem: { backend, catalog } },
      { actorAccountId: null, canReadSensitive: false },
    );
    const result = await service.query({
      ...target,
      kind: "fact",
      includeFreshness: true,
    });
    expect(result.records).toEqual([]);
    expect(result.capsules).toEqual([]);
    expect(result.freshness).toEqual([]);
    expect(backend.queryNullMem.mock.calls[0][0].labels).toEqual([
      "public-memory",
    ]);
    expect(catalog.readRecords).not.toHaveBeenCalled();
  });

  it("rejects cross-branch records, heads and placement replies", async () => {
    const { service, backend, record, head } = await fixture();
    const base = {
      target,
      placement,
      head,
      memoryRevision: 1,
      records: [record],
    };
    for (const invalid of [
      { ...base, records: [{ ...record, rootDropId: "other" }] },
      {
        ...base,
        head: { ...head, placement: { ...placement, generation: 99 } },
      },
      {
        ...base,
        head: { ...head, branch: { ...head.branch, branchId: "sibling" } },
      },
      { ...base, memoryRevision: -1 },
      { ...base, records: [record, record] },
      {
        ...base,
        head: { ...head, version: { ...head.version, snapshotId: -1 } },
      },
    ]) {
      backend.queryNullMem.mockResolvedValueOnce(invalid);
      await expect(service.query({ ...target, kind: "fact" })).rejects.toThrow(
        "state_corrupt",
      );
    }
    backend.queryNullMem.mockResolvedValueOnce(base);
    await expect(
      service.query({ ...target, labels: ["public-memory"] }),
    ).rejects.toThrow("state_corrupt");
  });

  it("preserves empty procedure filter semantics at the public query boundary", async () => {
    const { service, backend } = await fixture();
    const result = await service.query({
      ...target,
      kind: "fact",
      procedureId: "",
    });
    expect(result.records.map((record) => record.recordId)).toEqual(["fact"]);
    expect(backend.queryNullMem.mock.calls[0][0].procedureId).toBeUndefined();
  });

  it("fails unavailable placement before touching selected memory", async () => {
    const { selection, backend } = await fixture();
    const lifecycle = {
      resolveForActor: jest.fn<LocalBranchLifecycle["resolveForActor"]>(),
      readPlacement: jest.fn<LocalBranchLifecycle["readPlacement"]>(),
      requireActivePlacement: jest
        .fn<LocalBranchLifecycle["requireActivePlacement"]>()
        .mockRejectedValue(new BranchStateError("state_unavailable")),
    };
    const service = createLocalNullMemService(
      { ...selection, lifecycle },
      { actorAccountId: "actor", canReadSensitive: true },
    );
    await expect(service.query({ ...target })).rejects.toThrow(
      "state_unavailable",
    );
    await expect(
      service.createFact({ ...target, fact: { text: "new" } }),
    ).rejects.toThrow("state_unavailable");
    expect(backend.queryNullMem).not.toHaveBeenCalled();
    expect(backend.putNullMem).not.toHaveBeenCalled();
  });
});
