import { describe, expect, it, jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { createRemoteAliasKey } from "../../drops/identity/id";
import { onRequestGet as queryResolvedRoute } from "../../../branches/[rootId]/[branchId]/resolved/query";
import { RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../../../../../shared/drop/resolved/constants";
import type {
  InstrumentedBlobStore,
  ProjectionDatabase,
} from "./testing/read-authorization-fixture";
import {
  envFor,
  forgedOwner,
  owner,
  query,
  requestFor,
  roots,
  setup,
  unrelated,
  writer,
} from "./testing/read-authorization-fixture";

const expectGenericBranchNotFound = async (
  response: Response,
): Promise<void> => {
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    error: "Branch not found.",
    code: "branch_not_found",
  });
};

const expectNoDeeperAccess = (
  bucket: InstrumentedBlobStore,
  db: ProjectionDatabase,
): void => {
  expect(bucket.reads.deeper).toBe(0);
  expect(bucket.writes).toBe(0);
  expect(db.deeperReads).toEqual({ heaps: 0, priority: 0, runtimeFacts: 0 });
};

describe("resolved heap GET authorization", () => {
  it.each([
    ["private", "RsPr01", roots.private, undefined],
    ["tombstoned", "RsDe01", roots.tombstone, owner],
    ["malformed", "RsBa01", roots.malformed, owner],
  ] as Array<[string, string, string, string | undefined]>)(
    "resolves an R2-only alias for a denied %s root without SQL writes or derived reads",
    async (_label, shortId, rootDropId, accountId) => {
      const { bucket, db } = await setup();
      await bucket.put(createRemoteAliasKey(shortId), rootDropId);
      bucket.reset();
      db.reset();

      const response = await query(bucket, db, shortId, "owner", "", accountId);

      await expectGenericBranchNotFound(response);
      expect(bucket.reads.aliases).toBe(1);
      expect(bucket.reads.branches).toBe(0);
      expect(db.runs).toBe(0);
      expectNoDeeperAccess(bucket, db);
    },
  );

  it("resolves an allowed R2-only short alias to its canonical root", async () => {
    const { bucket, db } = await setup();
    await bucket.put(createRemoteAliasKey("RsPu01"), roots.public);
    bucket.reset();
    db.reset();

    const response = await query(bucket, db, "RsPu01");
    expect(response.status).toBe(200);
  });

  it.each([
    ["private anonymous", roots.private, undefined, undefined, 0],
    ["private unrelated", roots.private, unrelated, undefined, 1],
    ["tombstoned", roots.tombstone, owner, undefined, 0],
    ["malformed projection", roots.malformed, owner, undefined, 0],
    ["invalid bearer", roots.private, owner, "invalid-token", 0],
  ] as Array<[string, string, string | undefined, string | undefined, number]>)(
    "hides a %s root before derived access",
    async (_label, rootDropId, accountId, bearer, expectedBranchReads) => {
      const { bucket, db } = await setup();
      const repair = jest.fn<() => void>();
      const dispatch = jest.fn<() => { items: unknown[] }>();
      const response = await query(
        bucket,
        db,
        rootDropId,
        "owner",
        "?snapshotterId=nulledit.unknown",
        accountId,
        bearer,
        { repairBufferedCommits: repair, querySnapshotter: dispatch },
      );

      await expectGenericBranchNotFound(response);
      expect(bucket.reads.branches).toBe(expectedBranchReads);
      expectNoDeeperAccess(bucket, db);
      expect(repair).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["sibling writer", writer, "sibling"],
    ["forged legacy owner", forgedOwner, "writer"],
  ] as Array<[string, string, string]>)(
    "hides the exact private branch from a %s before deeper reads",
    async (_label, accountId, branchId) => {
      const { bucket, db } = await setup();
      const response = await query(
        bucket,
        db,
        roots.private,
        branchId,
        "?snapshotId=0",
        accountId,
      );

      await expectGenericBranchNotFound(response);
      expect(bucket.reads.branches).toBe(1);
      expectNoDeeperAccess(bucket, db);
    },
  );

  it.each([
    ["public latest", roots.public, ""],
    ["unlisted explicit", roots.unlisted, "?snapshotId=0"],
    [
      "public canonical document snapshotter",
      roots.public,
      "?snapshotterId=nulledit.resolved-document",
    ],
    ["projection absent", roots.absent, "?snapshotId=0"],
  ] as Array<[string, string, string]>)(
    "preserves anonymous document reads for %s",
    async (_label, rootDropId, queryString) => {
      const { bucket, db } = await setup();
      const response = await query(
        bucket,
        db,
        rootDropId,
        "owner",
        queryString,
      );
      expect(response.status).toBe(200);
      expect(db.deeperReads.priority).toBe(0);
    },
  );

  it("preserves anonymous document reads when the projection database is absent", async () => {
    const { bucket } = await setup();
    const response = await query(bucket, undefined, roots.noDatabase);
    expect(response.status).toBe(200);
  });

  it.each([
    ["canonical owner", owner, "owner"],
    ["exact writer", writer, "writer"],
  ] as Array<[string, string, string]>)(
    "allows a private %s to read document snapshots",
    async (_label, accountId, branchId) => {
      const { bucket, db } = await setup();
      const response = await query(
        bucket,
        db,
        roots.private,
        branchId,
        "?snapshotId=0",
        accountId,
      );
      expect(response.status).toBe(200);
    },
  );

  it.each([
    ["runtime resolver", `?resolverId=${RESOLVED_RUNTIME_REFS_RESOLVER_ID}`],
    ["runtime snapshotter", "?snapshotterId=nulledit.resolved-runtime-refs"],
    ["unknown snapshotter", "?snapshotterId=nulledit.unknown"],
  ] as Array<[string, string]>)(
    "forbids anonymous public access to the %s before side effects",
    async (_label, queryString) => {
      const { bucket, db } = await setup();
      const repair = jest.fn<() => void>();
      const dispatch = jest.fn<() => { items: unknown[] }>();
      const response = await query(
        bucket,
        db,
        roots.public,
        "owner",
        queryString,
        undefined,
        undefined,
        { repairBufferedCommits: repair, querySnapshotter: dispatch },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Authenticated branch capability is required.",
        code: "forbidden",
      });
      expect(bucket.reads.branches).toBe(1);
      expectNoDeeperAccess(bucket, db);
      expect(repair).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("forbids an unrelated account on an unlisted sensitive resolver", async () => {
    const { bucket, db } = await setup();
    const response = await query(
      bucket,
      db,
      roots.unlisted,
      "owner",
      `?resolverId=${RESOLVED_RUNTIME_REFS_RESOLVER_ID}&snapshotId=0`,
      unrelated,
    );
    expect(response.status).toBe(403);
    expectNoDeeperAccess(bucket, db);
  });

  it.each([
    ["projected canonical owner", roots.private, "sibling", owner, true],
    ["projected exact writer", roots.private, "writer", writer, true],
    ["legacy exact writer", roots.noDatabase, "owner", owner, false],
  ] as Array<[string, string, string, string, boolean]>)(
    "dispatches an authorized %s snapshotter query",
    async (_label, rootDropId, branchId, accountId, hasDatabase) => {
      const { bucket, db } = await setup();
      const dispatch = jest.fn((_id: string, request: { query?: string }) => ({
        items: [request.query],
      }));
      const response = await query(
        bucket,
        hasDatabase ? db : undefined,
        rootDropId,
        branchId,
        "?snapshotterId=nulledit.unknown&q=next&k=2",
        accountId,
        undefined,
        { querySnapshotter: dispatch },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ items: ["next"] });
      expect(dispatch).toHaveBeenCalledWith(
        "nulledit.unknown",
        expect.objectContaining({ query: "next", top: 2 }),
      );
    },
  );

  it("allows an exact writer to query an explicit runtime snapshot", async () => {
    const { bucket, db } = await setup();
    const response = await query(
      bucket,
      db,
      roots.private,
      "writer",
      `?resolverId=${RESOLVED_RUNTIME_REFS_RESOLVER_ID}&snapshotId=0`,
      writer,
    );
    expect(response.status).toBe(200);
  });

  it("keeps the Cloudflare special snapshotter route behind root authorization", async () => {
    const { bucket, db } = await setup();
    const response = await queryResolvedRoute({
      request: requestFor(
        roots.private,
        "owner",
        "?snapshotterId=nulledit.unknown",
      ),
      env: envFor(bucket, db) as unknown as { R2_BUCKET: R2Bucket },
      params: { rootId: roots.private, branchId: "owner" },
    } as never);

    await expectGenericBranchNotFound(response);
    expect(bucket.reads.branches).toBe(0);
    expectNoDeeperAccess(bucket, db);
  });
});
