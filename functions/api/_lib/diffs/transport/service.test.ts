import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../../../diff/[id]";
import { BranchMutationLockError } from "../../branches/storage/mutation-lock";
import { readSnapshot } from "../../branches/storage/repository";
import { createBranchKey } from "../../branches/storage/keys";
import { resolveBranchForActor } from "../../branches/lifecycle";
import { postDiffEvents } from "./service";
import {
  accountId,
  createGetRequest,
  createPostRequest,
  createPostRequestForBranch,
  createSeededBucket,
  makeEvent,
  rootDropId,
} from "../testing/storage-fixture";

describe("diff transport contracts", () => {
  let infoSpy: jest.SpiedFunction<typeof console.info>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let debugSpy: jest.SpiedFunction<typeof console.debug>;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("rejects unsafe append timestamps before resolving a branch", async () => {
    const bucket = createSeededBucket();
    const response = await onRequest({
      request: createPostRequest([
        makeEvent({
          eventId: "unsafe-timestamp",
          sourceClientId: "writer-a",
          text: "hello",
          createdAt: Number.MAX_SAFE_INTEGER + 1,
        }),
      ]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Invalid diff envelope.");
  });

  it("deduplicates repeat event ids across writes", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-1",
      sourceClientId: "writer-a",
      text: "hello",
      createdAt: 100,
      metadata: { followsSeq: -1 },
    });

    const first = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const firstBody = (await first.json()) as {
      accepted: number;
      deduplicated: number;
      acknowledgements: Array<{
        eventId: string;
        seq: number;
        snapshotId: number;
        status: string;
      }>;
      totalStored: number;
    };

    const second = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const secondBody = (await second.json()) as {
      accepted: number;
      deduplicated: number;
      acknowledgements: Array<{
        eventId: string;
        seq: number;
        snapshotId: number;
        status: string;
      }>;
      totalStored: number;
    };

    expect(first.status).toBe(200);
    expect(firstBody.accepted).toBe(1);
    expect(firstBody.deduplicated).toBe(0);
    expect(firstBody.acknowledgements).toEqual([
      { eventId: "evt-1", seq: 0, snapshotId: 1, status: "accepted" },
    ]);
    expect(firstBody.totalStored).toBe(1);

    expect(second.status).toBe(200);
    expect(secondBody.accepted).toBe(0);
    expect(secondBody.deduplicated).toBe(1);
    expect(secondBody.acknowledgements).toEqual([
      { eventId: "evt-1", seq: 0, snapshotId: 1, status: "duplicate" },
    ]);
    expect(secondBody.totalStored).toBe(1);

    const reused = await onRequest({
      request: createPostRequest([
        makeEvent({
          eventId: "evt-1",
          sourceClientId: "writer-a",
          text: "different payload",
          createdAt: 100,
        }),
      ]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(reused.status).toBe(409);
  });

  it("refuses an append before branch counters produce an unsafe receipt", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );
    bucket.seed(
      createBranchKey(rootDropId, branch.branchId),
      JSON.stringify({
        ...branch,
        headEventSeq: Number.MAX_SAFE_INTEGER - 1,
      }),
    );

    const response = await onRequest({
      request: createPostRequestForBranch(
        [
          makeEvent({
            eventId: "sequence-capacity",
            sourceClientId: "writer-a",
            text: "hello",
            createdAt: 100,
          }),
        ],
        branch.branchId,
        accountId,
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "diff_sequence_exhausted",
    });
  });

  it.each([
    ["branch_lock_timeout", "not_committed", 503],
    ["branch_lock_lost_before_commit", "not_committed", 409],
    ["branch_mutation_outcome_unknown", "unknown", 503],
  ] as const)(
    "maps %s lock outcomes to structured retry responses",
    async (code, outcome, status) => {
      const bucket = createSeededBucket();
      const response = await postDiffEvents(
        { R2_BUCKET: bucket as never },
        { id: rootDropId },
        createPostRequest([
          makeEvent({
            eventId: `evt-${code}`,
            sourceClientId: "writer-a",
            text: "hello",
            createdAt: 100,
          }),
        ]),
        {
          serverRuntime: {
            nulledit: {
              appendDiffEvents: async () => {
                throw new BranchMutationLockError({ code, outcome });
              },
            },
          } as never,
        },
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ code });
    },
  );

  it("accepts contiguous predecessor sequences in one batch", async () => {
    const bucket = createSeededBucket();
    const response = await onRequest({
      request: createPostRequest([
        makeEvent({
          eventId: "evt-chain-1",
          sourceClientId: "writer-chain",
          text: "first ",
          createdAt: 101,
          metadata: { followsSeq: -1 },
        }),
        makeEvent({
          eventId: "evt-chain-2",
          sourceClientId: "writer-chain",
          text: "second ",
          createdAt: 102,
          metadata: { followsSeq: 0 },
        }),
      ]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        accepted: 2,
        deduplicated: 0,
        snapshotId: 1,
        totalStored: 2,
        acknowledgements: [
          { eventId: "evt-chain-1", seq: 0, snapshotId: 1, status: "accepted" },
          { eventId: "evt-chain-2", seq: 1, snapshotId: 1, status: "accepted" },
        ],
      }),
    );
  });

  it("rejects stale predecessors before mutating branch state", async () => {
    const bucket = createSeededBucket();
    const winner = makeEvent({
      eventId: "evt-winner",
      sourceClientId: "writer-a",
      text: "winner ",
      createdAt: 101,
      metadata: { followsSeq: -1 },
    });
    const first = await onRequest({
      request: createPostRequest([winner]),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(first.status).toBe(200);

    const stale = await onRequest({
      request: createPostRequest([
        makeEvent({
          eventId: "evt-loser",
          sourceClientId: "writer-b",
          text: "loser ",
          createdAt: 102,
          metadata: { followsSeq: -1 },
        }),
      ]),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error:
        "Branch diff predecessor no longer matches the current head. Refresh and try again.",
      code: "diff_predecessor_mismatch",
    });
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );
    expect(branch).toEqual(
      expect.objectContaining({ headSnapshotId: 1, headEventSeq: 0 }),
    );
    await expect(
      readSnapshot(bucket as never, rootDropId, branch.branchId, 2),
    ).resolves.toBeNull();
  });

  it("rejects conflicting event IDs within one envelope", async () => {
    const bucket = createSeededBucket();
    const response = await onRequest({
      request: createPostRequest([
        makeEvent({
          eventId: "evt-conflict",
          sourceClientId: "writer-conflict",
          text: "first ",
          createdAt: 101,
        }),
        makeEvent({
          eventId: "evt-conflict",
          sourceClientId: "writer-conflict",
          text: "second ",
          createdAt: 101,
        }),
      ]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(409);
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );
    expect(branch).toEqual(
      expect.objectContaining({ headSnapshotId: 0, headEventSeq: -1 }),
    );
  });

  it("returns filtered diff pages with cursor", async () => {
    const bucket = createSeededBucket();
    const eventA = makeEvent({
      eventId: "evt-a",
      sourceClientId: "writer-a",
      text: "A",
      createdAt: 101,
    });
    const eventB = makeEvent({
      eventId: "evt-b",
      sourceClientId: "writer-b",
      text: "B",
      createdAt: 102,
    });

    const post = await onRequest({
      request: createPostRequest([eventA, eventB]),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(post.status).toBe(200);

    const latest = await onRequest({
      request: createGetRequest("?cursor=__latest__"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const latestBody = (await latest.json()) as {
      cursor: string | null;
      events: unknown[];
    };
    expect(latest.status).toBe(200);
    expect(latestBody.events).toHaveLength(0);
    expect(latestBody.cursor).toBe("1");

    const poll = await onRequest({
      request: createGetRequest("?cursor=-1&excludeClient=writer-a&limit=10"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const pollBody = (await poll.json()) as {
      cursor: string | null;
      events: Array<{ sourceClientId: string; eventId: string; seq: number }>;
    };

    expect(poll.status).toBe(200);
    expect(pollBody.events).toHaveLength(1);
    expect(pollBody.events[0].sourceClientId).toBe("writer-b");
    expect(pollBody.events[0].eventId).toBe("evt-b");
    expect(pollBody.cursor).toBe("1");
  });

  it("preserves event metadata through append and poll", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-metadata",
      sourceClientId: "writer-meta",
      text: "M",
      createdAt: 105,
      metadata: {
        kind: "nullplug.invoke",
        intent: "embed child plan",
        pluginId: "nd",
        args: {
          id: "child123",
          mode: "card",
        },
        labels: ["plan", "nullplug"],
        confidence: 0.9,
      },
    });

    const post = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(post.status).toBe(200);

    const poll = await onRequest({
      request: createGetRequest("?cursor=-1&limit=10"),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const pollBody = (await poll.json()) as {
      events: Array<{ metadata?: unknown }>;
    };

    expect(poll.status).toBe(200);
    expect(pollBody.events).toHaveLength(1);
    expect(pollBody.events[0].metadata).toEqual({
      kind: "nullplug.invoke",
      intent: "embed child plan",
      pluginId: "nd",
      args: {
        id: "child123",
        mode: "card",
      },
      labels: ["plan", "nullplug"],
      confidence: 0.9,
    });
  });

  it("rejects invalid diff event metadata", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-invalid-metadata",
      sourceClientId: "writer-invalid-meta",
      text: "X",
      createdAt: 106,
      metadata: {
        kind: "invalid.kind" as never,
      },
    });

    const response = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as { code?: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_failed");
  });
});
