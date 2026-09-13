import { jest } from "@jest/globals";
import { hashNulldownSourceContent } from "../../shared/drop/resolved/hash";
import {
  createCliDurabilityHarness,
  type CliDurabilityHarness,
  type CliProcessResult,
} from "./testHarness";

jest.setTimeout(120_000);

const jsonResult = <T>(result: CliProcessResult): T => {
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(`CLI failed: ${JSON.stringify(result)}`);
  }
  return JSON.parse(result.stdout) as T;
};

const textResult = (result: CliProcessResult): string => {
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(`CLI failed: ${JSON.stringify(result)}`);
  }
  return result.stdout;
};

const describeDurability = process.platform === "win32" ? describe.skip : describe;

const count = (value: string, needle: string): number =>
  value.split(needle).length - 1;

describeDurability("CLI restart durability", () => {
  let harness: CliDurabilityHarness;

  beforeEach(async () => {
    harness = await createCliDurabilityHarness();
    await harness.start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("persists root, branch, snapshots, explicit memory, priority, and resolved query after restart", async () => {
    const rootV1 = "# Durable Root\n\nInitial content.\n";
    const rootV2 = "# Durable Root\n\nUpdated root content.\n";
    const created = jsonResult<{ id: string }>(
      await harness.nd(["create", "-"], rootV1),
    );
    jsonResult(await harness.nd(["update", created.id, "-"], rootV2));
    const branch = jsonResult<{ branchId: string }>(
      await harness.nd(["branch", "resolve", created.id]),
    );

    const appliedText = "\nApplied before restart.";
    jsonResult(
      await harness.nd([
        "diff",
        "apply",
        created.id,
        `--branch=${branch.branchId}`,
        `--insert=${rootV2.length}:${appliedText}`,
        `--metadata=${JSON.stringify({
          kind: "agent.edit",
          intent: "Exercise restart durability.",
        })}`,
      ]),
    );
    const finalBranch = `${rootV2}${appliedText}\n\n## Restart Query Token\n\nDurable branch content.`;
    const replaced = jsonResult<{ verified: boolean }>(
      await harness.nd(
        [
          "diff",
          "replace",
          created.id,
          `--branch=${branch.branchId}`,
          "--to-file=-",
        ],
        finalBranch,
      ),
    );
    expect(replaced.verified).toBe(true);

    const snapshotsBefore = jsonResult<{ snapshots: Array<{ snapshotId: number; sourceContentHash?: string }> }>(
      await harness.nd([
        "branch",
        "snapshots",
        created.id,
        branch.branchId,
      ]),
    );
    expect(snapshotsBefore.snapshots.map((snapshot) => snapshot.snapshotId)).toEqual([
      0, 1, 2,
    ]);
    expect(snapshotsBefore.snapshots[0].sourceContentHash).toBeUndefined();
    expect(snapshotsBefore.snapshots[2].sourceContentHash).toBe(await hashNulldownSourceContent(finalBranch));
    const queryBefore = jsonResult<{ heapGenerated: boolean; nodes: Array<{ node: { text: string } }> }>(
      await harness.nd([
        "branch",
        "query",
        created.id,
        branch.branchId,
        "--query=Restart Query Token",
        "--top=3",
      ]),
    );
    expect(queryBefore.nodes.some(({ node }) => node.text.includes("Restart Query Token"))).toBe(
      true,
    );
    expect(queryBefore.heapGenerated).toBe(false);
    const repeatedQuery = jsonResult<{ heapGenerated: boolean }>(
      await harness.nd(["branch", "query", created.id, branch.branchId, "--query=Restart Query Token"]),
    );
    expect(repeatedQuery.heapGenerated).toBe(false);

    const fact = jsonResult<{ record: { recordId: string } }>(
      await harness.nd([
        "branch",
        "memory",
        "fact",
        created.id,
        branch.branchId,
        "--title=Restart fact",
        "--text=Explicit memory survives restart.",
        "--labels=cli-durability,restart",
      ]),
    );
    const procedure = jsonResult<{ record: { recordId: string } }>(
      await harness.nd([
        "branch",
        "memory",
        "procedure",
        created.id,
        branch.branchId,
        "--goal=Verify restart",
        "--summary=Stop, restart, and query durable state.",
        "--steps=[]",
        "--labels=cli-durability,restart,procedure-memory",
      ]),
    );
    const priority = jsonResult<{ fact: { factId: string } }>(
      await harness.nd([
        "branch",
        "priority",
        created.id,
        branch.branchId,
        "--heap",
        "--priority=3",
        "--reason=Restart durability",
        "--labels=cli-durability,restart",
      ]),
    );

    await harness.stop();
    await harness.start();

    expect(textResult(await harness.nd(["get", created.id, "--raw"], "", "b"))).toBe(
      `${rootV2}\n`,
    );
    const branchAfter = jsonResult<{ content: string; snapshotId: number }>(
      await harness.nd(
        ["branch", "content", created.id, branch.branchId],
        "",
        "b",
      ),
    );
    expect(branchAfter).toEqual(
      expect.objectContaining({ content: finalBranch, snapshotId: 2 }),
    );
    const snapshotsAfter = jsonResult<{ snapshots: Array<{ snapshotId: number }> }>(
      await harness.nd(
        ["branch", "snapshots", created.id, branch.branchId],
        "",
        "b",
      ),
    );
    expect(snapshotsAfter.snapshots.map((snapshot) => snapshot.snapshotId)).toEqual([
      0, 1, 2,
    ]);
    const queryAfter = jsonResult<{ heapGenerated: boolean; nodes: Array<{ node: { text: string } }> }>(
      await harness.nd(
        [
          "branch",
          "query",
          created.id,
          branch.branchId,
          "--query=Restart Query Token",
          "--top=3",
        ],
        "",
        "b",
      ),
    );
    expect(queryAfter.nodes.some(({ node }) => node.text.includes("Restart Query Token"))).toBe(
      true,
    );
    // The local adapter's portable store is in memory; restart repairs its missing heap.
    expect(queryAfter.heapGenerated).toBe(true);
    expect(jsonResult<{ heapGenerated: boolean }>(await harness.nd([
      "branch", "query", created.id, branch.branchId, "--query=Restart Query Token",
    ])).heapGenerated).toBe(false);
    expect(snapshotsAfter).toEqual(snapshotsBefore);
    const memoryAfter = jsonResult<{
      records: Array<{ recordId: string }>;
    }>(
      await harness.nd(
        [
          "branch",
          "memory",
          "query",
          created.id,
          branch.branchId,
          "--labels=restart",
        ],
        "",
        "b",
      ),
    );
    expect(memoryAfter.records.map((record) => record.recordId)).toEqual(
      expect.arrayContaining([fact.record.recordId, procedure.record.recordId]),
    );
    expect(memoryAfter.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: fact.record.recordId,
          title: "Restart fact",
          text: "Explicit memory survives restart.",
        }),
        expect.objectContaining({
          recordId: procedure.record.recordId,
          goal: "Verify restart",
          summary: "Stop, restart, and query durable state.",
        }),
      ]),
    );
    const priorityAfter = jsonResult<{ facts: Array<{ factId: string }> }>(
      await harness.nd(
        [
          "branch",
          "priority",
          "list",
          created.id,
          branch.branchId,
          "--target-kind=heap",
        ],
        "",
        "b",
      ),
    );
    expect(priorityAfter.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factId: priority.fact.factId,
          priority: 3,
          reason: "Restart durability",
        }),
      ]),
    );

    jsonResult(
      await harness.nd(
        [
          "branch",
          "memory",
          "delete",
          created.id,
          branch.branchId,
          fact.record.recordId,
        ],
        "",
        "b",
      ),
    );
    jsonResult(
      await harness.nd(
        [
          "branch",
          "memory",
          "delete",
          created.id,
          branch.branchId,
          procedure.record.recordId,
        ],
        "",
        "b",
      ),
    );
    jsonResult(
      await harness.nd(
        [
          "branch",
          "priority",
          "delete",
          created.id,
          branch.branchId,
          priority.fact.factId,
        ],
        "",
        "b",
      ),
    );
    const memoryAfterDelete = jsonResult<{
      records: Array<{ recordId: string }>;
    }>(
      await harness.nd(
        [
          "branch",
          "memory",
          "query",
          created.id,
          branch.branchId,
          "--labels=restart",
        ],
        "",
        "b",
      ),
    );
    expect(memoryAfterDelete.records).toEqual([]);
    const priorityAfterDelete = jsonResult<{ facts: unknown[] }>(
      await harness.nd(
        [
          "branch",
          "priority",
          "list",
          created.id,
          branch.branchId,
          "--target-kind=heap",
        ],
        "",
        "b",
      ),
    );
    expect(priorityAfterDelete.facts).toEqual([]);
    await harness.stop();
    await harness.start();
    const memoryAfterDeleteRestart = jsonResult<{ records: unknown[] }>(
      await harness.nd(
        [
          "branch",
          "memory",
          "query",
          created.id,
          branch.branchId,
          "--labels=restart",
        ],
        "",
        "b",
      ),
    );
    expect(memoryAfterDeleteRestart.records).toEqual([]);
    const priorityAfterDeleteRestart = jsonResult<{ facts: unknown[] }>(
      await harness.nd(
        [
          "branch",
          "priority",
          "list",
          created.id,
          branch.branchId,
          "--target-kind=heap",
        ],
        "",
        "b",
      ),
    );
    expect(priorityAfterDeleteRestart.facts).toEqual([]);
  });

  it("deduplicates a fixed event ID before and after restart", async () => {
    const created = jsonResult<{ id: string }>(
      await harness.nd(["create", "-"], "# Dedupe Root\n"),
    );
    const branch = jsonResult<{ branchId: string }>(
      await harness.nd(["branch", "resolve", created.id]),
    );
    const eventId = "evt-cli-restart-dedupe-1";
    const envelope = JSON.stringify({
      version: 1,
      events: [
        {
          eventId,
          seq: 0,
          dropId: created.id,
          sourceClientId: "cli-durability-a",
          createdAt: 1_700_000_000_000,
          ops: [{ type: "insert", start: 0, end: 0, text: "ONCE_TOKEN " }],
          metadata: { kind: "agent.edit" },
        },
      ],
    });
    interface PostResult {
      accepted: number;
      deduplicated: number;
      snapshotId: number;
      totalStored: number;
      acknowledgements: Array<{
        eventId: string;
        seq: number;
        snapshotId: number;
        status: "accepted" | "duplicate";
      }>;
    }
    const post = async (client: "a" | "b" = "a") =>
      jsonResult<PostResult>(
        await harness.nd(
          [
            "diff",
            "batch",
            created.id,
            `--branch=${branch.branchId}`,
            "--body-file=-",
          ],
          envelope,
          client,
        ),
      );

    const concurrent = await Promise.all([post("a"), post("b")]);
    expect(concurrent.map((result) => result.accepted).sort()).toEqual([0, 1]);
    expect(concurrent.map((result) => result.deduplicated).sort()).toEqual([0, 1]);
    expect(concurrent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accepted: 1,
          deduplicated: 0,
          snapshotId: 1,
          totalStored: 1,
          acknowledgements: [
            { eventId, seq: 0, snapshotId: 1, status: "accepted" },
          ],
        }),
        expect.objectContaining({
          accepted: 0,
          deduplicated: 1,
          snapshotId: 1,
          totalStored: 1,
          acknowledgements: [
            { eventId, seq: 0, snapshotId: 1, status: "duplicate" },
          ],
        }),
      ]),
    );
    await harness.stop();
    await harness.start();
    expect(await post("b")).toEqual(
      expect.objectContaining({
        accepted: 0,
        deduplicated: 1,
        snapshotId: 1,
        totalStored: 1,
        acknowledgements: [
          { eventId, seq: 0, snapshotId: 1, status: "duplicate" },
        ],
      }),
    );
    const content = jsonResult<{ content: string }>(
      await harness.nd(
        ["branch", "content", created.id, branch.branchId],
        "",
        "b",
      ),
    );
    expect(count(content.content, "ONCE_TOKEN")).toBe(1);
  });

  it("replays a fixed diff apply identity after restart", async () => {
    const created = jsonResult<{ id: string }>(
      await harness.nd(["create", "-"], "# Apply Retry Root\n"),
    );
    const branch = jsonResult<{ branchId: string }>(
      await harness.nd(["branch", "resolve", created.id]),
    );
    const args = [
      "diff",
      "apply",
      created.id,
      `--branch=${branch.branchId}`,
      "--event-id=evt-cli-apply-retry-1",
      "--created-at=1700000000000",
      "--insert=0:ONCE_APPLY_TOKEN ",
    ];

    expect(jsonResult<{ accepted: number; deduplicated: number }>(await harness.nd(args))).toMatchObject({
      accepted: 1,
      deduplicated: 0,
    });
    await harness.stop();
    await harness.start();
    expect(jsonResult<{ accepted: number; deduplicated: number }>(await harness.nd(args))).toMatchObject({
      accepted: 0,
      deduplicated: 1,
    });
    const content = jsonResult<{ content: string }>(
      await harness.nd(["branch", "content", created.id, branch.branchId]),
    );
    expect(count(content.content, "ONCE_APPLY_TOKEN")).toBe(1);
  });

  it("rejects one of two concurrent branch replacements before it persists", async () => {
    const initial = "# Branch Replace Race\n";
    const winnerA = "# Branch Replace Race\n\nWinner A\n";
    const winnerB = "# Branch Replace Race\n\nWinner B\n";
    const created = jsonResult<{ id: string }>(
      await harness.nd(["create", "-"], initial),
    );
    const branch = jsonResult<{ branchId: string }>(
      await harness.nd(["branch", "resolve", created.id]),
    );
    const first = harness.spawnNd(
      [
        "diff",
        "replace",
        created.id,
        `--branch=${branch.branchId}`,
        "--to-file=-",
        "--verbose",
      ],
      "a",
    );
    const second = harness.spawnNd(
      [
        "diff",
        "replace",
        created.id,
        `--branch=${branch.branchId}`,
        "--to-file=-",
        "--verbose",
      ],
      "b",
    );

    await Promise.all([
      first.waitForStderr('"event":"http.end"'),
      second.waitForStderr('"event":"http.end"'),
    ]);
    first.endStdin(winnerA);
    second.endStdin(winnerB);
    const results = await Promise.all([first.result(), second.result()]);

    expect(results.map((result) => result.status).sort()).toEqual([0, 1]);
    const winner = results.find((result) => result.status === 0)!;
    const failure = results.find((result) => result.status === 1)!;
    expect(JSON.parse(winner.stdout)).toEqual(expect.objectContaining({ verified: true }));
    expect(JSON.parse(failure.stderr.trim().split("\n").at(-1)!)).toEqual({
      error:
        "Branch diff predecessor no longer matches the current head. Refresh and try again.",
      code: "diff_predecessor_mismatch",
      status: 409,
    });
    expect(count(failure.stderr, '"event":"http.end"')).toBe(1);

    const beforeRestart = jsonResult<{
      content: string;
      headEventSeq: number;
      snapshotId: number;
    }>(
      await harness.nd(["branch", "content", created.id, branch.branchId]),
    );
    expect(beforeRestart).toEqual(
      expect.objectContaining({
        content: expect.stringMatching(/^# Branch Replace Race\n\nWinner [AB]\n$/),
        headEventSeq: 0,
        snapshotId: 1,
      }),
    );
    const snapshots = jsonResult<{ snapshots: Array<{ snapshotId: number }> }>(
      await harness.nd(["branch", "snapshots", created.id, branch.branchId]),
    );
    expect(snapshots.snapshots.map((snapshot) => snapshot.snapshotId)).toEqual([0, 1]);

    await harness.stop();
    await harness.start();
    const afterRestart = jsonResult<{ content: string; headEventSeq: number }>(
      await harness.nd(
        ["branch", "content", created.id, branch.branchId],
        "",
        "b",
      ),
    );
    expect(afterRestart).toEqual(
      expect.objectContaining({
        content: beforeRestart.content,
        headEventSeq: 0,
      }),
    );
  });

  it("keeps primary content replayable when a derived projection fails", async () => {
    await harness.stop();
    await harness.start("resolved-document-put-many-fails-once");
    const created = jsonResult<{ id: string }>(
      await harness.nd(["create", "-"], "# Derived Failure\n"),
    );
    const branch = jsonResult<{ branchId: string }>(
      await harness.nd(["branch", "resolve", created.id]),
    );
    const applied = jsonResult<{
      accepted: number;
      acknowledgements: Array<{ eventId: string; seq: number; status: string }>;
      snapshotId: number;
    }>(
      await harness.nd([
        "diff",
        "apply",
        created.id,
        `--branch=${branch.branchId}`,
        "--insert=0:DERIVED_FAILURE_TOKEN ",
      ]),
    );
    expect(applied).toEqual(
      expect.objectContaining({
        accepted: 1,
        snapshotId: 1,
        acknowledgements: [
          expect.objectContaining({ seq: 0, snapshotId: 1, status: "accepted" }),
        ],
      }),
    );
    await harness.waitForServerStderr("diff.nulledit_snapshotter_failed");
    const contentBeforeRestart = jsonResult<{ content: string; snapshotId: number }>(
      await harness.nd(["branch", "content", created.id, branch.branchId]),
    );
    expect(contentBeforeRestart).toEqual(
      expect.objectContaining({
        content: "DERIVED_FAILURE_TOKEN # Derived Failure\n",
        snapshotId: 1,
      }),
    );
    const snapshotsBeforeRestart = jsonResult<{
      snapshots: Array<{ checkpointed: boolean; snapshotId: number }>;
    }>(await harness.nd(["branch", "snapshots", created.id, branch.branchId]));
    expect(snapshotsBeforeRestart.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ snapshotId: 1, checkpointed: false }),
      ]),
    );

    const faultedServer = await harness.stop();
    const snapshotterFailures = faultedServer!.stderr
      .trim()
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter((entry) => entry.event === "diff.nulledit_snapshotter_failed");
    expect(snapshotterFailures).toEqual([
      expect.objectContaining({
        snapshotterId: "nulledit.resolved-document",
        error: expect.objectContaining({
          message: "test_fault:resolved_document_put_many_once",
        }),
      }),
    ]);

    await harness.start();
    const durableContent = jsonResult<{ content: string; snapshotId: number }>(
      await harness.nd(
        ["branch", "content", created.id, branch.branchId],
        "",
        "b",
      ),
    );
    expect(durableContent).toEqual(contentBeforeRestart);
    const generated = jsonResult<{
      heapGenerated: boolean;
      nodes: Array<{ node: { text: string } }>;
      snapshotId: number;
      stale: boolean;
    }>(
      await harness.nd(
        [
          "branch",
          "query",
          created.id,
          branch.branchId,
          "--query=DERIVED_FAILURE_TOKEN",
          "--top=3",
        ],
        "",
        "b",
      ),
    );
    expect(generated).toEqual(
      expect.objectContaining({ heapGenerated: true, snapshotId: 1, stale: false }),
    );
    expect(
      generated.nodes.some(({ node }) => node.text.includes("DERIVED_FAILURE_TOKEN")),
    ).toBe(true);

    await harness.stop();
    await harness.start();
    const repaired = jsonResult<{ heapGenerated: boolean; snapshotId: number }>(
      await harness.nd(
        [
          "branch",
          "query",
          created.id,
          branch.branchId,
          "--query=DERIVED_FAILURE_TOKEN",
          "--top=3",
        ],
        "",
        "b",
      ),
    );
    expect(repaired).toEqual(
      expect.objectContaining({ heapGenerated: false, snapshotId: 1 }),
    );
  });

  it("rejects one of two stale root updates from fresh CLI processes", async () => {
    const created = jsonResult<{ id: string }>(
      await harness.nd(["create", "-"], "# Stale Root\n"),
    );
    const first = harness.spawnNd(["update", created.id, "-", "--verbose"], "a");
    const second = harness.spawnNd(["update", created.id, "-", "--verbose"], "b");
    await Promise.all([
      first.waitForStderr('"event":"http.end"'),
      second.waitForStderr('"event":"http.end"'),
    ]);
    first.endStdin("# Winner A\n");
    second.endStdin("# Winner B\n");
    const results = await Promise.all([first.result(), second.result()]);
    expect(results.map((result) => result.status).sort()).toEqual([0, 1]);
    const failure = results.find((result) => result.status === 1)!;
    const error = JSON.parse(failure.stderr.trim().split("\n").at(-1)!);
    expect(error).toEqual({
      error: "Drop revision precondition failed. Refresh and try again.",
      code: "revision_precondition_failed",
      status: 412,
    });
    const diagnostics = failure.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(diagnostics.slice(0, -1).every((entry) => entry.type === "diagnostic")).toBe(
      true,
    );
    expect(["# Winner A\n\n", "# Winner B\n\n"]).toContain(
      textResult(await harness.nd(["get", created.id, "--raw"])),
    );
  });
});
