import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { hashNulldownSourceContent } from "../../../../../shared/drop/resolved/hash";
import {
  writeBranch,
  writeSnapshot,
  writeSnapshotCheckpoint,
} from "../../branches/storage/repository";
import {
  MemoryD1Database,
  MemoryR2Bucket,
  createBranch,
  createSnapshot,
} from "../../core/d1/testing/metadata-fixture";
import { queryResolvedHeap } from "./query-service";
import type {
  ResolvedHeapTimingEvent,
  ResolvedHeapTimingObserver,
} from "./timing";

const fixture = async () => {
  const bucket = new MemoryR2Bucket();
  await bucket.put(
    "drop_123456789",
    JSON.stringify({ content: "Public root" }),
  );
  const db = new MemoryD1Database();
  const blobs = bucket as unknown as R2Bucket;
  const sql = db as unknown as D1Database;
  const content = "# Private fixture text\n\nA searchable paragraph.";
  const branch = createBranch({ headSnapshotId: 1 });
  const snapshot = createSnapshot({
    snapshotId: 1,
    sourceContentHash: await hashNulldownSourceContent(content),
  });
  await writeBranch(blobs, branch, sql);
  await writeSnapshot(blobs, snapshot, sql);
  await writeSnapshotCheckpoint(
    blobs,
    snapshot.rootDropId,
    snapshot.branchId,
    snapshot.snapshotId,
    content,
    snapshot.checkpointKey,
  );
  const env = { R2_BUCKET: blobs, DB: sql };
  const query = (
    onTiming: ResolvedHeapTimingObserver,
    repairBufferedCommits?: () => Promise<void>,
  ) =>
    queryResolvedHeap(
      env,
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/query?q=private-query", {
        headers: { "x-request-id": "query-timing" },
      }),
      { onTiming, repairBufferedCommits },
    );
  return { query, env, db, bucket };
};

describe("resolved query phase attribution", () => {
  it("distinguishes cold generation from warm SQL reuse with exact write counts", async () => {
    const { query, env, db } = await fixture();
    const cold: ResolvedHeapTimingEvent[] = [];
    const response = await query((event) => {
      cold.push(event);
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      heapGenerated: boolean;
      nodeCount: number;
    };
    expect(body.heapGenerated).toBe(true);
    const completed = cold.filter((event) => event.outcome === "complete");
    expect(completed.map((event) => event.phase)).toEqual(
      expect.arrayContaining([
        "query",
        "query.replay",
        "query.source-hash",
        "projection.heapify-document",
        "projection.r2-write",
        "projection.sql-sync",
        "projection.generate",
      ]),
    );
    for (const [phase, count] of [
      ["projection.node-writes", body.nodeCount + 1],
      ["projection.payload-writes", body.nodeCount],
      ["projection.delta-write", 1],
      ["projection.ref-writes", body.nodeCount + 1],
    ] as const) {
      expect(completed.find((event) => event.phase === phase)).toMatchObject({
        writesAttempted: count,
        writesCompleted: count,
      });
    }
    expect(
      completed.reduce((sum, event) => sum + event.writesCompleted, 0),
    ).toBe(3 * body.nodeCount + 3);
    expect(db.nodes.size).toBe(body.nodeCount);
    expect(env).not.toHaveProperty("heapTiming");
    const warm: ResolvedHeapTimingEvent[] = [];
    const warmResponse = await query((event) => {
      warm.push(event);
    });
    expect(warmResponse.status).toBe(200);
    expect(await warmResponse.json()).toMatchObject({ heapGenerated: false });
    expect(
      warm.some(
        (event) =>
          event.phase === "read.sql-projection" && event.outcome === "complete",
      ),
    ).toBe(true);
    expect(
      warm.some(
        (event) =>
          event.phase === "query.replay" ||
          event.phase.startsWith("projection."),
      ),
    ).toBe(false);
    expect(warm.every((event) => event.writesAttempted === 0)).toBe(true);
    expect(warm[0].phaseId).toBe(1);
    expect(JSON.stringify([...cold, ...warm])).not.toMatch(
      /Private fixture|private-query|searchable|INSERT|SELECT/,
    );
    for (const event of completed) {
      expect(
        cold.find(
          (entry) =>
            entry.phaseId === event.phaseId && entry.outcome === "entry",
        ),
      ).toBeDefined();
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(["throw", "reject"])(
    "completes cold persistence when the observer %ss",
    async (failure) => {
      const { query, db } = await fixture();
      const response = await query(() => {
        if (failure === "throw") throw new Error("observer failure");
        return Promise.reject(new Error("observer failure"));
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ heapGenerated: true });
      expect(db.nodeRefs.size).toBe(db.nodes.size);
      expect(db.nodes.size).toBeGreaterThan(0);
    },
  );

  it("attributes best-effort repair errors while completing the query", async () => {
    const { query } = await fixture();
    const events: ResolvedHeapTimingEvent[] = [];
    const response = await query(
      (event) => {
        events.push(event);
      },
      async () => {
        throw new Error("private repair detail");
      },
    );
    expect(response.status).toBe(200);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "query.repair", outcome: "error" }),
        expect.objectContaining({ phase: "query", outcome: "complete" }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("private repair detail");
  });

  it("attributes a failed R2 projection write and preserves the error response", async () => {
    const { query, bucket } = await fixture();
    bucket.put = async () => {
      throw new Error("projection unavailable");
    };
    const events: ResolvedHeapTimingEvent[] = [];
    const response = await query((event) => {
      events.push(event);
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "resolved_query_failed",
      error: "Failed to query resolved heap: projection unavailable",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "projection.r2-write",
          outcome: "error",
        }),
        expect.objectContaining({ phase: "query", outcome: "error" }),
      ]),
    );
    expect(events.some((event) => event.phase === "projection.sql-sync")).toBe(
      false,
    );
  });
});
