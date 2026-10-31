import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DropDiffEvent } from "../../../../shared/drop/diff";
import type {
  BranchAppendRecord,
  BranchCommitOutboxRecord,
  BranchCommitReceipt,
  BranchCommitStatePlane,
  BranchHeadQuery,
  BranchStateVersion,
} from "../../../../shared/drop/branch-state";
import type { MemoryBranchStateSeed } from "../memory-commits";

/** A test-lifetime backend; inspections must read its actual authoritative storage. */
export interface CommitContractBackend {
  plane: BranchCommitStatePlane;
  inspectOutbox(query: BranchHeadQuery): Promise<BranchCommitOutboxRecord[]>;
  close(): Promise<void>;
}

/** Creates an isolated explicitly seeded backend for each independent scenario. */
export type CommitContractFactory = (
  seed: MemoryBranchStateSeed,
) => Promise<CommitContractBackend>;

/** Independent SHA-256 reference, deliberately not using production hash helpers. */
export function referenceSourceHash(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update("nulldown.source-content.v1\n", "utf8")
    .update(content, "utf8")
    .digest("base64url")}`;
}

const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, ordered(child)]),
    );
  }
  return value;
};

/** Compares complete JSON wire values across Jest VM/workerd structured-clone realms. */
export function assertRecords(actual: unknown, expected: unknown): void {
  assert.equal(
    JSON.stringify(ordered(actual)),
    JSON.stringify(ordered(expected)),
  );
}

/** Independently constructs a wire command; assigned sequence and snapshot are not identity. */
export function referenceCommand(
  query: BranchHeadQuery,
  expected: BranchStateVersion,
  event: DropDiffEvent,
): BranchAppendRecord {
  const identity = {
    eventId: event.eventId,
    dropId: event.dropId,
    sourceClientId: event.sourceClientId,
    createdAt: event.createdAt,
    ops: event.ops,
    metadata: event.metadata,
  };
  return {
    ...structuredClone(query),
    expected: structuredClone(expected),
    event: { ...structuredClone(identity), seq: -1 },
    payloadHash: referenceSourceHash(
      "nulldown.branch-event.v1\n" + JSON.stringify(ordered(identity)),
    ),
  };
}

/** Legal UTF-16 splice reference. It has no dependency on application diff/replay code. */
export function referenceApply(content: string, event: DropDiffEvent): string {
  for (const operation of event.ops) {
    assert.equal(
      operation.native,
      undefined,
      "generated subset is legacy insert/delete",
    );
    const start = operation.start!,
      end = operation.end!;
    assert.ok(
      Number.isSafeInteger(start) && end >= start && end <= content.length,
    );
    if (operation.type === "insert") {
      content = content.slice(0, start) + operation.text + content.slice(start);
    } else if (operation.type === "delete") {
      content = content.slice(0, start) + content.slice(end);
    } else assert.fail("unsupported oracle operation");
  }
  return content;
}

/** Synthetic snapshot-zero seed with no application data or credentials. */
export function contractSeed(branchId = "owner"): MemoryBranchStateSeed {
  return {
    branch: {
      version: 1,
      rootDropId: "OracleRoot001",
      baseDropId: "OracleRoot001",
      branchId,
      mode: "owner",
      status: "active",
      ownerAccountId: "fixture-owner",
      writerAccountId: "fixture-owner",
      writerClientId: null,
      headSnapshotId: 0,
      headEventSeq: -1,
      snapshotHeapVersion: 2,
      checkpointInterval: 24,
      createdAt: 1000,
      updatedAt: 1000,
    },
    placement: { routingVersion: 1, generation: 7 },
    content: "",
  };
}

/** Exact initial identity computed from fixture intent, not a backend read. */
export function initialQuery(seed = contractSeed()): BranchHeadQuery {
  return {
    target: {
      rootDropId: seed.branch.rootDropId,
      branchId: seed.branch.branchId,
    },
    placement: seed.placement,
  };
}

/** Independent immutable content version. */
export function referenceVersion(
  snapshotId: number,
  content: string,
): BranchStateVersion {
  return {
    snapshotId,
    eventSeq: snapshotId - 1,
    sourceContentHash: referenceSourceHash(content),
  };
}

/** One synthetic append event; offsets are explicit UTF-16 units. */
export function contractEvent(
  id: string,
  text: string,
  followsSeq: number,
  start = 0,
): DropDiffEvent {
  return {
    eventId: id,
    dropId: "OracleRoot001",
    sourceClientId: "fixture-writer",
    createdAt: 1000 + followsSeq + 1,
    seq: -1,
    ops: [{ type: "insert", start, end: start, text }],
    metadata: { followsSeq },
  };
}

/** Strict portable-code assertion works for local errors and explicitly decoded native RPC errors. */
export async function rejectsCode(
  run: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error !== null && typeof error === "object" && "code" in error);
    assert.equal(error.code, code);
    return true;
  });
}

/** Immutable receipts are expected independently, including original placement and payload hash. */
export function referenceReceipt(
  command: BranchAppendRecord,
  snapshotId: number,
  content: string,
): BranchCommitReceipt {
  return {
    target: command.target,
    placement: command.placement,
    eventId: command.event.eventId,
    payloadHash: command.payloadHash,
    version: referenceVersion(snapshotId, content),
  };
}

/** Compares UTF-16 units explicitly: UTF-8 hashes cannot detect lone-surrogate substitution. */
export function assertUtf16(actual: string, expected: string): void {
  const units = (text: string) =>
    Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  assertRecords(units(actual), units(expected));
  assert.equal(actual, expected);
}

/** Lossless fixtures use colliding UTF-8 strings in the SAME native shard per group.
 * The routing reference is independent of production routing and storage codecs. */
export function losslessFixtures() {
  const variants = ["\ud800", "\ud801", "\ufffd"];
  const special = '"\\\u0000\n\t:end';
  const shard = (root: string, branch: string) =>
    createHash("sha256")
      .update(
        "nulldown.branch-shard.v1\n" + JSON.stringify([root, branch]),
        "utf8",
      )
      .digest()
      .readUInt32BE(0) % 16;
  return ["root", "branch"].flatMap((dimension) => {
    let targets: { rootDropId: string; branchId: string }[] = [];
    for (let salt = 0; salt < 100_000; salt++) {
      targets = variants.map((unit) =>
        dimension === "root"
          ? {
              rootDropId: `lossless-root-${unit}${special}`,
              branchId: `lossless-fixed-${salt}${special}`,
            }
          : {
              rootDropId: `lossless-fixed-${salt}${special}`,
              branchId: `lossless-branch-${unit}${special}`,
            },
      );
      if (
        new Set(targets.map((t) => shard(t.rootDropId, t.branchId))).size === 1
      )
        break;
    }
    assert.equal(
      new Set(targets.map((t) => shard(t.rootDropId, t.branchId))).size,
      1,
    );
    return targets.map((target, index) => {
      const seed = contractSeed(target.branchId);
      seed.branch.rootDropId = seed.branch.baseDropId = target.rootDropId;
      seed.content = ["\ud800", "\udc00", "😀"][index];
      const query = initialQuery(seed);
      let content = seed.content;
      const history = ["\ud800", "\ud801", "\ufffd", "\udc00", "\\ud800"].map(
        (unit, seq) => {
          const event = contractEvent(
            `lossless-event-${unit}${special}`,
            special + `insert-${seq}\\ud800`,
            seq - 1,
            content.length,
          );
          event.dropId = target.rootDropId;
          if (seq === 0 && index === 2) {
            const start = dimension === "root" ? 0 : 1;
            event.ops = [{ type: "delete", start, end: start + 1, text: "" }];
          }
          const command = referenceCommand(
            query,
            referenceVersion(seq, content),
            event,
          );
          content = referenceApply(content, event);
          if (seq === 0 && index === 2)
            assertUtf16(content, dimension === "root" ? "\ude00" : "\ud83d");
          return {
            command,
            content,
            receipt: referenceReceipt(command, seq + 1, content),
          };
        },
      );
      return { seed, query, history };
    });
  });
}

/** Exact snapshot reads are repeated for cold/warm paths, then historical content is revisited. */
export async function verifyLosslessHistory(
  plane: BranchCommitStatePlane,
  fixture: ReturnType<typeof losslessFixtures>[number],
): Promise<void> {
  const { query, seed, history } = fixture;
  const head = await plane.readHead(query);
  assertRecords(head.target, query.target);
  assertRecords(head.version, history.at(-1)!.receipt.version);
  const versions = [
    { content: seed.content, version: referenceVersion(0, seed.content) },
    ...history.map((row) => ({
      content: row.content,
      version: row.receipt.version,
    })),
  ];
  for (const exact of [...versions, versions[0], versions[1]]) {
    for (let read = 0; read < 2; read++) {
      const actual = await plane.readContent({
        ...query,
        version: exact.version,
      });
      assertRecords(actual.target, query.target);
      assertUtf16(actual.content, exact.content);
    }
  }
  for (const row of history)
    assertRecords(await plane.append(row.command), {
      status: "duplicate",
      receipt: row.receipt,
    });
  assertRecords(
    await plane.readEvents({
      ...query,
      version: history.at(-1)!.receipt.version,
      startSeq: 0,
      endSeq: history.length - 1,
    }),
    history.map((row, seq) => ({
      ...row.command.event,
      seq,
      snapshotId: seq + 1,
    })),
  );
}

/** A replayable generated history; expected strings/versions precede backend execution. */
export function contractHistory(count: number, seed = 0x28c0ffee) {
  let randomState = seed >>> 0,
    content = "";
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return randomState >>> 0;
  };
  const alphabet = ["A", "é", "e\u0301", "🧪", "漢字", "\n", "🏳️‍🌈", "\u0000"];
  const query = initialQuery();
  const commands: {
    command: BranchAppendRecord;
    content: string;
    receipt: BranchCommitReceipt;
  }[] = [];
  for (let index = 0; index < count; index++) {
    const event = contractEvent(
      `seed-${seed}-${index}`,
      alphabet[random() % alphabet.length],
      index - 1,
      content.length,
    );
    if (content.length && random() % 4 === 0) {
      const last = Array.from(content).at(-1)!;
      const start = content.length - last.length;
      event.ops = [
        { type: "delete", start, end: content.length, text: last },
        { ...event.ops[0], start, end: start },
      ];
    }
    const command = referenceCommand(
      query,
      referenceVersion(index, content),
      event,
    );
    content = referenceApply(content, event);
    commands.push({
      command,
      content,
      receipt: referenceReceipt(command, index + 1, content),
    });
  }
  return commands;
}

type Scenario = {
  name: string;
  run: (backend: CommitContractBackend) => Promise<void>;
};

/** Backend-neutral scenarios with independent expectations; no memory backend is treated as an oracle. */
export const commitContractScenarios: readonly Scenario[] = [
  ...[0x28c0ffee, 0x28c0a103].map((seed): Scenario => ({
    name: `seeded ${seed} history: 1/10/24/25/100, stable exact versions and contiguous ranges`,
    async run({ plane, inspectOutbox }) {
      const query = initialQuery(),
        history = contractHistory(100, seed);
      assert.equal(
        (
          await plane.readContent({
            ...query,
            version: referenceVersion(0, ""),
          })
        ).content,
        "",
      );
      for (const [index, expected] of history.entries()) {
        assertRecords(await plane.append(expected.command), {
          status: "accepted",
          receipt: expected.receipt,
        });
        if ([1, 10, 24, 25, 100].includes(index + 1)) {
          assertRecords(
            (await plane.readHead(query)).version,
            expected.receipt.version,
          );
          for (const exact of [history[0], expected]) {
            assert.equal(
              (
                await plane.readContent({
                  ...query,
                  version: exact.receipt.version,
                })
              ).content,
              exact.content,
            );
          }
          assertRecords(
            await plane.readEvents({
              ...query,
              version: expected.receipt.version,
              startSeq: 0,
              endSeq: index,
            }),
            history.slice(0, index + 1).map((item, i) => ({
              ...item.command.event,
              seq: i,
              snapshotId: i + 1,
            })),
          );
        }
      }
      assertRecords(await plane.append(history[0].command), {
        status: "duplicate",
        receipt: history[0].receipt,
      });
      const outbox = await inspectOutbox(query);
      assert.equal(outbox.length, 100);
      assertRecords(
        outbox
          .map((row) => row.receipt)
          .sort((a, b) => a.version.snapshotId - b.version.snapshotId),
        history.map((item) => item.receipt),
      );
      assert.equal(new Set(outbox.map((row) => row.id)).size, 100);
      for (const row of outbox)
        assert.equal(
          row.id,
          JSON.stringify([
            "branch.commit.v1",
            query.target.rootDropId,
            query.target.branchId,
            row.receipt.eventId,
          ]),
        );
    },
  })),
  {
    name: "generation precedes duplicate and changed payload; identity precedes stale head",
    async run({ plane, inspectOutbox }) {
      const query = initialQuery(),
        command = contractHistory(1)[0].command;
      const original = await plane.append(command);
      const changed = referenceCommand(query, command.expected, {
        ...command.event,
        metadata: { followsSeq: -1, intent: "different metadata" },
      });
      for (const c of [command, changed])
        await rejectsCode(
          () =>
            plane.append({
              ...c,
              placement: { routingVersion: 1, generation: 6 },
            }),
          "routing_generation_mismatch",
        );
      await rejectsCode(() => plane.append(changed), "diff_event_id_reused");
      const stale = referenceCommand(query, command.expected, {
        ...command.event,
        eventId: "new-stale",
      });
      await rejectsCode(() => plane.append(stale), "diff_predecessor_mismatch");
      await rejectsCode(
        () =>
          plane.append({
            ...command,
            placement: { routingVersion: 2, generation: 7 },
          }),
        "routing_version_unsupported",
      );
      assertRecords(await plane.append(command), {
        ...original,
        status: "duplicate",
      });
      assert.equal((await inspectOutbox(query)).length, 1);
    },
  },
  {
    name: "missing branches do not initialize; invalid hash/version/range never mutates",
    async run({ plane, inspectOutbox }) {
      const query = initialQuery(),
        initial = referenceVersion(0, ""),
        command = contractHistory(1)[0].command;
      const absent = {
        ...query,
        target: { ...query.target, branchId: "absent" },
      };
      await rejectsCode(() => plane.readHead(absent), "branch_not_found");
      await rejectsCode(
        () => plane.append({ ...command, target: absent.target }),
        "branch_not_found",
      );
      await rejectsCode(() => plane.readHead(absent), "branch_not_found");
      await rejectsCode(
        () =>
          plane.append({
            ...command,
            payloadHash: referenceSourceHash("forged"),
          }),
        "invalid_command",
      );
      await rejectsCode(
        () =>
          plane.append({
            ...command,
            expected: {
              ...initial,
              sourceContentHash: referenceSourceHash("wrong"),
            },
          }),
        "diff_predecessor_mismatch",
      );
      await rejectsCode(
        () =>
          plane.readContent({
            ...query,
            version: { ...initial, snapshotId: 1 },
          }),
        "snapshot_not_found",
      );
      await rejectsCode(
        () =>
          plane.readContent({
            ...query,
            version: {
              ...initial,
              sourceContentHash: referenceSourceHash("wrong"),
            },
          }),
        "snapshot_version_mismatch",
      );
      await rejectsCode(
        () =>
          plane.readContent({ ...query, version: { ...initial, eventSeq: 0 } }),
        "snapshot_version_mismatch",
      );
      await rejectsCode(
        () =>
          plane.readEvents({
            ...query,
            version: initial,
            startSeq: 0,
            endSeq: 0,
          }),
        "invalid_command",
      );
      await rejectsCode(
        () =>
          plane.readEvents({
            ...query,
            version: { ...initial, eventSeq: 200 },
            startSeq: 0,
            endSeq: 200,
          }),
        "invalid_command",
      );
      assertRecords((await plane.readHead(query)).version, initial);
      assertRecords(await inspectOutbox(query), []);
    },
  },
  {
    name: "concurrent duplicate calls and different writers commit exactly once",
    async run({ plane, inspectOutbox }) {
      const query = initialQuery(),
        [first, second] = contractHistory(2);
      const duplicates = await Promise.all(
        Array.from({ length: 12 }, () =>
          plane.append(structuredClone(first.command)),
        ),
      );
      assert.equal(duplicates.filter((r) => r.status === "accepted").length, 1);
      for (const outcome of duplicates)
        assertRecords(outcome.receipt, first.receipt);
      const rival = referenceCommand(query, second.command.expected, {
        ...second.command.event,
        eventId: "rival",
        metadata: { followsSeq: 0, intent: "racing" },
      });
      const outcomes = await Promise.allSettled([
        plane.append(second.command),
        plane.append(rival),
      ]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      const failed = outcomes.find((r) => r.status === "rejected");
      assert.ok(failed?.status === "rejected");
      assert.equal(
        (failed.reason as { code: string }).code,
        "diff_predecessor_mismatch",
      );
      assert.equal((await plane.readHead(query)).version.snapshotId, 2);
      assert.equal((await inspectOutbox(query)).length, 2);
    },
  },
  {
    name: "same-ID different-metadata race; caller buffers cannot corrupt stored state",
    async run({ plane, inspectOutbox }) {
      const query = initialQuery(),
        first = contractHistory(1)[0];
      const alternate = referenceCommand(query, first.command.expected, {
        ...first.command.event,
        metadata: { followsSeq: -1, intent: "alternative" },
      });
      const outcomes = await Promise.allSettled([
        plane.append(first.command),
        plane.append(alternate),
      ]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = outcomes.find((r) => r.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.equal(
        (rejected.reason as { code: string }).code,
        "diff_event_id_reused",
      );
      const winner =
        outcomes[0].status === "fulfilled" ? first.command : alternate;
      const receipt = (await plane.append(winner)).receipt;
      receipt.version.snapshotId = 999;
      const head = await plane.readHead(query);
      head.branch.headSnapshotId = 999;
      const content = await plane.readContent({
        ...query,
        version: first.receipt.version,
      });
      content.content = "mutated";
      const events = await plane.readEvents({
        ...query,
        version: first.receipt.version,
        startSeq: 0,
        endSeq: 0,
      });
      events[0].ops[0].text = "mutated";
      const outbox = await inspectOutbox(query);
      outbox[0].receipt.eventId = "mutated";
      assertRecords(
        (await plane.append(winner)).receipt.version,
        first.receipt.version,
      );
      assert.equal(
        (await plane.readContent({ ...query, version: first.receipt.version }))
          .content,
        first.content,
      );
      assert.equal(
        (await inspectOutbox(query))[0].receipt.eventId,
        winner.event.eventId,
      );
      assert.equal((await plane.readHead(query)).branch.headSnapshotId, 1);
    },
  },
];

/** Executes scenarios sequentially with isolated state, usable from Jest or a native Node driver. */
export async function runCommitContract(
  factory: CommitContractFactory,
): Promise<string[]> {
  const passed: string[] = [];
  for (const scenario of commitContractScenarios) {
    const backend = await factory(contractSeed());
    try {
      await scenario.run(backend);
      passed.push(scenario.name);
    } finally {
      await backend.close();
    }
  }
  return passed;
}
