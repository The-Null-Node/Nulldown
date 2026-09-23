import { describe, expect, it } from "@jest/globals";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../../../../../shared/drop/resolved/constants";
import {
  canonicalOwner,
  forgedOwner,
  hasPriorityReason,
  priorityFact,
  queryBody,
  resolvedQuery,
  roots,
  setup,
  unrelated,
  writer,
  type QueryBody,
} from "./testing/authorization-fixture";

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

describe("resolved query priority authorization", () => {
  it("omits priority overlays from ordinary public and unlisted document reads", async () => {
    const { bucket, db } = await setup();
    const baselines = new Map<string, QueryBody>();
    for (const rootDropId of [roots.public, roots.unlisted]) {
      const baselineResponse = await resolvedQuery(bucket, db, rootDropId);
      expect(baselineResponse.status).toBe(200);
      const baseline = await queryBody(baselineResponse);
      const target = baseline.nodes.find(({ node }) =>
        node.text.includes("Priority target"),
      );
      if (!target) throw new Error("Expected a priority target node.");
      baselines.set(rootDropId, baseline);
      db.priorityFacts.push(
        priorityFact(rootDropId, RESOLVED_DOCUMENT_RESOLVER_ID, target.node.id),
      );
    }

    for (const rootDropId of [roots.public, roots.unlisted]) {
      for (const accountId of [undefined, unrelated]) {
        db.resetInstrumentation();
        const response = await resolvedQuery(bucket, db, rootDropId, accountId);
        expect(response.status).toBe(200);
        const body = await queryBody(response);
        expect(hasPriorityReason(body)).toBe(false);
        expect(body.nodes.map(({ node }) => node.id)).toEqual(
          baselines.get(rootDropId)?.nodes.map(({ node }) => node.id),
        );
        expect(db.reads.priority).toBe(0);
      }
    }

    db.resetInstrumentation();
    const forged = await resolvedQuery(bucket, db, roots.public, forgedOwner);
    expect(forged.status).toBe(200);
    expect(hasPriorityReason(await queryBody(forged))).toBe(false);
    expect(db.reads.priority).toBe(0);
  });

  it("retains priority scoring for the canonical owner and exact writer", async () => {
    const { bucket, db } = await setup();
    const targets = new Map<string, string>();
    for (const [rootDropId, accountId] of [
      [roots.public, canonicalOwner],
      [roots.private, canonicalOwner],
    ] as const) {
      const response = await resolvedQuery(bucket, db, rootDropId, accountId);
      expect(response.status).toBe(200);
      const target = (await queryBody(response)).nodes.find(({ node }) =>
        node.text.includes("Priority target"),
      );
      if (!target) throw new Error("Expected a priority target node.");
      targets.set(rootDropId, target.node.id);
      db.priorityFacts.push(
        priorityFact(rootDropId, RESOLVED_DOCUMENT_RESOLVER_ID, target.node.id),
      );
    }

    for (const [rootDropId, accountId] of [
      [roots.public, canonicalOwner],
      [roots.public, writer],
      [roots.private, canonicalOwner],
      [roots.private, writer],
    ] as const) {
      db.resetInstrumentation();
      const response = await resolvedQuery(bucket, db, rootDropId, accountId);
      expect(response.status).toBe(200);
      const body = await queryBody(response);
      expect(body.nodes[0]).toEqual(
        expect.objectContaining({
          node: expect.objectContaining({ id: targets.get(rootDropId) }),
          reasons: expect.arrayContaining(["priority-fact"]),
        }),
      );
      expect(db.reads.priority).toBe(1);
    }

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    await expectBranchNotFound(await resolvedQuery(bucket, db, roots.private));
    expect(bucket.reads.branches).toBe(0);
    expect(bucket.reads.deeper).toBe(0);
    expect(db.reads.priority).toBe(0);
  });

  it("preserves runtime sensitive denial before priority reads and scoring for authority", async () => {
    const { bucket, db } = await setup();
    const runtimeQuery = `?resolverId=${RESOLVED_RUNTIME_REFS_RESOLVER_ID}`;
    const baselineResponse = await resolvedQuery(
      bucket,
      db,
      roots.public,
      canonicalOwner,
      runtimeQuery,
    );
    expect(baselineResponse.status).toBe(200);
    const runtimeTarget = (await queryBody(baselineResponse)).nodes[0];
    if (!runtimeTarget)
      throw new Error("Expected a runtime priority target node.");
    db.priorityFacts.push(
      priorityFact(
        roots.public,
        RESOLVED_RUNTIME_REFS_RESOLVER_ID,
        runtimeTarget.node.id,
      ),
    );

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    await expectSensitiveForbidden(
      await resolvedQuery(bucket, db, roots.public, undefined, runtimeQuery),
    );
    expect(bucket.reads.branches).toBe(1);
    expect(bucket.reads.deeper).toBe(0);
    expect(db.reads.priority).toBe(0);

    for (const accountId of [canonicalOwner, writer]) {
      db.resetInstrumentation();
      const response = await resolvedQuery(
        bucket,
        db,
        roots.public,
        accountId,
        runtimeQuery,
      );
      expect(response.status).toBe(200);
      const body = await queryBody(response);
      expect(body.nodes[0]).toEqual(
        expect.objectContaining({
          node: expect.objectContaining({ id: runtimeTarget.node.id }),
          reasons: expect.arrayContaining(["priority-fact"]),
        }),
      );
      expect(db.reads.priority).toBe(1);
    }
  });
});
