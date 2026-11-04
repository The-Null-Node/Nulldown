import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { BranchHeadQuery } from "../../../shared/drop/branch-state";
import {
  contractEvent,
  contractSeed,
  initialQuery,
  referenceCommand,
  referenceSourceHash,
} from "../../../src/server/state-plane/testing/commit-contract";

interface NativeCommand {
  action: string;
  query: BranchHeadQuery;
  value?: unknown;
}
interface DeliveryRow {
  status: string;
  n: number;
}
interface Inspection {
  state: { canonical: number; delivery: DeliveryRow[] };
  receiptCount: number;
  cursors: { domain: string; version: number }[];
  archiveCount: number;
  referenceOnly: boolean;
  projectionFailureArmed: boolean;
}
type Call = (command: NativeCommand) => Promise<unknown>;
const unwrap = <T>(wire: unknown): T => {
  const result = wire as { ok: boolean; value: T };
  assert.equal(result.ok, true, JSON.stringify(wire));
  return result.value;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exercises the production dispatch/queue/recovery handlers against native workerd SQLite, Queue, R2 and D1. */
export async function runNativeOutboxAcceptance(call: Call) {
  const roots: BranchHeadQuery[] = [];
  const root = async (prefix: string, content = "") => {
    const seed = contractSeed(`${prefix}-${randomUUID()}`);
    seed.branch.rootDropId = `${prefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    seed.content = content;
    const query = initialQuery(seed);
    roots.push(query);
    unwrap(await call({ action: "seed", query, value: [seed] }));
    return query;
  };
  const waitDelivered = async (
    query: BranchHeadQuery,
    expected: { domains: string[]; canonical: number },
  ) => {
    const deadline = Date.now() + 20_000;
    let state!: Inspection;
    do {
      state = (await call({ action: "inspect", query })) as Inspection;
      const cursors = state.cursors as { domain: string; version: number }[];
      const completed = state.state.delivery
        .filter((row) => row.status === "completed")
        .reduce((sum, row) => sum + row.n, 0);
      if (
        completed === expected.canonical &&
        state.state.canonical === expected.canonical &&
        state.receiptCount === expected.canonical &&
        expected.domains.every((domain) =>
          cursors.some((row) => row.domain === domain),
        )
      )
        return state;
      await sleep(100);
    } while (Date.now() < deadline);
    assert.fail(
      `native outbox delivery deadline: ${JSON.stringify({ state, expected })}`,
    );
  };
  const doc = await root("NativeDoc", "");
  const docEvent = contractEvent(`doc-${randomUUID()}`, "document event", -1);
  docEvent.dropId = doc.target.rootDropId;
  unwrap(
    await call({
      action: "append",
      query: doc,
      value: referenceCommand(
        doc,
        {
          snapshotId: 0,
          eventSeq: -1,
          sourceContentHash: referenceSourceHash(""),
        },
        docEvent,
      ),
    }),
  );
  await call({ action: "dispatch", query: doc });
  const docState = await waitDelivered(doc, {
    domains: ["document"],
    canonical: 1,
  });
  assert.equal(docState.archiveCount, 1);
  assert.equal(
    docState.state.delivery
      .filter((row) => row.status === "completed")
      .reduce((n, row) => n + row.n, 0),
    1,
  );
  assert.equal(
    docState.referenceOnly,
    true,
    "queue messages must contain references only",
  );

  // Production batch RPC creates one accepted batch intent, then production dispatcher and queue consumer archive it.
  const batched = await root("NativeBatch", "");
  const eventA = contractEvent(`batch-a-${randomUUID()}`, "batch", -1);
  const eventB = contractEvent(`batch-b-${randomUUID()}`, "!", 0, 5);
  eventA.dropId = batched.target.rootDropId;
  eventB.dropId = batched.target.rootDropId;
  unwrap(
    await call({
      action: "appendBatch",
      query: batched,
      value: { ...batched, events: [eventA, eventB] },
    }),
  );
  await call({ action: "dispatch", query: batched });
  const batchState = await waitDelivered(batched, {
    domains: ["document"],
    canonical: 1,
  });
  assert.equal(batchState.archiveCount, 2);

  // A runtime-fact intent is materialized by the production materializer, not fixture-generated archive content.
  const runtime = await root("NativeFact", "");
  unwrap(
    await call({
      action: "runtimeFact",
      query: runtime,
      value: {
        ...runtime,
        actorAccountId: "fixture-owner",
        fact: {
          version: 1,
          kind: "ui.state.patch",
          id: `runtime-${randomUUID()}`,
          callId: "native-call",
          createdAt: Date.now(),
          source: {
            ...runtime.target,
            snapshotId: 0,
            sourceContentHash: referenceSourceHash(""),
          },
          patch: [{ op: "set", path: ["native"], value: true }],
        },
      },
    }),
  );
  await call({ action: "dispatch", query: runtime });
  const factState = await waitDelivered(runtime, {
    domains: ["runtime_fact"],
    canonical: 1,
  });
  assert.equal(factState.archiveCount, 3);

  // Distinct fact and procedure mutations plus delete all create NullMem intents in their own projection domain.
  const memory = await root("NativeMemory", "");
  const now = Date.now();
  for (const record of [
    {
      version: 1,
      kind: "fact",
      recordId: `fact-${randomUUID()}`,
      ...memory.target,
      createdAt: now,
      text: "native fact",
    },
    {
      version: 1,
      kind: "procedure",
      recordId: `procedure-${randomUUID()}`,
      ...memory.target,
      createdAt: now + 1,
      goal: "native acceptance",
      summary: "procedure",
      steps: [],
      outcome: "success",
    },
  ])
    unwrap(
      await call({
        action: "nullmemPut",
        query: memory,
        value: { ...memory, actorAccountId: "fixture-owner", record },
      }),
    );
  unwrap(
    await call({
      action: "nullmemDelete",
      query: memory,
      value: {
        ...memory,
        actorAccountId: "fixture-owner",
        recordId: `absent-${randomUUID()}`,
      },
    }),
  );
  await call({ action: "dispatch", query: memory });
  const memoryState = await waitDelivered(memory, {
    domains: ["nullmem"],
    canonical: 3,
  });
  assert.equal(memoryState.archiveCount, 6);
  assert.equal(
    memoryState.cursors.find((row) => row.domain === "nullmem")?.version,
    3,
  );

  // Duplicate Queue delivery after completion is fenced stale, cannot create another receipt/archive.
  await call({ action: "duplicateLastQueue", query: doc });
  await sleep(1_000);
  const afterDuplicate = (await call({
    action: "inspect",
    query: doc,
  })) as Inspection;
  assert.equal(afterDuplicate.receiptCount, 1);
  assert.equal(afterDuplicate.archiveCount, 6);

  // A transient native D1 projection failure leaves a retryable durable claim; cron recovery later dispatches a fresh lease.
  const failed = await root("NativeRetry", "");
  const retryEvent = contractEvent(
    `retry-${randomUUID()}`,
    "retry content",
    -1,
  );
  retryEvent.dropId = failed.target.rootDropId;
  await call({ action: "failNextProjection", query: failed });
  unwrap(
    await call({
      action: "append",
      query: failed,
      value: referenceCommand(
        failed,
        {
          snapshotId: 0,
          eventSeq: -1,
          sourceContentHash: referenceSourceHash(""),
        },
        retryEvent,
      ),
    }),
  );
  await call({ action: "dispatch", query: failed });
  const failureDeadline = Date.now() + 10_000;
  let failedState!: Inspection;
  do {
    failedState = (await call({
      action: "inspect",
      query: failed,
    })) as Inspection;
    if (
      !failedState.projectionFailureArmed &&
      failedState.state.delivery.some((row) => row.status === "pending")
    )
      break;
    await sleep(100);
  } while (Date.now() < failureDeadline);
  assert.ok(
    failedState.state.delivery.some((row) => row.status === "pending"),
    "D1 failure must retain pending intent",
  );
  assert.equal(
    failedState.projectionFailureArmed,
    false,
    "one-shot D1 failure hook must be consumed",
  );
  assert.equal(failedState.receiptCount, 0);
  // Test-only SQL control makes the durable retry immediately due; the production DO alarm claims it and sends a Queue reference.
  await call({ action: "makeRetryDue", query: failed });
  await call({ action: "alarm", query: failed });
  const recovered = await waitDelivered(failed, {
    domains: ["document"],
    canonical: 1,
  });
  assert.equal(recovered.archiveCount, 7);

  // Retention clears completion timestamps only; durable intent/proof and tombstone prevent redispatch.
  const pruned = unwrap<{ pruned: number }>(
    await call({
      action: "prune",
      query: doc,
      value: { before: Date.now(), limit: 32 },
    }),
  );
  assert.ok(pruned.pruned >= 1);
  await call({ action: "dispatch", query: doc });
  await sleep(1_000);
  const afterPrune = (await call({
    action: "inspect",
    query: doc,
  })) as Inspection;
  assert.equal(afterPrune.state.canonical, 1);
  assert.equal(afterPrune.receiptCount, 1);
  assert.equal(afterPrune.archiveCount, 7);
  return roots;
}
