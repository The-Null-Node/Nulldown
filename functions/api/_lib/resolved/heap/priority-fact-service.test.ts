import { describe, expect, it } from "@jest/globals";
import { createRemoteAliasKey } from "../../drops/identity/id";
import {
  canonicalOwner,
  create,
  deleteFact,
  forgedOwner,
  list,
  priorityFact,
  priorityFactForId,
  priorityPayload,
  roots,
  setup,
  siblingWriter,
  unrelated,
  writer,
} from "./testing/authorization-fixture";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../../../../shared/drop/resolved/constants";

const expectBranchNotFound = async (response: Response): Promise<void> => {
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    error: "Branch not found.",
    code: "branch_not_found",
  });
};

const expectSensitiveForbidden = async (response: Response): Promise<void> => {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    error: "Authenticated branch capability is required.",
    code: "forbidden",
  });
};

const expectMutationForbidden = async (
  response: Response,
  action: "create" | "delete",
): Promise<void> => {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    error: `You are not allowed to ${action} priority facts for this branch.`,
    code: "forbidden",
  });
};

const expectAccountRequired = async (response: Response): Promise<void> => {
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({
    error: "Authenticated account session is required.",
    code: "account_required",
  });
};

describe("resolved priority fact authorization", () => {
  it("authorizes priority fact creation only for trusted root authority or the exact writer", async () => {
    const { bucket, db } = await setup();

    for (const [rootDropId, accountId] of [
      [roots.public, canonicalOwner],
      [roots.public, writer],
      [roots.unlisted, canonicalOwner],
      [roots.unlisted, writer],
      [roots.private, canonicalOwner],
      [roots.private, writer],
    ] as const) {
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      const response = await create(bucket, db, rootDropId, {
        accountId,
        body: priorityPayload,
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ rootDropId, branchId: "writer" }),
      );
      expect(db.writes.priority).toBe(1);
    }

    for (const accountId of [forgedOwner, siblingWriter, unrelated]) {
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectMutationForbidden(
        await create(bucket, db, roots.public, {
          accountId,
          body: "{}",
        }),
        "create",
      );
      expect(db.reads.priority).toBe(0);
      expect(db.writes.priority).toBe(0);
    }

    await expectAccountRequired(
      await create(bucket, db, roots.public, { body: "{}" }),
    );

    for (const accountId of [undefined, unrelated, siblingWriter]) {
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectBranchNotFound(
        await create(bucket, db, roots.private, {
          accountId,
          body: "{}",
        }),
      );
      expect(db.reads.priority).toBe(0);
      expect(db.writes.priority).toBe(0);
    }

    for (const [rootDropId, alias] of [
      [roots.tombstone, "PrCrt1"],
      [roots.malformed, "PrCrt2"],
    ] as const) {
      await bucket.put(createRemoteAliasKey(alias), rootDropId);
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectBranchNotFound(
        await create(bucket, db, alias, {
          accountId: canonicalOwner,
          body: "{}",
        }),
      );
      expect(bucket.reads).toEqual({ aliases: 1, branches: 0, deeper: 0 });
      expect(bucket.writes).toBe(0);
      expect(db.runs).toBe(0);
      expect(db.writes).toEqual({ aliases: 0, priority: 0 });
      expect(db.reads.priority).toBe(0);
    }

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const legacyWriter = await create(bucket, db, roots.legacy, {
      accountId: writer,
      body: priorityPayload,
    });
    expect(legacyWriter.status).toBe(201);
    expect(db.writes.priority).toBe(1);
    await expectMutationForbidden(
      await create(bucket, db, roots.legacy, {
        accountId: unrelated,
        body: "{}",
      }),
      "create",
    );

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const invalidBody = await create(bucket, db, roots.public, {
      accountId: canonicalOwner,
      body: "{}",
    });
    expect(invalidBody.status).toBe(400);
    await expect(invalidBody.json()).resolves.toEqual({
      error: "Priority fact payload must include targetKind and priority.",
      code: "validation_failed",
    });
    expect(db.writes.priority).toBe(0);

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    await expectAccountRequired(
      await create(bucket, db, roots.public, {
        accountId: writer,
        authorization: "Bearer invalid",
        body: priorityPayload,
      }),
    );
    expect(db.writes.priority).toBe(0);
  });

  it("authorizes priority fact deletion only for trusted root authority or the exact writer", async () => {
    const { bucket, db } = await setup();

    for (const [rootDropId, accountId] of [
      [roots.public, canonicalOwner],
      [roots.public, writer],
      [roots.unlisted, canonicalOwner],
      [roots.unlisted, writer],
      [roots.private, canonicalOwner],
      [roots.private, writer],
    ] as const) {
      const factId = `priority:delete:${rootDropId}:${accountId}`;
      db.priorityFacts.push(priorityFactForId(rootDropId, factId));
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      const response = await deleteFact(bucket, db, rootDropId, factId, {
        accountId,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        rootDropId,
        branchId: "writer",
        factId,
        deleted: true,
      });
      expect(db.reads.priority).toBe(1);
      expect(db.writes.priority).toBe(1);
    }

    for (const accountId of [forgedOwner, siblingWriter, unrelated]) {
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectMutationForbidden(
        await deleteFact(bucket, db, roots.public, "priority:forbidden", {
          accountId,
        }),
        "delete",
      );
      expect(db.reads.priority).toBe(0);
      expect(db.writes.priority).toBe(0);
    }

    await expectAccountRequired(
      await deleteFact(bucket, db, roots.public, "priority:anonymous"),
    );

    for (const accountId of [undefined, unrelated, siblingWriter]) {
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectBranchNotFound(
        await deleteFact(bucket, db, roots.private, "", { accountId }),
      );
      expect(db.reads.priority).toBe(0);
      expect(db.writes.priority).toBe(0);
    }

    for (const [rootDropId, alias] of [
      [roots.tombstone, "PrDel1"],
      [roots.malformed, "PrDel2"],
    ] as const) {
      await bucket.put(createRemoteAliasKey(alias), rootDropId);
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectBranchNotFound(
        await deleteFact(bucket, db, alias, "", { accountId: canonicalOwner }),
      );
      expect(bucket.reads).toEqual({ aliases: 1, branches: 0, deeper: 0 });
      expect(bucket.writes).toBe(0);
      expect(db.runs).toBe(0);
      expect(db.writes).toEqual({ aliases: 0, priority: 0 });
      expect(db.reads.priority).toBe(0);
    }

    const legacyFactId = "priority:legacy:writer";
    db.priorityFacts.push(priorityFactForId(roots.legacy, legacyFactId));
    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const legacyWriter = await deleteFact(
      bucket,
      db,
      roots.legacy,
      legacyFactId,
      {
        accountId: writer,
      },
    );
    expect(legacyWriter.status).toBe(200);
    expect(db.writes.priority).toBe(1);
    await expectMutationForbidden(
      await deleteFact(bucket, db, roots.legacy, "priority:legacy:other", {
        accountId: unrelated,
      }),
      "delete",
    );

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const invalidFactId = await deleteFact(bucket, db, roots.public, "", {
      accountId: canonicalOwner,
    });
    expect(invalidFactId.status).toBe(400);
    await expect(invalidFactId.json()).resolves.toEqual({
      error: "factId is required.",
      code: "validation_failed",
    });
    expect(db.reads.priority).toBe(0);

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const missingFact = await deleteFact(
      bucket,
      db,
      roots.public,
      "priority:missing",
      { accountId: canonicalOwner },
    );
    expect(missingFact.status).toBe(404);
    await expect(missingFact.json()).resolves.toEqual({
      error: "Priority fact not found.",
      code: "priority_fact_not_found",
    });
    expect(db.reads.priority).toBe(1);
    expect(db.writes.priority).toBe(0);

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    await expectAccountRequired(
      await deleteFact(bucket, db, roots.public, "priority:bearer", {
        accountId: writer,
        authorization: "Bearer invalid",
      }),
    );
    expect(db.reads.priority).toBe(0);
    expect(db.writes.priority).toBe(0);
  });

  it("requires sensitive authority before listing priority facts", async () => {
    const { bucket, db } = await setup();
    for (const rootDropId of [
      roots.public,
      roots.unlisted,
      roots.private,
      roots.legacy,
    ]) {
      db.priorityFacts.push(
        priorityFact(rootDropId, RESOLVED_DOCUMENT_RESOLVER_ID, "node-target"),
      );
    }

    for (const [rootDropId, accountId] of [
      [roots.public, canonicalOwner],
      [roots.public, writer],
      [roots.unlisted, canonicalOwner],
      [roots.unlisted, writer],
      [roots.private, canonicalOwner],
      [roots.private, writer],
      [roots.legacy, writer],
    ] as const) {
      db.resetInstrumentation();
      const response = await list(bucket, db, rootDropId, accountId);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          facts: [expect.objectContaining({ rootDropId })],
        }),
      );
      expect(db.reads.priority).toBe(1);
    }

    db.resetInstrumentation();
    for (const accountId of [
      forgedOwner,
      siblingWriter,
      unrelated,
      undefined,
    ]) {
      await expectSensitiveForbidden(
        await list(bucket, db, roots.public, accountId),
      );
    }
    expect(db.reads.priority).toBe(0);

    for (const accountId of [
      forgedOwner,
      siblingWriter,
      unrelated,
      undefined,
    ]) {
      db.resetInstrumentation();
      await expectBranchNotFound(
        await list(bucket, db, roots.private, accountId),
      );
      expect(db.reads.priority).toBe(0);
    }
    for (const rootDropId of [roots.tombstone, roots.malformed]) {
      db.resetInstrumentation();
      bucket.resetInstrumentation();
      await expectBranchNotFound(
        await list(bucket, db, rootDropId, canonicalOwner),
      );
      expect(bucket.reads.branches).toBe(0);
      expect(db.reads.priority).toBe(0);
    }

    const noDatabase = await list(bucket, undefined, roots.noDatabase, writer);
    expect(noDatabase.status).toBe(200);
    await expect(noDatabase.json()).resolves.toEqual({
      rootDropId: roots.noDatabase,
      branchId: "writer",
      facts: [],
    });

    await bucket.put(createRemoteAliasKey("PrDn01"), roots.private);
    bucket.resetInstrumentation();
    db.resetInstrumentation();
    await expectBranchNotFound(await list(bucket, db, "PrDn01"));
    expect(bucket.reads).toEqual({ aliases: 1, branches: 0, deeper: 0 });
    expect(bucket.writes).toBe(0);
    expect(db.runs).toBe(0);
    expect(db.reads.priority).toBe(0);

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const badFilter = await list(
      bucket,
      db,
      roots.public,
      canonicalOwner,
      "?targetKind=invalid",
    );
    expect(badFilter.status).toBe(400);
    await expect(badFilter.json()).resolves.toEqual({
      error: "Invalid targetKind.",
      code: "validation_failed",
    });
    expect(bucket.reads.branches).toBe(1);
    expect(db.reads.priority).toBe(0);
  });
});
