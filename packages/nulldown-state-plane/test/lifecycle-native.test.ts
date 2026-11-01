import assert from "node:assert/strict";
import type {
  BranchAuthorityRecord,
  BranchInitializeOutcome,
  BranchInitializeRecord,
  BranchReserveOutcome,
  BranchReserveRecord,
  BranchSnapshotState,
  BranchSnapshotPage,
} from "../../../shared/drop/branch-lifecycle";
import type {
  BranchHeadQuery,
  BranchStateContent,
} from "../../../shared/drop/branch-state";
import {
  assertRecords,
  assertUtf16,
} from "../../../src/server/state-plane/testing/commit-contract";

interface NativeCommand {
  action: string;
  query: BranchHeadQuery;
  value?: unknown;
  cut?: number;
  loseResponse?: boolean;
}
interface CutResult {
  result: {
    ok: boolean;
    error?: { code: string };
    value?: BranchInitializeOutcome;
  };
  trace: { operation: string; phase: string; sql?: string }[];
  fired: boolean;
}

const unwrap = <T>(input: unknown): T => {
  const result = input as { ok: boolean; value: T };
  assert.equal(result.ok, true, JSON.stringify(input));
  return result.value;
};

/** Exercises real workerd RPC receivers, including strict lifecycle fields and native activation rollback. */
export async function runNativeLifecycleContract(
  call: (command: NativeCommand) => Promise<unknown>,
): Promise<void> {
  const reserve = (branchId: string): BranchReserveRecord => ({
    target: { rootDropId: "NativeLifecycle001", branchId },
    placement: { routingVersion: 1, generation: 7 },
    reservationId: "native-reservation",
    rootRevision: "native-revision",
    identity: {
      baseDropId: "NativeLifecycle001",
      mode: "clone",
      ownerAccountId: "native-owner",
      writerAccountId: "native-writer",
      writerClientId: "native-client",
    },
  });
  const queryFor = (command: BranchReserveRecord): BranchHeadQuery => ({
    target: command.target,
    placement: command.placement,
  });
  const initialize = (
    command: BranchReserveRecord,
  ): BranchInitializeRecord => ({
    ...queryFor(command),
    reservationId: command.reservationId,
    rootRevision: command.rootRevision,
    content: "native\ud800",
  });
  const command = reserve("roundtrip");
  const query = queryFor(command);
  assert.equal(unwrap(await call({ action: "placement", query })), null);
  // These complete commands must reach the real receiver: a memory-backed RPC fake misses strict-head projection bugs.
  const pending = unwrap<BranchReserveOutcome>(
    await call({ action: "reserve", query, value: command }),
  );
  assert.equal(pending.status, "reserved");
  assert.equal(pending.authority.state, "pending");
  const second = unwrap<BranchReserveOutcome>(
    await call({
      action: "reserve",
      query,
      value: {
        ...command,
        reservationId: "other",
        rootRevision: "later",
        identity: { ...command.identity, writerClientId: "second-client" },
      },
    }),
  );
  assertRecords(second.authority, pending.authority);
  const created = unwrap<BranchInitializeOutcome>(
    await call({ action: "initialize", query, value: initialize(command) }),
  );
  assert.equal(created.status, "created");
  assertRecords(created.receipt.initialHead.version, {
    snapshotId: 0,
    eventSeq: -1,
    sourceContentHash: created.receipt.initialHead.version.sourceContentHash,
  });
  const snapshot = unwrap<BranchSnapshotState>(
    await call({
      action: "snapshot",
      query,
      value: { ...query, snapshotId: 0 },
    }),
  );
  assertRecords(snapshot.version, created.receipt.initialHead.version);
  assertRecords(snapshot.snapshot.eventIds, []);
  const page = unwrap<BranchSnapshotPage>(
    await call({
      action: "snapshots",
      query,
      value: {
        ...query,
        version: snapshot.version,
        afterSnapshotId: -1,
        limit: 200,
      },
    }),
  );
  assertRecords(page, { snapshots: [snapshot], nextAfterSnapshotId: null });
  const content = unwrap<BranchStateContent>(
    await call({
      action: "content",
      query,
      value: { ...query, version: snapshot.version },
    }),
  );
  assertUtf16(content.content, "native\ud800");
  assert.equal(
    unwrap(
      await call({
        action: "snapshot",
        query,
        value: { ...query, snapshotId: 1 },
      }),
    ),
    null,
  );
  assertRecords(
    unwrap(
      await call({ action: "initialize", query, value: initialize(command) }),
    ),
    { status: "duplicate", receipt: created.receipt },
  );

  const sample = reserve("cut-sample");
  const sampleQuery = queryFor(sample);
  unwrap(await call({ action: "reserve", query: sampleQuery, value: sample }));
  const observed = (await call({
    action: "initialize-cut",
    query: sampleQuery,
    value: initialize(sample),
  })) as CutResult;
  unwrap(observed.result);
  const cuts = observed.trace.filter((row) => row.operation !== "transaction");
  assert.ok(cuts.some((row) => row.sql?.includes("UPDATE branch_authorities")));
  for (let cut = 0; cut < cuts.length; cut++) {
    const proposal = reserve(`cut-${cut}`);
    const target = queryFor(proposal);
    unwrap(await call({ action: "reserve", query: target, value: proposal }));
    const failed = (await call({
      action: "initialize-cut",
      query: target,
      value: initialize(proposal),
      cut,
    })) as CutResult;
    assert.equal(failed.fired, true);
    assert.equal(failed.result.ok, false);
    assert.equal(failed.result.error?.code, "state_unavailable");
    const ownership = unwrap<BranchAuthorityRecord>(
      await call({ action: "placement", query: target }),
    );
    assert.equal(ownership.state, "pending");
    const inspected = (await call({ action: "inspect", query: target })) as {
      counts: Record<string, number>;
      r2Calls: number;
      bootId: string;
    };
    assertRecords(inspected.counts, {
      branch_heads: 0,
      branch_snapshots: 0,
      branch_events: 0,
      branch_receipts: 0,
      branch_outbox: 0,
    });
    assert.equal(inspected.r2Calls, 0);
    if (cut === cuts.length - 1) {
      const reset = (await call({ action: "reset", query: target })) as {
        fixtureError?: string;
      };
      assert.ok(reset.fixtureError);
      const after = (await call({ action: "inspect", query: target })) as {
        bootId: string;
      };
      assert.notEqual(after.bootId, inspected.bootId);
      assertRecords(
        unwrap(await call({ action: "placement", query: target })),
        ownership,
      );
    }
    const recovered = unwrap<BranchInitializeOutcome>(
      await call({
        action: "initialize",
        query: target,
        value: initialize(proposal),
      }),
    );
    assert.equal(recovered.status, "created");
  }

  const lost = reserve("lost-ack");
  const lostQuery = queryFor(lost);
  unwrap(await call({ action: "reserve", query: lostQuery, value: lost }));
  const lostResponse = (await call({
    action: "initialize-cut",
    query: lostQuery,
    value: initialize(lost),
    loseResponse: true,
  })) as CutResult;
  assert.equal(lostResponse.result.error?.code, "state_unavailable");
  assert.equal(
    unwrap<BranchAuthorityRecord>(
      await call({ action: "placement", query: lostQuery }),
    ).state,
    "active",
  );
  const recovered = unwrap<BranchInitializeOutcome>(
    await call({
      action: "initialize",
      query: lostQuery,
      value: initialize(lost),
    }),
  );
  assert.equal(recovered.status, "duplicate");
  const reset = (await call({ action: "reset", query: lostQuery })) as {
    fixtureError?: string;
  };
  assert.ok(reset.fixtureError);
  assertRecords(
    unwrap(
      await call({
        action: "initialize",
        query: lostQuery,
        value: initialize(lost),
      }),
    ),
    recovered,
  );
}
