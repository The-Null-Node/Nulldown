import type {
  NullMemFactRecord,
  NullMemRecord,
} from "../../../../shared/nullmem/records";
import { createSqlNullMemRecordStore } from "../../../../src/server/stores/nullmem-record-store";
import type {
  QueryStore,
  WriteStore,
} from "../../../../src/server/stores/capabilities";
import { MemoryD1Database } from "../core/d1/testing/metadata-fixture";
import { createNullMemRepository } from "./repository";

const fact = (
  recordId: string,
  overrides: Partial<NullMemFactRecord> = {},
): NullMemFactRecord => ({
  version: 1,
  kind: "fact",
  recordId,
  rootDropId: "root",
  branchId: "branch",
  text: recordId,
  createdAt: 1,
  ...overrides,
});

describe("typed NullMem record persistence", () => {
  it("keeps global and branch selection, priority/date order, and kind filtering", async () => {
    const sql = new MemoryD1Database();
    const repository = createNullMemRepository({ sql });
    const records: NullMemRecord[] = [
      fact("low", { createdAt: 100 }),
      fact("global", {
        rootDropId: undefined,
        branchId: undefined,
        priority: 2,
      }),
      fact("newer", { priority: 2, createdAt: 2 }),
      fact("other-branch", { branchId: "other", priority: 100 }),
      fact("other-root", { rootDropId: "other", priority: 100 }),
      {
        version: 1,
        kind: "capability",
        recordId: "capability",
        capabilityKind: "tool",
        capabilityId: "example",
        description: "example",
        priority: 1,
        createdAt: 1,
      },
    ];
    for (const record of records) await repository.writeRecord(record);
    expect(
      (await repository.readRecords("root", "branch")).map(
        (record) => record.recordId,
      ),
    ).toEqual(["newer", "global", "capability", "low"]);
    expect(
      await repository.readRecords("root", "branch", {
        kind: "fact",
        limit: 2,
      }),
    ).toEqual([records[2], records[1]]);
    expect(
      await repository.readRecords("root", "branch", { kind: "capability" }),
    ).toEqual([records[5]]);
  });

  it("skips malformed stored JSON and wrong record kinds without normalizing historical values", async () => {
    const sql = new MemoryD1Database();
    const historical = {
      ...fact("historical", { createdAt: -0.5, confidence: 2 }),
      extra: { preserved: true },
    };
    const stored = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...fact("wrong"), kind: "snapshot" }),
      JSON.stringify({ ...fact("invalid"), text: 123 }),
      JSON.stringify(historical),
    ];
    stored.forEach((record_json, index) =>
      sql.nullmemRecords.set(String(index), {
        root_drop_id: "root",
        branch_id: "branch",
        record_kind: "fact",
        record_json,
        priority: 0,
        created_at: 1,
      }),
    );
    const repository = createNullMemRepository({ sql });
    expect(await repository.readRecords("root", "branch")).toEqual([
      historical,
    ]);
    // SQL limits before decoding: invalid rows still consume the selected page.
    expect(
      await repository.readRecords("root", "branch", { limit: 5 }),
    ).toEqual([]);
  });

  it("retains existing acceptance of valid records whose SQL kind projection disagrees", async () => {
    const sql = new MemoryD1Database();
    const record: NullMemRecord = {
      version: 1,
      kind: "procedure",
      recordId: "old",
      goal: "goal",
      summary: "summary",
      steps: [],
      outcome: "success",
      createdAt: 1,
    };
    sql.nullmemRecords.set("old", {
      root_drop_id: "root",
      branch_id: "branch",
      record_kind: "fact",
      record_json: JSON.stringify(record),
      priority: 0,
      created_at: 1,
    });
    expect(
      await createNullMemRepository({ sql }).readRecords("root", "branch", {
        kind: "fact",
      }),
    ).toEqual([record]);
  });

  it.each([
    [undefined, 250],
    [0, 1],
    [-10, 1],
    [2.9, 2],
    [1000, 500],
  ])("preserves query limit %s as %s", async (limit, expected) => {
    const sql = new MemoryD1Database();
    for (let index = 0; index < 510; index += 1) {
      sql.nullmemRecords.set(String(index), {
        root_drop_id: "root",
        branch_id: "branch",
        record_kind: "fact",
        record_json: JSON.stringify(fact(String(index))),
        priority: 0,
        created_at: index,
      });
    }
    expect(
      await createNullMemRepository({ sql }).readRecords("root", "branch", {
        limit,
      }),
    ).toHaveLength(expected);
  });

  it("composes adapter-bound query and write capabilities with no caller-selected result type", async () => {
    const sql = new MemoryD1Database();
    const store = createSqlNullMemRecordStore(sql);
    const writer: WriteStore<NullMemRecord> = store;
    const reader: QueryStore<
      { rootDropId: string; branchId: string },
      NullMemRecord
    > = store;
    const record = fact("bound");
    await writer.put(record);
    expect(
      await reader.query({ rootDropId: "root", branchId: "branch" }),
    ).toEqual([record]);
    if (false) {
      // @ts-expect-error The value type is bound at construction, not by the reader.
      await store.query<string>({ rootDropId: "root", branchId: "branch" });
      // @ts-expect-error Unrelated persisted values cannot be written through this capability.
      await store.put({ kind: "snapshot" });
      // @ts-expect-error This adapter does not offer a transaction guarantee.
      await store.tx(() => undefined);
    }
  });

  it("replaces records and deletes all matching branch-local record kinds", async () => {
    const sql = new MemoryD1Database();
    const repository = createNullMemRepository({ sql });
    await repository.writeRecord(fact("same"));
    await repository.writeRecord(fact("same", { text: "replacement" }));
    const procedure: NullMemRecord = {
      version: 1,
      kind: "procedure",
      recordId: "same",
      rootDropId: "root",
      branchId: "branch",
      goal: "goal",
      summary: "summary",
      steps: [],
      outcome: "success",
      createdAt: 1,
    };
    await repository.writeRecord(procedure);
    await repository.writeRecord(fact("same", { branchId: "other" }));
    expect(await repository.readRecords("root", "branch")).toEqual([
      fact("same", { text: "replacement" }),
      procedure,
    ]);
    await repository.deleteRecord("root", "branch", "same");
    expect(await repository.readRecords("root", "branch")).toEqual([]);
    expect(await repository.readRecords("root", "other")).toEqual([
      fact("same", { branchId: "other" }),
    ]);
  });

  it("preserves lazy missing-SQL errors", () => {
    const repository = createNullMemRepository({});
    const message = "SQL metadata store is required to use memory.";
    expect(() => repository.readRecords("root", "branch")).toThrow(message);
    expect(() => repository.writeRecord(fact("missing"))).toThrow(message);
    expect(() => repository.deleteRecord("root", "branch", "missing")).toThrow(
      message,
    );
  });
});
