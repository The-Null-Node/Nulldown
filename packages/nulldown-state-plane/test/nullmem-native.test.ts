import assert from "node:assert/strict";
import type { BranchHeadQuery } from "../../../shared/drop/branch-state";
import type {
  BranchNullMemPutCommand,
  BranchNullMemPutResult,
  BranchNullMemQueryResult,
  BranchNullMemOutbox,
} from "../../../shared/drop/branch-nullmem";
import { assertRecords } from "../../../src/server/state-plane/testing/commit-contract";

interface NativeCommand {
  action: string;
  query: BranchHeadQuery;
  value?: unknown;
  cut?: number;
  loseResponse?: boolean;
}
interface Inspection {
  bootId: string;
  r2Calls: number;
  counts: Record<string, number>;
  outbox: BranchNullMemOutbox[];
  identities: { identity: string }[];
}
interface Cut {
  result: { ok: boolean; error?: { code: string } };
  trace: { operation: string; phase: string; sql?: string }[];
  fired: boolean;
}
const unwrap = <T>(wire: unknown): T => {
  const result = wire as { ok: boolean; value: T };
  assert.equal(result.ok, true, JSON.stringify(wire));
  return result.value;
};

/** Exercises production DO RPC methods and native SQLite rollback without adding public routes or authority fallbacks. */
export async function runNativeNullMemContract(
  call: (command: NativeCommand) => Promise<unknown>,
  seed: () => Promise<{ query: BranchHeadQuery }>,
) {
  const command = (
    query: BranchHeadQuery,
    id = "\ud800:%2F",
  ): BranchNullMemPutCommand => ({
    ...query,
    actorAccountId: "fixture-owner",
    record: {
      version: 1,
      kind: "fact",
      ...query.target,
      recordId: id,
      text: "alpha beta",
      createdAt: 1,
      priority: 0.5,
      metadata: { actorAccountId: "preserved", value: "\ud800" },
    },
  });
  const read = async (query: BranchHeadQuery, selection = {}) =>
    unwrap<BranchNullMemQueryResult>(
      await call({
        action: "nullmem-query",
        query,
        value: { ...query, limit: 100, ...selection },
      }),
    );
  const write = async (value: BranchNullMemPutCommand) =>
    unwrap<BranchNullMemPutResult>(
      await call({
        action: "nullmem-put",
        query: { target: value.target, placement: value.placement },
        value,
      }),
    );
  const inspect = async (query: BranchHeadQuery) =>
    (await call({ action: "nullmem-inspect", query })) as Inspection;
  const { query } = await seed();
  assert.equal((await read(query)).head.version.snapshotId, 0);
  const input = command(query);
  Object.defineProperty(input.record, "__proto__", {
    enumerable: true,
    value: { literal: "\udfff" },
  });
  Object.assign(input.record, { extension: { value: "\ud800" } });
  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () => write(input)),
  );
  assertRecords(
    concurrent.map((row) => row.memoryRevision).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal((await read(query)).records.length, 1);
  assertRecords(concurrent[0].record.metadata, input.record.metadata);
  assertRecords(JSON.parse(JSON.stringify(concurrent[0].record)).__proto__, {
    literal: "\udfff",
  });
  await write(command(query, "�:%2F"));
  const procedure: BranchNullMemPutCommand = {
    ...input,
    record: {
      version: 1,
      kind: "procedure",
      ...query.target,
      recordId: input.record.recordId,
      goal: "alpha beta",
      summary: "procedure",
      steps: [],
      outcome: "success",
      createdAt: 1,
    },
  };
  await write(procedure);
  assert.equal((await read(query)).records.length, 3);
  assert.equal(
    (await read(query, { procedureId: input.record.recordId, limit: 1 }))
      .records[0].kind,
    "procedure",
  );
  const removed = unwrap<{ memoryRevision: number }>(
    await call({
      action: "nullmem-delete",
      query,
      value: {
        ...query,
        actorAccountId: "fixture-owner",
        recordId: input.record.recordId,
      },
    }),
  );
  assert.equal(removed.memoryRevision, 9);
  assertRecords(
    (await read(query)).records.map((row) => row.recordId),
    ["�:%2F"],
  );
  const lost = (await call({
    action: "nullmem-cut",
    query,
    value: { operation: "put", command: input },
    loseResponse: true,
  })) as Cut;
  assert.equal(lost.result.error?.code, "state_unavailable");
  const before = await inspect(query);
  assert.equal(before.outbox.length, 10);
  assert.equal(before.r2Calls, 0);
  assert.ok(
    before.identities.some(
      (row) => row.identity === JSON.stringify(["fact", "\ud800:%2F"]),
    ),
  );
  await call({ action: "reset", query });
  const after = await inspect(query);
  assert.notEqual(after.bootId, before.bootId);
  assertRecords(after.outbox, before.outbox);
  assert.equal((await write(input)).memoryRevision, 11);
  assert.equal((await read(query)).records.length, 2);

  const cutsEvidence: unknown[] = [];
  for (const operation of ["put", "delete"] as const) {
    const prepare = async () => {
      const { query } = await seed();
      const put = command(query);
      await write(put);
      await write({ ...put, record: { ...procedure.record, ...query.target } });
      const mutation =
        operation === "put"
          ? { operation, command: put }
          : {
              operation,
              command: {
                ...query,
                actorAccountId: "fixture-owner",
                recordId: put.record.recordId,
              },
            };
      return { query, mutation };
    };
    const sample = await prepare();
    const observed = (await call({
      action: "nullmem-cut",
      query: sample.query,
      value: sample.mutation,
    })) as Cut;
    assert.equal(observed.result.ok, true);
    const checkpoints = observed.trace.filter(
      (row) => row.operation !== "transaction",
    );
    const cuts = checkpoints.flatMap((row, index) =>
      row.operation === "execute" ? [index] : [],
    );
    assert.equal(cuts.length, operation === "put" ? 6 : 8);
    for (const cut of cuts) {
      const fixture = await prepare();
      const prior = await read(fixture.query);
      const durable = await inspect(fixture.query);
      const interrupted = (await call({
        action: "nullmem-cut",
        query: fixture.query,
        value: fixture.mutation,
        cut,
      })) as Cut;
      assert.equal(interrupted.fired, true);
      assert.equal(interrupted.result.error?.code, "state_unavailable");
      assertRecords(await read(fixture.query), prior);
      assertRecords((await inspect(fixture.query)).outbox, durable.outbox);
      cutsEvidence.push({
        operation,
        cut,
        checkpoint: checkpoints[cut],
        fired: interrupted.fired,
      });
    }
  }
  return {
    before,
    after,
    lost: lost.result,
    concurrentRevisions: concurrent.map((row) => row.memoryRevision),
    cuts: cutsEvidence,
  };
}
