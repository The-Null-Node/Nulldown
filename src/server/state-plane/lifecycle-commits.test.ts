import { describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BranchInitializeRecord,
  BranchLifecycleStatePlane,
  BranchReserveRecord,
} from "../../../shared/drop/branch-lifecycle";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import type { BranchStateHead } from "../../../shared/drop/branch-state";
import { getBranchContent } from "../../../functions/api/_lib/branches/http/read";
import { issueAccountSessionToken } from "../../../functions/api/_lib/accounts/session/token";
import { MemoryR2Bucket } from "../../../functions/api/_lib/diffs/testing/storage-fixture";
import type { SqlMetadataStore, SqlStatement } from "../ports";
import { createLocalBranchLifecycle } from "./application-lifecycle";
import { MemoryBranchCommitStatePlane } from "./memory-commits";
import { SqliteBranchCommitStatePlane } from "./sqlite-commits";
import { LocalBranchSqlite } from "./local-sqlite";
import { observeBranchSql, type BranchSqlObservation } from "./sqlite-port";
import { referenceSourceHash, rejectsCode } from "./testing/commit-contract";
import {
  RpcBranchCommitStatePlane,
  branchStateRpcResult,
  type BranchStateRpcStub,
} from "../../../packages/nulldown-state-plane/src/shard-router";

const reserve = (): BranchReserveRecord => ({
  target: { rootDropId: "Lifecycle001", branchId: "owner" },
  placement: { routingVersion: 1, generation: 7 },
  reservationId: "reservation-1",
  rootRevision: "revision-1",
  identity: {
    baseDropId: "Lifecycle001",
    mode: "owner",
    ownerAccountId: "account-1",
    writerAccountId: "account-1",
    writerClientId: "client-1",
  },
});
const initialize = (content = ""): BranchInitializeRecord => {
  const { target, placement, reservationId, rootRevision } = reserve();
  return { target, placement, reservationId, rootRevision, content };
};
const query = () => ({
  target: reserve().target,
  placement: reserve().placement,
});
const event = (id: string): DropDiffEvent => ({
  eventId: id,
  dropId: reserve().target.rootDropId,
  sourceClientId: "client-1",
  createdAt: 3000,
  seq: -1,
  ops: [{ type: "insert", start: 10000, end: 10000, text: id }],
});

const stubFor = (plane: BranchLifecycleStatePlane): BranchStateRpcStub => ({
  readPlacement: (q) => branchStateRpcResult(() => plane.readPlacement(q)),
  reserve: (q) => branchStateRpcResult(() => plane.reserve(q)),
  initialize: (q) => branchStateRpcResult(() => plane.initialize(q)),
  readSnapshot: (q) => branchStateRpcResult(() => plane.readSnapshot(q)),
  listSnapshots: (q) => branchStateRpcResult(() => plane.listSnapshots(q)),
  append: (q) => branchStateRpcResult(() => plane.append(q)),
  appendBatch: (q) => branchStateRpcResult(() => plane.appendBatch(q)),
  readHead: (q) => branchStateRpcResult(() => plane.readHead(q)),
  readContent: (q) => branchStateRpcResult(() => plane.readContent(q)),
  readEvents: (q) => branchStateRpcResult(() => plane.readEvents(q)),
});

