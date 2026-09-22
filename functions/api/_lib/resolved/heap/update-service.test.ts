import { describe, expect, it } from "@jest/globals";
import { createRemoteAliasKey } from "../../drops/identity/id";
import type {
  InstrumentedBlobStore,
  ProjectionDatabase,
} from "./testing/read-authorization-fixture";
import {
  owner,
  roots,
  setup,
  unrelated,
  update,
  writer,
} from "./testing/read-authorization-fixture";

const expectNoDeeperAccess = (
  bucket: InstrumentedBlobStore,
  db: ProjectionDatabase,
): void => {
  expect(bucket.reads.deeper).toBe(0);
  expect(bucket.writes).toBe(0);
  expect(db.deeperReads).toEqual({ heaps: 0, priority: 0, runtimeFacts: 0 });
};

describe("resolved heap update authorization", () => {
  it("requires authentication before resolving an update alias", async () => {
    const { bucket, db } = await setup();
    await bucket.put(createRemoteAliasKey("RuAu01"), roots.public);
    bucket.reset();
    db.reset();
    const response = await update(bucket, db, "RuAu01");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authenticated account session is required.",
      code: "account_required",
    });
    expect(bucket.reads).toEqual({ aliases: 0, branches: 0, deeper: 0 });
    expectNoDeeperAccess(bucket, db);
  });

  it.each([
    ["private unrelated", roots.private, "owner", unrelated, 404],
    ["tombstoned", roots.tombstone, "owner", owner, 404],
    ["malformed", roots.malformed, "owner", owner, 404],
    ["public unrelated", roots.public, "owner", unrelated, 403],
    ["unlisted unrelated", roots.unlisted, "owner", unrelated, 403],
  ] as Array<[string, string, string, string, number]>)(
    "rejects a %s update before projection writes",
    async (_label, rootDropId, branchId, accountId, expectedStatus) => {
      const { bucket, db } = await setup();
      const response = await update(
        bucket,
        db,
        rootDropId,
        branchId,
        accountId,
      );

      expect(response.status).toBe(expectedStatus);
      expectNoDeeperAccess(bucket, db);
    },
  );

  it.each([
    ["canonical owner", roots.private, "owner", owner],
    ["exact writer", roots.private, "writer", writer],
  ] as Array<[string, string, string, string]>)(
    "allows a private %s to rebuild its branch heap",
    async (_label, rootDropId, branchId, accountId) => {
      const { bucket, db } = await setup();
      const response = await update(
        bucket,
        db,
        rootDropId,
        branchId,
        accountId,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ rootDropId, branchId }),
      );
      expect(bucket.writes).toBeGreaterThan(0);
    },
  );
});
