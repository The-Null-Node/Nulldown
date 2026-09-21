import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { NullplugUiResponseFact } from "../../../../../shared/nullplug/ui";
import { hashNulldownSourceContent } from "../../../../../shared/drop/resolved/hash";
import {
  putNullplugUiResponseFact,
  listNullplugRuntimeFacts,
} from "../../nullplug/facts/repository";
import {
  readBranch,
  readSnapshot,
  writeBranch,
  writeSnapshot,
} from "./repository";
import {
  lookupBranchDiffEventIdentity,
  pollBranchDiffEventsSince,
  readBranchDiffEventBySeq,
  writeBranchDiffEvent,
} from "./diff-log";
import {
  createBranchDiffEventIdMarkerV2Key,
  createBranchDiffEventKey,
  createSnapshotKey,
} from "./keys";
import {
  MemoryD1Database,
  MemoryR2Bucket,
  createBranch,
  createEvent,
  createSnapshot,
} from "../../core/d1/testing/metadata-fixture";

describe("D1 branch metadata contracts", () => {
  it("keeps R2 snapshot authority over corrupt SQL and validates SQL-only fallback hashes", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const snapshot = createSnapshot({ snapshotId: 1, sourceContentHash: await hashNulldownSourceContent("accepted") });
    const blobs = bucket as unknown as R2Bucket;
    const sql = db as unknown as D1Database;
    await writeSnapshot(blobs, snapshot, sql);
    const read = () => readSnapshot(blobs, snapshot.rootDropId, snapshot.branchId, 1, sql);
    expect(await read()).toEqual(snapshot);
    const row = db.snapshots.get(`${snapshot.rootDropId}/${snapshot.branchId}/1`)!;
    for (const corrupt of [{ sourceContentHash: "sha256:bad" }, { sourceContentHash: null }, { textLength: "bad" }]) {
      row.record_json = JSON.stringify({ ...snapshot, ...corrupt });
      expect(await read()).toEqual(snapshot);
    }
    await bucket.delete(createSnapshotKey(snapshot.rootDropId, snapshot.branchId, 1));
    for (const corrupt of [{ sourceContentHash: "sha256:bad" }, { sourceContentHash: null }, { textLength: "bad" }]) {
      row.record_json = JSON.stringify({ ...snapshot, ...corrupt });
      await expect(read()).rejects.toThrow("snapshot_source_identity_invalid");
    }
    const legacy = { ...snapshot };
    delete legacy.sourceContentHash;
    row.record_json = JSON.stringify(legacy);
    expect(await read()).toEqual(legacy);
  });
  it("reads branch, snapshot, and event metadata from D1 without R2 records", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const branch = createBranch();
    const snapshot = createSnapshot();
    const event = createEvent();

    await writeBranch(
      bucket as unknown as R2Bucket,
      branch,
      db as unknown as D1Database,
    );
    await writeSnapshot(
      bucket as unknown as R2Bucket,
      snapshot,
      db as unknown as D1Database,
    );
    await writeBranchDiffEvent(
      bucket as unknown as R2Bucket,
      branch.rootDropId,
      branch.branchId,
      event,
      db as unknown as D1Database,
    );

    const emptyBucket = new MemoryR2Bucket();
    await expect(
      readBranch(
        emptyBucket as unknown as R2Bucket,
        branch.rootDropId,
        branch.branchId,
        db as unknown as D1Database,
      ),
    ).resolves.toEqual(branch);
    await expect(
      readSnapshot(
        emptyBucket as unknown as R2Bucket,
        snapshot.rootDropId,
        snapshot.branchId,
        snapshot.snapshotId,
        db as unknown as D1Database,
      ),
    ).resolves.toEqual(snapshot);
    await expect(
      readBranchDiffEventBySeq(
        emptyBucket as unknown as R2Bucket,
        event.dropId,
        branch.branchId,
        event.seq,
        db as unknown as D1Database,
      ),
    ).resolves.toEqual(event);

    const page = await pollBranchDiffEventsSince(
      emptyBucket as unknown as R2Bucket,
      branch.rootDropId,
      branch.branchId,
      -1,
      10,
      undefined,
      db as unknown as D1Database,
    );
    expect(page.events).toEqual([event]);
    expect(page.headSeq).toBe(0);
  });

  it("falls back to R2 when D1 skips an event before the branch head", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const branch = createBranch({ headEventSeq: 2 });
    await writeBranch(
      bucket as unknown as R2Bucket,
      branch,
      db as unknown as D1Database,
    );
    const first = createEvent();
    const second = { ...createEvent(), eventId: "evt_2", seq: 1 };
    const third = { ...createEvent(), eventId: "evt_3", seq: 2 };
    await writeBranchDiffEvent(
      bucket as unknown as R2Bucket,
      branch.rootDropId,
      branch.branchId,
      first,
      db as unknown as D1Database,
    );
    await writeBranchDiffEvent(
      bucket as unknown as R2Bucket,
      branch.rootDropId,
      branch.branchId,
      third,
      db as unknown as D1Database,
    );
    await writeBranchDiffEvent(
      bucket as unknown as R2Bucket,
      branch.rootDropId,
      branch.branchId,
      second,
    );

    await expect(
      pollBranchDiffEventsSince(
        bucket as unknown as R2Bucket,
        branch.rootDropId,
        branch.branchId,
        -1,
        10,
        undefined,
        db as unknown as D1Database,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        events: [first, second, third],
        nextCursor: 2,
      }),
    );
  });

  it("does not expose an R2 event beyond the committed branch head", async () => {
    const bucket = new MemoryR2Bucket();
    const branch = createBranch({ headEventSeq: 0 });
    await writeBranch(bucket as unknown as R2Bucket, branch);
    const committed = createEvent();
    const orphan = {
      ...createEvent(),
      eventId: "evt_orphan",
      seq: 1,
      snapshotId: 2,
    };
    await writeBranchDiffEvent(
      bucket as unknown as R2Bucket,
      branch.rootDropId,
      branch.branchId,
      committed,
    );
    await writeBranchDiffEvent(
      bucket as unknown as R2Bucket,
      branch.rootDropId,
      branch.branchId,
      orphan,
    );

    await expect(
      pollBranchDiffEventsSince(
        bucket as unknown as R2Bucket,
        branch.rootDropId,
        branch.branchId,
        -1,
        10,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        events: [committed],
        nextCursor: 0,
        headSeq: 0,
      }),
    );
  });

  it("falls back to R2 when the D1 projection is unavailable", async () => {
    const bucket = new MemoryR2Bucket();
    const branch = createBranch();
    const event = createEvent();
    await writeBranch(bucket as unknown as R2Bucket, branch);
    await writeBranchDiffEvent(
      bucket as unknown as R2Bucket,
      branch.rootDropId,
      branch.branchId,
      event,
    );
    const unavailableD1 = {
      prepare() {
        throw new Error("D1 unavailable");
      },
    };

    await expect(
      pollBranchDiffEventsSince(
        bucket as unknown as R2Bucket,
        branch.rootDropId,
        branch.branchId,
        -1,
        10,
        undefined,
        unavailableD1 as never,
      ),
    ).resolves.toEqual(
      expect.objectContaining({ events: [event], nextCursor: 0 }),
    );
  });

  it("rejects a duplicate identity when D1 and R2 event records disagree", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const event = createEvent();

    await writeBranchDiffEvent(
      bucket as unknown as R2Bucket,
      event.dropId,
      "owner",
      event,
      db as unknown as D1Database,
    );
    await bucket.put(
      createBranchDiffEventKey(event.dropId, "owner", event.seq),
      JSON.stringify({
        ...event,
        ops: [{ type: "insert", start: 0, end: 0, text: "different" }],
      }),
    );

    await expect(
      lookupBranchDiffEventIdentity(
        bucket as unknown as R2Bucket,
        event.dropId,
        "owner",
        event.eventId,
        db as unknown as D1Database,
      ),
    ).resolves.toEqual({
      status: "invalid",
      reason: "d1_r2_event_mismatch",
    });
  });

  it("rejects a v2 marker whose R2 event sequence disagrees", async () => {
    const bucket = new MemoryR2Bucket();
    const event = createEvent();

    await bucket.put(
      createBranchDiffEventKey(event.dropId, "owner", 0),
      JSON.stringify({ ...event, seq: 1 }),
    );
    await bucket.put(
      createBranchDiffEventIdMarkerV2Key(event.dropId, "owner", event.eventId),
      JSON.stringify({
        version: 2,
        rootDropId: event.dropId,
        branchId: "owner",
        eventId: event.eventId,
        seq: 0,
        snapshotId: event.snapshotId,
      }),
    );

    await expect(
      lookupBranchDiffEventIdentity(
        bucket as unknown as R2Bucket,
        event.dropId,
        "owner",
        event.eventId,
      ),
    ).resolves.toEqual({
      status: "invalid",
      reason: "v2_marker_event_mismatch",
    });
  });

  it("lists nullplug runtime facts from D1 without R2 records", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const fact: NullplugUiResponseFact = {
      version: 1,
      kind: "ui.response",
      id: "response_1",
      primitiveId: "primitive_1",
      createdAt: 1002,
      source: { rootDropId: "drop_123456789", branchId: "owner" },
      data: { accepted: true },
    };

    await putNullplugUiResponseFact(
      bucket as unknown as R2Bucket,
      fact,
      db as unknown as D1Database,
    );

    const facts = await listNullplugRuntimeFacts(
      new MemoryR2Bucket() as unknown as R2Bucket,
      "drop_123456789",
      "owner",
      db as unknown as D1Database,
    );

    expect(facts.uiResponseFacts).toEqual([fact]);
    expect(facts.uiStatePatchFacts).toEqual([]);
    expect(facts.uiStateSnapshots).toEqual([]);
  });

  it("merges nullplug runtime facts across D1 and R2", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const fromSql: NullplugUiResponseFact = {
      version: 1,
      kind: "ui.response",
      id: "response_sql",
      primitiveId: "primitive_sql",
      createdAt: 1002,
      source: { rootDropId: "drop_123456789", branchId: "owner" },
      data: { accepted: true },
    };
    const fromBlob: NullplugUiResponseFact = {
      ...fromSql,
      id: "response_blob",
      primitiveId: "primitive_blob",
      createdAt: 1001,
    };
    await putNullplugUiResponseFact(
      bucket as unknown as R2Bucket,
      fromSql,
      db as unknown as D1Database,
    );
    await putNullplugUiResponseFact(
      bucket as unknown as R2Bucket,
      fromBlob,
    );

    const facts = await listNullplugRuntimeFacts(
      bucket as unknown as R2Bucket,
      "drop_123456789",
      "owner",
      db as unknown as D1Database,
    );

    expect(facts.uiResponseFacts).toEqual([fromBlob, fromSql]);
  });

});