for (const backend of ["memory", "sqlite", "rpc-sqlite"] as const) {
  const run = async (
    test: (plane: BranchLifecycleStatePlane) => Promise<void>,
    now: () => number = () => 2000,
  ) => {
    const sql = backend === "memory" ? undefined : new LocalBranchSqlite();
    try {
      const plane = sql
        ? new SqliteBranchCommitStatePlane(sql, { now })
        : await MemoryBranchCommitStatePlane.create([], now);
      await test(
        backend === "rpc-sqlite"
          ? new RpcBranchCommitStatePlane(() => stubFor(plane))
          : plane,
      );
    } finally {
      sql?.close();
    }
  };
  describe(`reserved lifecycle: ${backend}`, () => {
    it("retains readable authority and exact retries after a nonnegative wall-clock rollback", async () => {
      let now = 2000;
      await run(
        async (plane) => {
          await plane.reserve(reserve());
          const initial = await plane.initialize(initialize("initial"));
          expect(initial.receipt.initialHead.branch.updatedAt).toBe(2000);
          const blobs = new MemoryR2Bucket();
          const sql: SqlMetadataStore = {
            prepare(statement) {
              expect(statement).toContain("FROM account_library_entries");
              const statementPort: SqlStatement = {
                bind() {
                  return statementPort;
                },
                async first<T>() {
                  return {
                    drop_id: query().target.rootDropId,
                    account_id: "account-1",
                    visibility: "private",
                    deleted_at: null,
                  } as T;
                },
                async all() {
                  throw Error("Unexpected SQL list");
                },
                async run() {
                  throw Error("Unexpected SQL write");
                },
              };
              return statementPort;
            },
          };
          const lifecycle = createLocalBranchLifecycle({
            mode: "local-test",
            blobs,
            sql,
            backend: plane,
            isEligibleRoot: (id) => id === query().target.rootDropId,
            initialPlacement: query().placement,
          });
          now = 1999;
          const command = { ...query(), events: [event("rollback-clock")] };
          const accepted = await plane.appendBatch(command);
          expect(accepted.acceptedEvents).toHaveLength(1);
          expect(accepted.branch).toMatchObject({
            createdAt: 2000,
            updatedAt: 1999,
            headSnapshotId: 1,
          });
          const verify = async () => {
            expect(
              await plane.readPlacement({ target: query().target }),
            ).toMatchObject({
              state: "active",
              reservation: { createdAt: 2000 },
            });
            const head = await plane.readHead(query());
            expect(head.branch).toEqual(accepted.branch);
            expect(
              (await plane.readContent({ ...query(), version: head.version }))
                .content,
            ).toBe("initialrollback-clock");
            expect(
              await lifecycle.resolveForActor(
                query().target.rootDropId,
                "account-1",
                "client-1",
              ),
            ).toEqual({ branch: head.branch, created: false });
          };
          await verify();
          const replay = await plane.appendBatch(command);
          expect(replay.acceptedEvents).toEqual([]);
          expect(replay.deduplicatedCount).toBe(1);
          expect(replay.acknowledgements).toEqual(
            accepted.acknowledgements.map((ack) => ({
              ...ack,
              status: "duplicate",
            })),
          );
          expect(await plane.initialize(initialize("initial"))).toEqual({
            status: "duplicate",
            receipt: initial.receipt,
          });
          await verify();
        },
        () => now,
      );
    });

    it("publishes pending before bytes, converges account clients and source proposals, then activates snapshot zero", () =>
      run(async (plane) => {
        expect(
          await plane.readPlacement({ target: query().target }),
        ).toBeNull();
        await rejectsCode(() => plane.readHead(query()), "branch_not_found");
        const candidate = reserve();
        const other = reserve();
        other.reservationId = "other";
        other.rootRevision = "new-revision";
        other.identity.writerClientId = "client-2";
        const results = await Promise.all([
          plane.reserve(candidate),
          plane.reserve(other),
        ]);
        expect(results.map((result) => result.status)).toEqual([
          "reserved",
          "existing",
        ]);
        expect(results[1].authority).toEqual(results[0].authority);
        expect(results[0].authority).toMatchObject({
          state: "pending",
          backend: "state-plane",
          reservation: {
            reservationId: "reservation-1",
            rootRevision: "revision-1",
            createdAt: 2000,
            identity: { writerClientId: "client-1" },
          },
        });
        await rejectsCode(
          () => plane.readHead(query()),
          "branch_initialization_pending",
        );
        await rejectsCode(
          () =>
            plane.initialize({ ...initialize(), rootRevision: "new-revision" }),
          "branch_initialization_conflict",
        );
        await rejectsCode(
          () => plane.initialize({ ...initialize(), reservationId: "other" }),
          "branch_initialization_conflict",
        );
        const result = await plane.initialize(initialize());
        expect(result.status).toBe("created");
        expect(result.receipt.initialHead).toMatchObject({
          version: {
            snapshotId: 0,
            eventSeq: -1,
            sourceContentHash: referenceSourceHash(""),
          },
          branch: {
            createdAt: 2000,
            updatedAt: 2000,
            headSnapshotId: 0,
            headEventSeq: -1,
            writerClientId: "client-1",
          },
        });
        expect(
          (await plane.readPlacement({ target: query().target }))?.state,
        ).toBe("active");
        const zero = (await plane.readSnapshot({ ...query(), snapshotId: 0 }))!;
        expect(zero.version).toEqual(result.receipt.initialHead.version);
        expect(zero.snapshot).toMatchObject({
          parentSnapshotId: null,
          eventIds: [],
          patchStartSeq: null,
          patchEndSeq: null,
          textLength: 0,
        });
        expect(
          (await plane.readContent({ ...query(), version: zero.version }))
            .content,
        ).toBe("");
        expect(
          await plane.readSnapshot({ ...query(), snapshotId: 1 }),
        ).toBeNull();
      }));

    it("fences principal collisions, generation, revision and immutable intent, including UTF-8 hash collisions", () =>
      run(async (plane) => {
        await plane.reserve(reserve());
        for (const field of [
          "baseDropId",
          "ownerAccountId",
          "writerAccountId",
        ] as const) {
          const command = reserve();
          command.identity[field] = "different";
          await rejectsCode(
            () => plane.reserve(command),
            "branch_initialization_conflict",
          );
        }
        const stale = {
          ...query(),
          placement: { routingVersion: 1, generation: 6 },
        };
        await rejectsCode(
          () => plane.reserve({ ...reserve(), ...stale }),
          "routing_generation_mismatch",
        );
        await rejectsCode(
          () => plane.initialize({ ...initialize(), ...stale }),
          "routing_generation_mismatch",
        );
        await rejectsCode(
          () => plane.readHead(stale),
          "routing_generation_mismatch",
        );
        const command = initialize("\ud800");
        expect(referenceSourceHash(command.content)).toBe(
          referenceSourceHash("\ufffd"),
        );
        const [first, replay] = await Promise.all([
          plane.initialize(command),
          plane.initialize(command),
        ]);
        expect([first.status, replay.status].sort()).toEqual([
          "created",
          "duplicate",
        ]);
        expect(replay.receipt).toEqual(first.receipt);
        await rejectsCode(
          () => plane.initialize(initialize("\ufffd")),
          "branch_initialization_conflict",
        );
        await rejectsCode(
          () => plane.initialize({ ...command, ...stale }),
          "routing_generation_mismatch",
        );
        await rejectsCode(
          () => plane.readSnapshot({ ...stale, snapshotId: 0 }),
          "routing_generation_mismatch",
        );
      }));

    it("captures inputs before async work and returns independent records", () =>
      run(async (plane) => {
        const proposal = reserve();
        const reservation = plane.reserve(proposal);
        proposal.identity.writerAccountId = "mutated";
        proposal.target.rootDropId = "mutated";
        const result = await reservation;
        result.authority.reservation.identity.writerAccountId = "mutated";
        const command = initialize("original\ud800");
        const pending = plane.initialize(command);
        command.content = "mutated";
        command.placement.generation = 100;
        const initialized = await pending;
        initialized.receipt.initialHead.branch.writerAccountId = "mutated";
        const head = await plane.readHead(query());
        expect(head.branch.writerAccountId).toBe("account-1");
        expect(
          (await plane.readContent({ ...query(), version: head.version }))
            .content,
        ).toBe("original\ud800");
      }));

    it("publishes exactly one of two conflicting concurrent initializations", () =>
      run(async (plane) => {
        await plane.reserve(reserve());
        const results = await Promise.allSettled([
          plane.initialize(initialize("left")),
          plane.initialize(initialize("right")),
        ]);
        const successes = results.filter(
          (result) => result.status === "fulfilled",
        );
        const failures = results.filter(
          (result) => result.status === "rejected",
        );
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(failures[0].reason).toMatchObject({
          code: "branch_initialization_conflict",
        });
        const head = await plane.readHead(query());
        const content = (
          await plane.readContent({ ...query(), version: head.version })
        ).content;
        expect(["left", "right"]).toContain(content);
        expect(await plane.initialize(initialize(content))).toEqual({
          status: "duplicate",
          receipt: successes[0].value.receipt,
        });
      }));

    it("replays original initialization after edits and pages an exact captured history through concurrent appends", () =>
      run(async (plane) => {
        await plane.reserve(reserve());
        const original = await plane.initialize(initialize("zero"));
        for (let index = 0; index < 202; index++)
          await plane.appendBatch({
            ...query(),
            events: [event(`a${index}`), event(`b${index}`)],
          });
        const captured = await plane.readHead(query());
        expect(captured.version).toMatchObject({
          snapshotId: 202,
          eventSeq: 403,
        });
        const first = await plane.listSnapshots({
          ...query(),
          version: captured.version,
          afterSnapshotId: -1,
          limit: 200,
        });
        expect(first.snapshots.map((row) => row.version.snapshotId)).toEqual(
          Array.from({ length: 200 }, (_, index) => index),
        );
        expect(first.nextAfterSnapshotId).toBe(199);
        expect(first.snapshots[1].version.eventSeq).toBe(1);
        await plane.appendBatch({ ...query(), events: [event("later")] });
        const last = await plane.listSnapshots({
          ...query(),
          version: captured.version,
          afterSnapshotId: 199,
          limit: 200,
        });
        expect(last.snapshots.map((row) => row.version.snapshotId)).toEqual([
          200, 201, 202,
        ]);
        expect(last.nextAfterSnapshotId).toBeNull();
        expect(last.snapshots[2].version).toEqual(captured.version);
        expect(
          await plane.listSnapshots({
            ...query(),
            version: captured.version,
            afterSnapshotId: 202,
            limit: 1,
          }),
        ).toEqual({ snapshots: [], nextAfterSnapshotId: null });
        const replay = await plane.initialize(initialize("zero"));
        expect(replay).toEqual({
          status: "duplicate",
          receipt: original.receipt,
        });
        expect((await plane.readHead(query())).version.snapshotId).toBe(203);
        for (const version of [
          { ...captured.version, eventSeq: 402 },
          {
            ...captured.version,
            sourceContentHash: referenceSourceHash("wrong"),
          },
        ])
          await rejectsCode(
            () =>
              plane.listSnapshots({
                ...query(),
                version,
                afterSnapshotId: -1,
                limit: 1,
              }),
            "snapshot_version_mismatch",
          );
        for (const limit of [0, 201, 1.5])
          await rejectsCode(
            () =>
              plane.listSnapshots({
                ...query(),
                version: captured.version,
                afterSnapshotId: -1,
                limit,
              }),
            "invalid_command",
          );
      }));

    it("keeps lossless target identities and client-only principals separate", () =>
      run(async (plane) => {
        for (const branchId of ["clone_\ud800", "clone_\ufffd"]) {
          const command = reserve();
          command.target.branchId = branchId;
          command.identity = {
            ...command.identity,
            mode: "clone",
            writerAccountId: null,
            writerClientId: branchId,
          };
          await plane.reserve(command);
          await rejectsCode(
            () =>
              plane.reserve({
                ...command,
                identity: { ...command.identity, writerClientId: "different" },
              }),
            "branch_initialization_conflict",
          );
          await plane.initialize({
            ...initialize(branchId),
            target: command.target,
          });
          const snapshot = (await plane.readSnapshot({
            ...query(),
            target: command.target,
            snapshotId: 0,
          }))!;
          expect(
            (
              await plane.readContent({
                target: snapshot.target,
                placement: snapshot.placement,
                version: snapshot.version,
              })
            ).content,
          ).toBe(branchId);
        }
      }));
  });
}

