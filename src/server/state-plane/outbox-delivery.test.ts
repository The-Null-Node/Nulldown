import { describe, expect, it } from "@jest/globals";
import { BranchStateError } from "../../../shared/drop/branch-state";
import {
  outboxRetryAt,
  outboxLeaseToken,
  validateOutboxClaim,
  validateOutboxClaimResult,
} from "./outbox-delivery";
import { MemoryBranchCommitStatePlane } from "./memory-commits";
import { LocalBranchSqlite } from "./local-sqlite";
import { SqliteBranchCommitStatePlane } from "./sqlite-commits";
import {
  contractSeed,
  initialQuery,
  referenceCommand,
} from "./testing/commit-contract";
import { makeEvent } from "../../../functions/api/_lib/diffs/testing/storage-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeBranchSql } from "./sqlite-port";

describe("outbox delivery primitives", () => {
  it("bounds claims and derives deterministic capped retry times", () => {
    const command = {
      leaseId: "worker-a",
      now: 100,
      leaseMs: 1_000,
      limit: 10,
    };
    expect(() => validateOutboxClaim(command)).not.toThrow();
    expect(() => validateOutboxClaim({ ...command, limit: 257 })).toThrow(
      BranchStateError,
    );
    expect(() =>
      validateOutboxClaim({ ...command, leaseMs: 15 * 60 * 1000 + 1 }),
    ).toThrow(BranchStateError);
    expect(outboxRetryAt(100, 1)).toBe(60_100);
    expect(outboxRetryAt(100, 2)).toBe(120_100);
    expect(outboxRetryAt(100, 50)).toBe(61_440_100);
    expect(outboxLeaseToken("sender:a", "b", 1)).not.toBe(
      outboxLeaseToken("sender", "a:b", 1),
    );
    expect(
      outboxLeaseToken("l".repeat(128), "\u0000".repeat(1024), 1).length,
    ).toBeLessThanOrEqual(32768);
  });

  it("rejects duplicate or malformed completion IDs", () => {
    const command = {
      leaseId: "worker",
      now: 0,
      items: [
        {
          target: { rootDropId: "r", branchId: "b" },
          placement: { routingVersion: 1, generation: 0 },
          outboxId: "a",
          leaseToken: "token",
        },
      ],
    };
    expect(() => validateOutboxClaimResult(command)).not.toThrow();
    expect(() =>
      validateOutboxClaimResult({
        ...command,
        items: [command.items[0], command.items[0]],
      }),
    ).toThrow(BranchStateError);
  });

  it.each(["memory", "sqlite"] as const)(
    "delivers, retries, expires, and retains completion proof with %s",
    async (adapter) => {
      const seed = contractSeed();
      const sql = adapter === "sqlite" ? new LocalBranchSqlite() : undefined;
      const plane =
        adapter === "sqlite"
          ? await SqliteBranchCommitStatePlane.create(sql!, [seed], {
              now: () => 2000,
            })
          : await MemoryBranchCommitStatePlane.create([seed], () => 2000);
      try {
        const query = initialQuery(seed);
        const event = {
          ...makeEvent({
            eventId: "outbox-contract-1",
            sourceClientId: "client",
            text: "x",
            createdAt: 2000,
            metadata: { followsSeq: -1 },
          }),
          dropId: query.target.rootDropId,
        };
        // Use the backend's initial version so event intent follows the same independent commit contract.
        const head = await plane.readHead(query);
        const append = await referenceCommand(query, head.version, event);
        await plane.append(append);
        const first = await plane.claimOutbox({
          leaseId: "sender",
          now: 10,
          leaseMs: 5,
          limit: 4,
        });
        expect(first.items).toHaveLength(1);
        const claimed = await plane.readClaimedOutbox({
          leaseId: "sender",
          now: 11,
          items: first.items,
        });
        expect(claimed[0].outbox.id).toBe(first.items[0].outboxId);
        const expired = await plane.claimOutbox({
          leaseId: "sender2",
          now: 16,
          leaseMs: 5,
          limit: 4,
        });
        expect(expired.items).toHaveLength(1);
        expect(
          (
            await plane.acknowledgeOutbox({
              leaseId: "sender",
              now: 17,
              items: first.items,
            })
          ).stale,
        ).toBe(1);
        const retry = await plane.retryOutbox({
          leaseId: "sender2",
          now: 17,
          items: expired.items,
          errorCode: "archive_unavailable",
        });
        expect(retry.retried).toBe(1);
        expect(
          (
            await plane.claimOutbox({
              leaseId: "sender3",
              now: 18,
              leaseMs: 5,
              limit: 4,
            })
          ).items,
        ).toHaveLength(0);
        const second = await plane.claimOutbox({
          leaseId: "sender3",
          now: 120_018,
          leaseMs: 5,
          limit: 4,
        });
        expect(second.items).toHaveLength(1);
        expect(
          (
            await plane.acknowledgeOutbox({
              leaseId: "sender3",
              now: 120_019,
              items: second.items,
            })
          ).acknowledged,
        ).toBe(1);
        expect(
          (
            await plane.acknowledgeOutbox({
              leaseId: "sender3",
              now: 120_020,
              items: second.items,
            })
          ).duplicate,
        ).toBe(1);
        expect(
          (
            await plane.acknowledgeOutbox({
              leaseId: "sender3",
              now: 120_021,
              items: [
                {
                  ...second.items[0],
                  target: {
                    ...second.items[0].target,
                    branchId: "forged-other-branch",
                  },
                },
              ],
            })
          ).stale,
        ).toBe(1);
        expect(
          (
            await plane.acknowledgeOutbox({
              leaseId: "sender3",
              now: 120_022,
              items: [
                {
                  ...second.items[0],
                  placement: { ...second.items[0].placement, generation: 8 },
                },
              ],
            })
          ).stale,
        ).toBe(1);
        expect(
          (
            await plane.claimOutbox({
              leaseId: "sender3",
              now: 130_000,
              leaseMs: 5,
              limit: 4,
            })
          ).items,
        ).toHaveLength(0);
        expect(
          (await plane.pruneCompletedOutbox({ before: 130_000, limit: 4 }))
            .pruned,
        ).toBe(1);
        expect(
          (
            await plane.claimOutbox({
              leaseId: "sender4",
              now: 130_001,
              leaseMs: 5,
              limit: 4,
            })
          ).items,
        ).toHaveLength(0);
      } finally {
        sql?.close();
      }
    },
  );

  it.each(["memory", "sqlite"] as const)(
    "enumerates all four canonical intent kinds in bounded pages with %s",
    async (adapter) => {
      const seed = contractSeed();
      const secondSeed = contractSeed("owner-two");
      secondSeed.placement.generation = 11;
      const sql = adapter === "sqlite" ? new LocalBranchSqlite() : undefined;
      const plane =
        adapter === "sqlite"
          ? await SqliteBranchCommitStatePlane.create(
              sql!,
              [seed, secondSeed],
              { now: () => 2000 },
            )
          : await MemoryBranchCommitStatePlane.create(
              [seed, secondSeed],
              () => 2000,
            );
      try {
        const query = initialQuery(seed);
        const secondQuery = initialQuery(secondSeed);
        const secondHead = await plane.readHead(secondQuery);
        await plane.append(
          referenceCommand(secondQuery, secondHead.version, {
            ...makeEvent({
              eventId: "other-branch-outbox",
              sourceClientId: "client",
              text: "z",
              createdAt: 1999,
              metadata: { followsSeq: -1 },
            }),
            dropId: secondQuery.target.rootDropId,
          }),
        );
        let head = await plane.readHead(query);
        await plane.append(
          referenceCommand(query, head.version, {
            ...makeEvent({
              eventId: "single-outbox",
              sourceClientId: "client",
              text: "a",
              createdAt: 2000,
              metadata: { followsSeq: -1 },
            }),
            dropId: query.target.rootDropId,
          }),
        );
        head = await plane.readHead(query);
        const batchEvent = {
          ...makeEvent({
            eventId: "batch-outbox",
            sourceClientId: "client",
            text: "b",
            createdAt: 2001,
            metadata: { followsSeq: head.version.eventSeq },
          }),
          dropId: query.target.rootDropId,
        };
        await plane.appendBatch({
          ...query,
          expected: head.version,
          events: [batchEvent],
        });
        head = await plane.readHead(query);
        await plane.appendRuntimeFact({
          ...query,
          actorAccountId: "fixture-owner",
          fact: {
            version: 1,
            kind: "ui.state.patch",
            id: "runtime-outbox",
            callId: "call",
            createdAt: 2002,
            source: {
              ...query.target,
              snapshotId: head.version.snapshotId,
              sourceContentHash: head.version.sourceContentHash,
            },
            patch: [{ op: "set", path: ["field"], value: "value" }],
          },
        });
        await plane.putNullMem({
          ...query,
          actorAccountId: "fixture-owner",
          record: {
            version: 1,
            kind: "fact",
            recordId: "nullmem-outbox",
            ...query.target,
            createdAt: 2003,
            text: "memory evidence",
          },
        });
        // Simulate pre-delivery-schema canonical rows; the durable bootstrap cursor must recover them.
        sql?.execute("DELETE FROM branch_outbox_delivery");
        const ids: string[] = [];
        const claimedGenerations: number[] = [];
        for (let i = 0; i < 3; i++) {
          const page = await plane.claimOutbox({
            leaseId: `page-${i}`,
            now: 20 + i,
            leaseMs: 10_000,
            limit: 2,
          });
          expect(page.items.length).toBeGreaterThan(0);
          const material = await plane.readClaimedOutbox({
            leaseId: page.leaseId,
            now: 21 + i,
            items: page.items,
          });
          ids.push(...material.map(({ outbox }) => outbox.kind));
          claimedGenerations.push(
            ...page.items.map(({ placement }) => placement.generation),
          );
          await plane.acknowledgeOutbox({
            leaseId: page.leaseId,
            now: 22 + i,
            items: page.items,
          });
        }
        expect(ids.sort()).toEqual([
          "branch.batch-commit.v1",
          "branch.commit.v1",
          "branch.commit.v1",
          "branch.nullmem.v1",
          "branch.runtime-fact.v1",
        ]);
        expect(claimedGenerations).toContain(11);
        expect(claimedGenerations).toContain(seed.placement.generation);
        expect(
          (
            await plane.claimOutbox({
              leaseId: "done",
              now: 100,
              leaseMs: 10,
              limit: 2,
            })
          ).items,
        ).toHaveLength(0);
      } finally {
        sql?.close();
      }
    },
  );

  it("recovers a live SQLite claim and completed tombstone across connection reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nulldown-outbox-"));
    const filename = join(directory, "outbox.sqlite");
    const seed = contractSeed();
    try {
      let sql = new LocalBranchSqlite(filename);
      let plane = await SqliteBranchCommitStatePlane.create(sql, [seed], {
        now: () => 2000,
      });
      const query = initialQuery(seed);
      const head = await plane.readHead(query);
      const event = {
        ...makeEvent({
          eventId: "restart-outbox",
          sourceClientId: "client",
          text: "x",
          createdAt: 2000,
          metadata: { followsSeq: -1 },
        }),
        dropId: query.target.rootDropId,
      };
      await plane.append(referenceCommand(query, head.version, event));
      const claim = await plane.claimOutbox({
        leaseId: "persistent-sender",
        now: 10,
        leaseMs: 100,
        limit: 1,
      });
      sql.close();

      sql = new LocalBranchSqlite(filename);
      plane = await SqliteBranchCommitStatePlane.create(sql, [], {
        now: () => 2000,
      });
      expect(
        (
          await plane.readClaimedOutbox({
            leaseId: claim.leaseId,
            now: 11,
            items: claim.items,
          })
        ).length,
      ).toBe(1);
      expect(
        (
          await plane.acknowledgeOutbox({
            leaseId: claim.leaseId,
            now: 12,
            items: claim.items,
          })
        ).acknowledged,
      ).toBe(1);
      await plane.pruneCompletedOutbox({ before: 12, limit: 10 });
      sql.close();

      sql = new LocalBranchSqlite(filename);
      plane = await SqliteBranchCommitStatePlane.create(sql, [], {
        now: () => 2000,
      });
      expect(
        (
          await plane.claimOutbox({
            leaseId: "after-restart",
            now: 1000,
            leaseMs: 10,
            limit: 10,
          })
        ).items,
      ).toHaveLength(0);
      expect(
        (
          await plane.acknowledgeOutbox({
            leaseId: claim.leaseId,
            now: 1001,
            items: claim.items,
          })
        ).duplicate,
      ).toBe(1);
      sql.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back canonical publication when same-transaction delivery registration fails", async () => {
    const sql = new LocalBranchSqlite();
    let failRegistration = true;
    const observed = observeBranchSql(sql, (event) => {
      if (
        failRegistration &&
        event.operation === "execute" &&
        event.phase === "before" &&
        event.sql?.includes("INSERT INTO branch_outbox_delivery (")
      ) {
        failRegistration = false;
        throw new Error("injected_delivery_insert_failure");
      }
    });
    try {
      const seed = contractSeed();
      const plane = await SqliteBranchCommitStatePlane.create(
        observed,
        [seed],
        { now: () => 2000 },
      );
      const query = initialQuery(seed);
      const head = await plane.readHead(query);
      const event = {
        ...makeEvent({
          eventId: "rollback-outbox",
          sourceClientId: "client",
          text: "x",
          createdAt: 2000,
          metadata: { followsSeq: -1 },
        }),
        dropId: query.target.rootDropId,
      };
      await expect(
        plane.append(referenceCommand(query, head.version, event)),
      ).rejects.toMatchObject({ code: "state_unavailable" });
      expect(
        sql.rows("SELECT COUNT(*) AS count FROM branch_outbox")[0].count,
      ).toBe(0);
      expect((await plane.readHead(query)).version.eventSeq).toBe(-1);
      expect(
        (
          await plane.claimOutbox({
            leaseId: "after-rollback",
            now: 10,
            leaseMs: 10,
            limit: 10,
          })
        ).items,
      ).toHaveLength(0);
    } finally {
      sql.close();
    }
  });

  it("resumes bounded SQLite bootstrap pages for an older backlog larger than the page limit", async () => {
    const sql = new LocalBranchSqlite();
    try {
      const seed = contractSeed();
      const plane = await SqliteBranchCommitStatePlane.create(sql, [seed], {
        now: () => 2000,
      });
      const query = initialQuery(seed);
      for (let index = 0; index < 18; index++) {
        const head = await plane.readHead(query);
        const event = {
          ...makeEvent({
            eventId: `legacy-bootstrap-${index}`,
            sourceClientId: "client",
            text: "x",
            createdAt: 2000 + index,
            metadata: { followsSeq: head.version.eventSeq },
          }),
          dropId: query.target.rootDropId,
        };
        await plane.append(referenceCommand(query, head.version, event));
      }
      // Remove only delivery bookkeeping to model canonical rows that predate this schema.
      sql.execute("DELETE FROM branch_outbox_delivery");
      const first = await plane.claimOutbox({
        leaseId: "bootstrap-1",
        now: 10,
        leaseMs: 1000,
        limit: 10,
      });
      expect(first.items).toHaveLength(10);
      const second = await plane.claimOutbox({
        leaseId: "bootstrap-2",
        now: 11,
        leaseMs: 1000,
        limit: 10,
      });
      expect(second.items).toHaveLength(8);
      expect(
        sql.rows(
          "SELECT complete FROM branch_outbox_delivery_bootstrap WHERE source='diff'",
        )[0].complete,
      ).toBe(1);
    } finally {
      sql.close();
    }
  });

  it("uses the active-due index before branch checks and fences stale backlog without starving live work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nulldown-outbox-fence-"));
    const filename = join(directory, "fenced.sqlite");
    const sql = new LocalBranchSqlite(filename);
    const candidateRows: number[] = [];
    const observed = {
      rows<T extends Record<string, unknown>>(
        query: string,
        ...bindings: (string | number | null)[]
      ) {
        const rows = sql.rows<T>(query, ...bindings);
        if (query.includes("FROM branch_outbox_delivery d"))
          candidateRows.push(rows.length);
        return rows;
      },
      execute: sql.execute.bind(sql),
      transaction: sql.transaction.bind(sql),
    };
    try {
      const staleSeeds = Array.from({ length: 6 }, (_, index) =>
        contractSeed(`a-stale-${index}`),
      );
      const leasedSeeds = Array.from({ length: 4 }, (_, index) =>
        contractSeed(`b-long-lease-${index}`),
      );
      const liveSeed = contractSeed("z-live");
      const seeds = [...staleSeeds, ...leasedSeeds, liveSeed];
      const plane = await SqliteBranchCommitStatePlane.create(observed, seeds, {
        now: () => 2000,
      });
      for (const seed of seeds) {
        const query = initialQuery(seed);
        const head = await plane.readHead(query);
        const event = {
          ...makeEvent({
            eventId: `bounded-${seed.branch.branchId}`,
            sourceClientId: "client",
            text: "x",
            createdAt: 2000,
            metadata: { followsSeq: -1 },
          }),
          dropId: query.target.rootDropId,
        };
        await plane.append(referenceCommand(query, head.version, event));
      }
      for (const seed of staleSeeds) {
        sql.execute(
          "UPDATE branch_heads SET generation=8 WHERE root_drop_id=? AND branch_id=?",
          JSON.stringify(seed.branch.rootDropId),
          JSON.stringify(seed.branch.branchId),
        );
      }
      for (let index = 0; index < leasedSeeds.length; index++) {
        const seed = leasedSeeds[index];
        const id = JSON.stringify([
          "branch.commit.v1",
          seed.branch.rootDropId,
          seed.branch.branchId,
          `bounded-${seed.branch.branchId}`,
        ]);
        sql.execute(
          "UPDATE branch_outbox_delivery SET status='claimed',attempts=1,next_attempt_at=9000000,lease_id=?,lease_token=?,lease_until=9000000 WHERE outbox_id=?",
          `lease-${index}`,
          `token-${index}`,
          id,
        );
      }
      const plan = sql.rows<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT outbox_id FROM branch_outbox_delivery INDEXED BY branch_outbox_delivery_active_due WHERE status IN ('pending','claimed') AND next_attempt_at<=? ORDER BY next_attempt_at,outbox_id LIMIT ?",
        10,
        2,
      );
      expect(
        plan.some((row) =>
          row.detail.includes("branch_outbox_delivery_active_due"),
        ),
      ).toBe(true);
      const claimed = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const page = await plane.claimOutbox({
          leaseId: `bounded-sweep-${attempt}`,
          now: 10 + attempt,
          leaseMs: 100,
          limit: 2,
        });
        claimed.push(...page.items);
      }
      expect(candidateRows).toEqual([2, 2, 2, 1]);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].target.branchId).toBe("z-live");
      expect(
        sql.rows(
          "SELECT COUNT(*) AS count FROM branch_outbox_delivery WHERE status='fenced'",
        )[0].count,
      ).toBe(6);
      expect(
        sql.rows(
          "SELECT COUNT(*) AS count FROM branch_outbox_delivery WHERE status='claimed' AND next_attempt_at=9000000",
        )[0].count,
      ).toBe(4);
      sql.close();

      const reopenedSql = new LocalBranchSqlite(filename);
      try {
        const reopened = await SqliteBranchCommitStatePlane.create(
          reopenedSql,
          [],
          { now: () => 2000 },
        );
        expect(
          (
            await reopened.claimOutbox({
              leaseId: "after-reopen",
              now: 20,
              leaseMs: 100,
              limit: 2,
            })
          ).items,
        ).toHaveLength(0);
        expect(
          reopenedSql.rows(
            "SELECT COUNT(*) AS count FROM branch_outbox_delivery WHERE status='fenced'",
          )[0].count,
        ).toBe(6);
      } finally {
        reopenedSql.close();
      }
    } finally {
      try {
        sql.close();
      } catch {
        /* already closed before reopen */
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
