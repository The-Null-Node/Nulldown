import { jest } from "@jest/globals";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../../../diff/[id]";
import { resolveBranchForActor } from "../lifecycle";
import {
  createBranchDiffEventIdKey,
  createBranchDiffEventIdMarkerV2Key,
  createBranchDiffEventKey,
  createBranchDiffLogKey,
  createBranchKey,
  createSnapshotKey,
} from "./keys";
import {
  accountId,
  createGetRequest,
  createPostRequest,
  createSeededBucket,
  makeEvent,
  MemoryD1Database,
  rootDropId,
} from "../../diffs/testing/storage-fixture";
import type { DropDiffEvent } from "../../../../../shared/drop/diff";

describe("branch diff recovery contracts", () => {
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

  it("keeps distinct event ids isolated when legacy marker keys collide", async () => {
    const bucket = createSeededBucket();
    const firstEventId = "evt/a";
    const secondEventId = "evt?a";
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );

    expect(
      createBranchDiffEventIdKey(rootDropId, branch.branchId, firstEventId),
    ).toBe(
      createBranchDiffEventIdKey(rootDropId, branch.branchId, secondEventId),
    );
    expect(
      createBranchDiffEventIdMarkerV2Key(
        rootDropId,
        branch.branchId,
        firstEventId,
      ),
    ).not.toBe(
      createBranchDiffEventIdMarkerV2Key(
        rootDropId,
        branch.branchId,
        secondEventId,
      ),
    );

    const first = makeEvent({
      eventId: firstEventId,
      sourceClientId: "writer-a",
      text: "first",
      createdAt: 100,
    });
    const second = makeEvent({
      eventId: secondEventId,
      sourceClientId: "writer-a",
      text: "second",
      createdAt: 101,
    });
    const accepted = await onRequest({
      request: createPostRequest([first, second]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(accepted.status).toBe(200);
    await expect(
      onRequest({
        request: createPostRequest([first]),
        env: { R2_BUCKET: bucket as unknown as R2Bucket },
        params: { id: rootDropId },
      } as unknown as Parameters<typeof onRequest>[0]),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      onRequest({
        request: createPostRequest([second]),
        env: { R2_BUCKET: bucket as unknown as R2Bucket },
        params: { id: rootDropId },
      } as unknown as Parameters<typeof onRequest>[0]),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("repairs a missing v2 marker when a legacy event is durably reachable", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-repair-marker",
      sourceClientId: "writer-a",
      text: "hello",
      createdAt: 100,
    });
    const first = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(first.status).toBe(200);
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      null,
      null,
    );
    const markerKey = createBranchDiffEventIdMarkerV2Key(
      rootDropId,
      branch.branchId,
      event.eventId,
    );
    await bucket.delete(markerKey);

    const retry = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(retry.status).toBe(200);
    await expect(bucket.head(markerKey)).resolves.not.toBeNull();
  });

  it("keeps legacy polling complete when an interrupted migration leaves heap objects", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      null,
      null,
    );
    const first = makeEvent({
      eventId: "evt-legacy-first",
      sourceClientId: "writer-a",
      text: "first",
      createdAt: 100,
    });
    const second = makeEvent({
      eventId: "evt-legacy-second",
      sourceClientId: "writer-a",
      text: "second",
      createdAt: 101,
    });
    bucket.seed(
      createBranchDiffLogKey(rootDropId, branch.branchId),
      JSON.stringify([
        { ...first, seq: 0 },
        { ...second, seq: 1 },
      ]),
    );
    bucket.seed(
      createBranchDiffEventKey(rootDropId, branch.branchId, 0),
      JSON.stringify({ ...first, seq: 0, snapshotId: 1 }),
    );
    bucket.seed(
      createBranchKey(rootDropId, branch.branchId),
      JSON.stringify({
        ...branch,
        snapshotHeapVersion: undefined,
        headEventSeq: undefined,
      }),
    );

    const response = await onRequest({
      request: createGetRequest(
        `?branchId=${encodeURIComponent(branch.branchId)}&cursor=-1`,
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      events: [
        { eventId: first.eventId, seq: 0 },
        { eventId: second.eventId, seq: 1 },
      ],
    });
  });

  it("normalizes a snapshot-less legacy event before repairing its marker on repeated retries", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-legacy-snapshotless",
      sourceClientId: "writer-a",
      text: "legacy",
      createdAt: 100,
    });
    const first = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(first.status).toBe(200);

    const markerKey = createBranchDiffEventIdMarkerV2Key(
      rootDropId,
      branch.branchId,
      event.eventId,
    );
    await bucket.delete(markerKey);
    const legacyOnlyEvent = { ...event, seq: 0 };
    bucket.seed(
      createBranchDiffEventKey(rootDropId, branch.branchId, 0),
      JSON.stringify(legacyOnlyEvent),
    );
    bucket.seed(
      createBranchDiffLogKey(rootDropId, branch.branchId),
      JSON.stringify([legacyOnlyEvent]),
    );
    bucket.seed(
      createBranchKey(rootDropId, branch.branchId),
      JSON.stringify({
        ...branch,
        headSnapshotId: 1,
        snapshotHeapVersion: undefined,
        headEventSeq: undefined,
      }),
    );

    await expect(
      (await bucket.get(
        createBranchDiffEventKey(rootDropId, branch.branchId, 0),
      ))!.json(),
    ).resolves.toEqual(legacyOnlyEvent);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = await onRequest({
        request: createPostRequest([event]),
        env: { R2_BUCKET: bucket as unknown as R2Bucket },
        params: { id: rootDropId },
      } as unknown as Parameters<typeof onRequest>[0]);
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({
        acknowledgements: [
          {
            eventId: event.eventId,
            seq: 0,
            snapshotId: 1,
            status: "duplicate",
          },
        ],
      });
    }
  });

  it("repairs a snapshot-less D1 projection during repeated heap-v2 retries", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const event = makeEvent({
      eventId: "evt-legacy-d1-snapshotless",
      sourceClientId: "writer-a",
      text: "legacy D1",
      createdAt: 100,
    });
    const first = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(first.status).toBe(200);

    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      null,
      null,
    );
    const legacyEvent = { ...event, seq: 0 };
    db.seedBranchEvent(rootDropId, branch.branchId, legacyEvent);
    await bucket.delete(
      createBranchDiffEventIdMarkerV2Key(
        rootDropId,
        branch.branchId,
        event.eventId,
      ),
    );
    bucket.seed(
      createBranchDiffLogKey(rootDropId, branch.branchId),
      JSON.stringify([legacyEvent]),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = await onRequest({
        request: createPostRequest([event]),
        env: {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: db as unknown as D1Database,
        },
        params: { id: rootDropId },
      } as unknown as Parameters<typeof onRequest>[0]);

      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({
        acknowledgements: [
          {
            eventId: event.eventId,
            seq: 0,
            snapshotId: 1,
            status: "duplicate",
          },
        ],
      });
    }

    expect(db.readBranchEvent(rootDropId, branch.branchId, 0)).toEqual({
      ...legacyEvent,
      snapshotId: 1,
    });
  });

  it("uses the branch-head ancestry when normalizing legacy migration events", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-legacy-ancestor",
      sourceClientId: "writer-a",
      text: "ancestor",
      createdAt: 100,
    });
    const first = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(first.status).toBe(200);

    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      null,
      null,
    );
    const legacyEvent = { ...event, seq: 0 };
    await bucket.delete(
      createBranchDiffEventIdMarkerV2Key(
        rootDropId,
        branch.branchId,
        event.eventId,
      ),
    );
    bucket.seed(
      createBranchDiffEventKey(rootDropId, branch.branchId, 0),
      JSON.stringify(legacyEvent),
    );
    bucket.seed(
      createBranchDiffLogKey(rootDropId, branch.branchId),
      JSON.stringify([legacyEvent]),
    );
    bucket.seed(
      createSnapshotKey(rootDropId, branch.branchId, 2),
      JSON.stringify({
        version: 1,
        snapshotId: 2,
        rootDropId,
        branchId: branch.branchId,
        parentSnapshotId: 0,
        seq: 2,
        eventIds: [event.eventId],
        checkpointed: false,
        patchStartSeq: 0,
        patchEndSeq: 0,
        textLength: 0,
        createdAt: 101,
      }),
    );
    bucket.seed(
      createBranchKey(rootDropId, branch.branchId),
      JSON.stringify({
        ...branch,
        snapshotHeapVersion: undefined,
        headEventSeq: undefined,
      }),
    );

    const retry = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      acknowledgements: [
        { eventId: event.eventId, seq: 0, snapshotId: 1, status: "duplicate" },
      ],
    });
  });

  it("does not acknowledge a marker and event that have not reached the branch head", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      null,
      null,
    );
    const event = makeEvent({
      eventId: "evt-orphaned",
      sourceClientId: "writer-a",
      text: "orphan",
      createdAt: 100,
    }) as DropDiffEvent;
    const stored = { ...event, snapshotId: 1 };
    bucket.seed(
      createBranchDiffEventKey(rootDropId, branch.branchId, 0),
      JSON.stringify(stored),
    );
    bucket.seed(
      createBranchDiffEventIdMarkerV2Key(
        rootDropId,
        branch.branchId,
        event.eventId,
      ),
      JSON.stringify({
        version: 2,
        rootDropId,
        branchId: branch.branchId,
        eventId: event.eventId,
        seq: 0,
        snapshotId: 1,
      }),
    );

    const retry = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(retry.status).toBe(503);
    await expect(retry.json()).resolves.toMatchObject({
      code: "diff_event_outcome_unknown",
    });
  });

  it("resumes a markerless next-sequence event interrupted before branch-head publication", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-resume-orphan",
      sourceClientId: "writer-a",
      text: "resume",
      createdAt: 100,
    }) as DropDiffEvent;
    bucket.seed(
      createBranchDiffEventKey(rootDropId, branch.branchId, 0),
      JSON.stringify({ ...event, seq: 0, snapshotId: 1 }),
    );

    const retry = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      accepted: 1,
      acknowledgements: [
        {
          eventId: "evt-resume-orphan",
          seq: 0,
          snapshotId: 1,
          status: "accepted",
        },
      ],
    });
  });

  it("does not overwrite a markerless event with a different identity at its sequence", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );
    const orphan = makeEvent({
      eventId: "evt-orphaned-sequence",
      sourceClientId: "writer-a",
      text: "orphan",
      createdAt: 100,
    }) as DropDiffEvent;
    bucket.seed(
      createBranchDiffEventKey(rootDropId, branch.branchId, 0),
      JSON.stringify({ ...orphan, seq: 0, snapshotId: 1 }),
    );

    const response = await onRequest({
      request: createPostRequest([
        makeEvent({
          eventId: "evt-competing-sequence",
          sourceClientId: "writer-b",
          text: "different",
          createdAt: 101,
        }),
      ]),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "diff_predecessor_mismatch",
    });
    await expect(
      bucket.get(createBranchDiffEventKey(rootDropId, branch.branchId, 0)),
    ).resolves.toMatchObject({
      key: createBranchDiffEventKey(rootDropId, branch.branchId, 0),
    });
    await expect(
      (await bucket.get(
        createBranchDiffEventKey(rootDropId, branch.branchId, 0),
      ))!.json(),
    ).resolves.toEqual({ ...orphan, seq: 0, snapshotId: 1 });
  });

  it("does not acknowledge an event in a non-ancestor snapshot", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-non-ancestor",
      sourceClientId: "writer-a",
      text: "reachable only from the orphan",
      createdAt: 100,
    });
    const first = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(first.status).toBe(200);

    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      null,
      null,
    );
    bucket.seed(
      createSnapshotKey(rootDropId, branch.branchId, 2),
      JSON.stringify({
        version: 1,
        snapshotId: 2,
        rootDropId,
        branchId: branch.branchId,
        parentSnapshotId: 0,
        seq: 2,
        eventIds: [],
        checkpointed: false,
        patchStartSeq: null,
        patchEndSeq: null,
        checkpointKey: "__drop_checkpoint__/orphan.txt",
        textLength: 5,
        createdAt: 102,
      }),
    );
    bucket.seed("__drop_checkpoint__/orphan.txt", "hello", "text/plain");
    bucket.seed(
      createBranchKey(rootDropId, branch.branchId),
      JSON.stringify({ ...branch, headSnapshotId: 2, headEventSeq: 0 }),
    );

    const retry = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(retry.status).toBe(503);
    await expect(retry.json()).resolves.toMatchObject({
      code: "diff_event_outcome_unknown",
    });
  });
});