describe("durable lifecycle rollback/reopen", () => {
  const corruptHeads: [string, (head: BranchStateHead) => void][] = [
    ...(
      [
        "baseDropId",
        "ownerAccountId",
        "writerAccountId",
        "writerClientId",
      ] as const
    ).map((field): [string, (head: BranchStateHead) => void] => [
      field,
      (head) => {
        head.branch[field] = "intruder";
      },
    ]),
    [
      "mode",
      (head) => {
        head.branch.mode = "clone";
      },
    ],
    [
      "createdAt",
      (head) => {
        head.branch.createdAt++;
      },
    ],
    [
      "status",
      (head) => {
        head.branch.status = "archived";
      },
    ],
    [
      "heap version",
      (head) => {
        head.branch.snapshotHeapVersion = 1;
      },
    ],
    [
      "checkpoint interval",
      (head) => {
        head.branch.checkpointInterval = 1;
      },
    ],
    [
      "updatedAt",
      (head) => {
        head.branch.updatedAt = -1;
      },
    ],
    [
      "event bound",
      (head) => {
        head.version.eventSeq = -1;
        head.branch.headEventSeq = -1;
        head.version.snapshotId = 2;
        head.branch.headSnapshotId = 2;
      },
    ],
    [
      "snapshot bound",
      (head) => {
        head.version.snapshotId = -1;
        head.branch.headSnapshotId = -1;
      },
    ],
    [
      "zero event bound",
      (head) => {
        head.version.snapshotId = 0;
        head.branch.headSnapshotId = 0;
        head.version.eventSeq = 0;
        head.branch.headEventSeq = 0;
      },
    ],
  ];
  it.each(corruptHeads)(
    "rejects corrupt immutable head %s before returning authority, cached content, history or accepting writes",
    async (_name, mutate) => {
      const raw = new LocalBranchSqlite();
      try {
        const plane = new SqliteBranchCommitStatePlane(raw, {
          now: () => 2000,
        });
        await plane.reserve(reserve());
        await plane.initialize(initialize("private content"));
        for (const edited of [false, true]) {
          if (edited)
            await plane.appendBatch({
              ...query(),
              events: [event("accepted")],
            });
          const good = await plane.readHead(query());
          const contentQuery = { ...query(), version: good.version };
          await plane.readContent(contentQuery); // Warm cache must not bypass durable identity.
          const broken = structuredClone(good);
          mutate(broken);
          raw.execute(
            "UPDATE branch_heads SET head_json = ?",
            JSON.stringify(broken),
          );
          const before = [
            "branch_snapshots",
            "branch_events",
            "branch_receipts",
            "branch_outbox",
          ].map((table) => raw.rows(`SELECT * FROM ${table}`));
          for (const read of [
            () => plane.readPlacement({ target: query().target }),
            () => plane.readHead(query()),
            () => plane.readContent(contentQuery),
            () => plane.readSnapshot({ ...query(), snapshotId: 0 }),
            () =>
              plane.listSnapshots({ ...good, afterSnapshotId: -1, limit: 10 }),
            () => plane.reserve(reserve()),
            () => plane.initialize(initialize("private content")),
            () =>
              plane.appendBatch({ ...query(), events: [event("rejected")] }),
          ])
            await rejectsCode(read, "state_corrupt");
          if (edited)
            await rejectsCode(
              () =>
                plane.readEvents({ ...contentQuery, startSeq: 0, endSeq: 0 }),
              "state_corrupt",
            );
          expect(
            [
              "branch_snapshots",
              "branch_events",
              "branch_receipts",
              "branch_outbox",
            ].map((table) => raw.rows(`SELECT * FROM ${table}`)),
          ).toEqual(before);
          raw.execute(
            "UPDATE branch_heads SET head_json = ?",
            JSON.stringify(good),
          );
        }
      } finally {
        raw.close();
      }
    },
  );

  it("requires authority after initialization and validates the immutable receipt on ordinary reads", async () => {
    const raw = new LocalBranchSqlite();
    try {
      const plane = new SqliteBranchCommitStatePlane(raw, { now: () => 2000 });
      await plane.reserve(reserve());
      const result = await plane.initialize(initialize("secret"));
      const receipt = structuredClone(result.receipt);
      receipt.initialHead.branch.writerClientId = "different-original-client";
      raw.execute(
        "UPDATE branch_authorities SET initialization_receipt_json = ?",
        JSON.stringify(receipt),
      );
      await rejectsCode(
        () => plane.readPlacement({ target: query().target }),
        "state_corrupt",
      );
      await rejectsCode(() => plane.readHead(query()), "state_corrupt");
      raw.execute("DELETE FROM branch_authorities");
      const reopened = new SqliteBranchCommitStatePlane(raw);
      await rejectsCode(() => reopened.readHead(query()), "state_corrupt");
      await rejectsCode(
        () =>
          reopened.readContent({
            ...query(),
            version: result.receipt.initialHead.version,
          }),
        "state_corrupt",
      );
    } finally {
      raw.close();
    }
  });

  it("returns state_corrupt rather than leaking private HTTP content when the persisted writer is changed", async () => {
    const raw = new LocalBranchSqlite();
    try {
      const plane = new SqliteBranchCommitStatePlane(raw);
      await plane.reserve(reserve());
      const initialized = await plane.initialize(
        initialize("PRIVATE CONTENT MUST NOT LEAK"),
      );
      const blobs = new MemoryR2Bucket();
      const sql: SqlMetadataStore = {
        prepare(statement) {
          expect(statement).toContain("FROM account_library_entries");
          const query: SqlStatement = {
            bind() {
              return query;
            },
            async first<T>() {
              return {
                drop_id: reserve().target.rootDropId,
                account_id: "account-1",
                visibility: "private",
                deleted_at: null,
              } as T;
            },
            async all() {
              throw Error("Unexpected SQL list");
            },
            async run() {
              throw Error("Unexpected SQL write");
            },
          };
          return query;
        },
      };
      const secret = "local-corruption-regression-secret";
      const env = {
        R2_BUCKET: blobs,
        DB: sql,
        ACCOUNT_AUTH_SECRET: secret,
        ALLOW_INSECURE_ACCOUNT_HEADER: "0",
        localBranchApplication: {
          mode: "local-test" as const,
          commits: plane,
          history: plane,
          placement: query().placement,
          lifecycle: createLocalBranchLifecycle({
            mode: "local-test",
            blobs,
            sql,
            backend: plane,
            isEligibleRoot: (id) => id === query().target.rootDropId,
            initialPlacement: query().placement,
          }),
        },
      };
      const { token } = await issueAccountSessionToken("intruder", env);
      const request = new Request("https://local.test/content?snapshotId=0", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const params = { rootId: query().target.rootDropId, branchId: "owner" };
      expect((await getBranchContent(env, params, request)).status).toBe(404);
      const broken = structuredClone(initialized.receipt.initialHead);
      broken.branch.writerAccountId = "intruder";
      raw.execute(
        "UPDATE branch_heads SET head_json = ?",
        JSON.stringify(broken),
      );
      const response = await getBranchContent(env, params, request);
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain("state_corrupt");
      expect(body).not.toContain("PRIVATE CONTENT MUST NOT LEAK");
    } finally {
      raw.close();
    }
  });

  it("rolls back failed reservations and retains committed pending ownership after a lost response", async () => {
    for (const phase of ["before", "after"] as const) {
      const raw = new LocalBranchSqlite();
      try {
        let armed = false;
        const port = observeBranchSql(raw, (row) => {
          if (armed && row.operation === "execute" && row.phase === phase)
            throw Error("reservation cut");
        });
        const plane = new SqliteBranchCommitStatePlane(port);
        armed = true;
        await rejectsCode(() => plane.reserve(reserve()), "state_unavailable");
        expect(
          await new SqliteBranchCommitStatePlane(raw).readPlacement({
            target: query().target,
          }),
        ).toBeNull();
        let lose = false;
        const lost = new SqliteBranchCommitStatePlane(
          observeBranchSql(raw, (row) => {
            if (
              lose &&
              row.operation === "transaction" &&
              row.phase === "after"
            )
              throw Error("lost reservation response");
          }),
          { now: () => 2000 },
        );
        lose = true;
        await rejectsCode(() => lost.reserve(reserve()), "state_unavailable");
        const recovered = new SqliteBranchCommitStatePlane(raw);
        const winner = await recovered.reserve({
          ...reserve(),
          reservationId: "retry",
          rootRevision: "later",
        });
        expect(winner).toMatchObject({
          status: "existing",
          authority: {
            state: "pending",
            reservation: {
              reservationId: "reservation-1",
              rootRevision: "revision-1",
              createdAt: 2000,
            },
          },
        });
      } finally {
        raw.close();
      }
    }
  });

  it("rejects stale registry generation even on hot content and initialization receipt replay", async () => {
    const raw = new LocalBranchSqlite();
    try {
      const plane = new SqliteBranchCommitStatePlane(raw);
      await plane.reserve(reserve());
      await plane.initialize(initialize("zero"));
      const head = await plane.readHead(query());
      await plane.readContent({ ...query(), version: head.version });
      const authority = (await plane.readPlacement({
        target: query().target,
      }))!;
      authority.placement.generation++;
      raw.execute(
        "UPDATE branch_authorities SET authority_json = ?",
        JSON.stringify(authority),
      );
      await rejectsCode(
        () => plane.readContent({ ...query(), version: head.version }),
        "routing_generation_mismatch",
      );
      await rejectsCode(
        () => plane.initialize(initialize("zero")),
        "routing_generation_mismatch",
      );
      await rejectsCode(
        () => plane.reserve(reserve()),
        "routing_generation_mismatch",
      );
    } finally {
      raw.close();
    }
  });

  it("keeps reservations across reopen, rolls back every activation statement, and retries a lost committed receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "branch-lifecycle-"));
    let raw: LocalBranchSqlite | undefined;
    try {
      const trace: BranchSqlObservation[] = [];
      raw = new LocalBranchSqlite(join(directory, "trace.sqlite"));
      const sample = new SqliteBranchCommitStatePlane(
        observeBranchSql(raw, (row) => trace.push(row)),
        { now: () => 2000 },
      );
      await sample.reserve(reserve());
      trace.length = 0;
      await sample.initialize(initialize("zero"));
      const cuts = trace.filter((row) => row.operation !== "transaction");
      expect(
        cuts.some((row) => row.sql?.includes("UPDATE branch_authorities")),
      ).toBe(true);
      raw.close();
      raw = undefined;
      for (let cut = 0; cut < cuts.length; cut++) {
        const path = join(directory, `${cut}.sqlite`);
        raw = new LocalBranchSqlite(path);
        await new SqliteBranchCommitStatePlane(raw, {
          now: () => 2000,
        }).reserve(reserve());
        raw.close();
        raw = new LocalBranchSqlite(path);
        let armed = false,
          at = 0,
          fired = false;
        const port = observeBranchSql(raw, (row) => {
          if (armed && row.operation !== "transaction" && at++ === cut) {
            fired = true;
            throw Error("activation cut");
          }
        });
        const plane = new SqliteBranchCommitStatePlane(port);
        armed = true;
        await rejectsCode(
          () => plane.initialize(initialize("zero")),
          "state_unavailable",
        );
        expect(fired).toBe(true);
        raw.close();
        raw = new LocalBranchSqlite(path);
        const reopened = new SqliteBranchCommitStatePlane(raw);
        expect(
          (await reopened.readPlacement({ target: query().target }))?.state,
        ).toBe("pending");
        for (const table of [
          "branch_heads",
          "branch_snapshots",
          "branch_events",
          "branch_receipts",
          "branch_outbox",
        ])
          expect(
            raw.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,
          ).toBe(0);
        const committed = await reopened.initialize(initialize("zero"));
        await reopened.appendBatch({ ...query(), events: [event("later")] });
        raw.close();
        raw = new LocalBranchSqlite(path);
        const recovered = new SqliteBranchCommitStatePlane(raw);
        expect(await recovered.initialize(initialize("zero"))).toEqual({
          status: "duplicate",
          receipt: committed.receipt,
        });
        expect((await recovered.readHead(query())).version.snapshotId).toBe(1);
        raw.close();
        raw = undefined;
      }
    } finally {
      raw?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed placement, missing interior snapshots and mismatched snapshot metadata", async () => {
    const sql = new LocalBranchSqlite();
    try {
      const plane = new SqliteBranchCommitStatePlane(sql);
      await plane.reserve(reserve());
      await plane.initialize(initialize());
      for (const id of ["a", "b", "c"])
        await plane.appendBatch({ ...query(), events: [event(id)] });
      const head = await plane.readHead(query());
      sql.execute("DELETE FROM branch_snapshots WHERE snapshot_id = 1");
      await rejectsCode(
        () => plane.readSnapshot({ ...query(), snapshotId: 1 }),
        "state_corrupt",
      );
      await rejectsCode(
        () =>
          plane.listSnapshots({
            ...query(),
            version: head.version,
            afterSnapshotId: -1,
            limit: 200,
          }),
        "state_corrupt",
      );
      sql.execute(
        "UPDATE branch_snapshots SET snapshot_json = '{}' WHERE snapshot_id = 0",
      );
      await rejectsCode(
        () => plane.readSnapshot({ ...query(), snapshotId: 0 }),
        "state_corrupt",
      );
      sql.execute("UPDATE branch_authorities SET authority_json = '{}' ");
      await rejectsCode(
        () => plane.readPlacement({ target: query().target }),
        "state_corrupt",
      );
      await rejectsCode(() => plane.reserve(reserve()), "state_corrupt");
    } finally {
      sql.close();
    }
  });

  it("keeps new history reads bounded and indexed without selecting content", async () => {
    const raw = new LocalBranchSqlite();
    try {
      const trace: BranchSqlObservation[] = [];
      const plane = new SqliteBranchCommitStatePlane(
        observeBranchSql(raw, (row) => trace.push(row)),
      );
      await plane.reserve(reserve());
      await plane.initialize(initialize());
      for (let index = 0; index < 25; index++)
        await plane.appendBatch({ ...query(), events: [event(String(index))] });
      const head = await plane.readHead(query());
      trace.length = 0;
      await plane.listSnapshots({
        ...query(),
        version: head.version,
        afterSnapshotId: -1,
        limit: 10,
      });
      const reads = trace.filter(
        (row) => row.operation === "rows" && row.phase === "before",
      );
      expect(reads).toHaveLength(3);
      expect(reads.every((row) => !/s\.content/.test(row.sql!))).toBe(true);
      const page = reads.find((row) =>
        row.sql!.includes("ORDER BY s.snapshot_id ASC"),
      )!;
      const plan = raw.rows<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${page.sql}`,
        JSON.stringify(query().target.rootDropId),
        JSON.stringify(query().target.branchId),
        -1,
        25,
        10,
      );
      expect(plan.every((row) => !/\bSCAN\b/.test(row.detail))).toBe(true);
    } finally {
      raw.close();
    }
  });
});

describe("lifecycle RPC failures", () => {
  it.each(["created", "duplicate"] as const)(
    "rejects genuine wrong-content %s receipts, including UTF-16 hash collisions",
    async (status) => {
      for (const [requested, returned] of [
        ["expected", "wrong"],
        ["\ud800", "\ufffd"],
      ]) {
        const plane = await MemoryBranchCommitStatePlane.create();
        await plane.reserve(reserve());
        const wrong = await plane.initialize(initialize(returned));
        const rpc = new RpcBranchCommitStatePlane(() => ({
          ...stubFor(plane),
          initialize: async () => ({ ok: true, value: { ...wrong, status } }),
        }));
        if (requested === "\ud800")
          expect(referenceSourceHash(requested)).toBe(
            referenceSourceHash(returned),
          );
        await rejectsCode(
          () => rpc.initialize(initialize(requested)),
          "state_corrupt",
        );
        // Even a correct intent hash cannot excuse a mismatched initial source version.
        const correct = await MemoryBranchCommitStatePlane.create();
        await correct.reserve(reserve());
        const receipt = (await correct.initialize(initialize(requested)))
          .receipt;
        receipt.initialHead.version.sourceContentHash =
          referenceSourceHash("another source");
        const tampered = new RpcBranchCommitStatePlane(() => ({
          ...stubFor(plane),
          initialize: async () => ({ ok: true, value: { status, receipt } }),
        }));
        await rejectsCode(
          () => tampered.initialize(initialize(requested)),
          "state_corrupt",
        );
      }
    },
  );

  it("captures initialization content and identity before hashing or RPC can yield", async () => {
    const plane = await MemoryBranchCommitStatePlane.create();
    await plane.reserve(reserve());
    const rpc = new RpcBranchCommitStatePlane(() => stubFor(plane));
    const command = initialize("original\ud800");
    const result = rpc.initialize(command);
    command.content = "changed";
    command.target.rootDropId = "changed";
    command.placement.generation++;
    command.reservationId = "changed";
    const created = await result;
    expect(created.status).toBe("created");
    expect(
      (
        await plane.readContent({
          ...query(),
          version: created.receipt.initialHead.version,
        })
      ).content,
    ).toBe("original\ud800");
  });

  it("rejects malformed response identities and content-free transport errors", async () => {
    const plane = await MemoryBranchCommitStatePlane.create();
    await plane.reserve(reserve());
    await plane.initialize(initialize());
    const stub = stubFor(plane);
    const broken = new RpcBranchCommitStatePlane(() => ({
      ...stub,
      readPlacement: async () => ({
        ok: true,
        value: {
          ...(await plane.readPlacement({ target: query().target }))!,
          target: { rootDropId: "wrong", branchId: "owner" },
        },
      }),
    }));
    await rejectsCode(
      () => broken.readPlacement({ target: query().target }),
      "state_corrupt",
    );
    const unavailable = new RpcBranchCommitStatePlane(() => {
      throw Error("secret root bytes");
    });
    await rejectsCode(
      () => unavailable.reserve(reserve()),
      "state_unavailable",
    );
  });
});
