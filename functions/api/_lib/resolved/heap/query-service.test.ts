import { describe, expect, it, jest } from "@jest/globals";
import type { LocalBranchApplicationSelection } from "../../../../../src/server/state-plane/commit-application";
import type { BranchBatchStatePlane } from "../../../../../shared/drop/branch-state";
import { queryResolvedHeap } from "./query-service";
import { updateResolvedHeap } from "./update-service";
import {
  createResolvedPriorityFact,
  deleteResolvedPriorityFact,
  listResolvedPriorityFacts,
} from "./priority-fact-service";
import { hashBranchSnapshotSource } from "../../../../../shared/drop/resolved/hash";
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

const selectedEnvironment = async (
  bucket: Parameters<typeof resolvedQuery>[0],
  db: Parameters<typeof resolvedQuery>[1],
  rootDropId: string,
  failContent = false,
) => {
  const content = "# Selected title\n\nSelected authority paragraph.";
  const branchId = "writer";
  const placement = { routingVersion: 1, generation: 1 };
  const sourceContentHash = await hashBranchSnapshotSource({
    rootDropId,
    branchId,
    snapshotId: 0,
    content,
  });
  const branch = {
    version: 1 as const,
    rootDropId,
    branchId,
    baseDropId: rootDropId,
    mode: "clone" as const,
    status: "active" as const,
    ownerAccountId: canonicalOwner,
    writerAccountId: writer,
    writerClientId: null,
    headSnapshotId: 0,
    headEventSeq: -1,
    createdAt: 1,
    updatedAt: 1,
  };
  const selection = {
    mode: "local-test" as const,
    placement,
    resolvedQuery: true,
    commits: {
      readHead: async () => ({
        target: { rootDropId, branchId },
        placement,
        branch,
        version: { snapshotId: 0, eventSeq: -1, sourceContentHash },
      }),
      readContent: async (
        query: Parameters<BranchBatchStatePlane["readContent"]>[0],
      ) => {
        if (failContent) throw new Error("selected_content_unavailable");
        return { ...query, content };
      },
      readEvents: async () => [],
      append: async () => {
        throw new Error("unexpected_append");
      },
      appendBatch: async () => {
        throw new Error("unexpected_append");
      },
    },
    history: {
      readSnapshot: async () => ({
        target: { rootDropId, branchId },
        placement,
        version: { snapshotId: 0, eventSeq: -1, sourceContentHash },
        snapshot: {
          version: 1,
          rootDropId,
          branchId,
          snapshotId: 0,
          parentSnapshotId: null,
          seq: 0,
          eventIds: [],
          checkpointed: true,
          sourceContentHash,
          textLength: content.length,
          createdAt: 1,
        },
      }),
      listSnapshots: async () => ({ snapshots: [], nextAfterSnapshotId: null }),
    },
  } as unknown as LocalBranchApplicationSelection;
  return {
    ...{
      R2_BUCKET: bucket,
      DB: db,
      ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      ACCOUNT_AUTH_SECRET: "test-secret",
    },
    localBranchApplication: selection,
  };
};

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

  it("serves selected immutable snapshots through queryResolvedHeap without projection I/O", async () => {
    const { bucket, db } = await setup();
    const env = await selectedEnvironment(bucket, db, roots.public);
    const response = await queryResolvedHeap(
      env,
      { rootId: roots.public, branchId: "writer" },
      new Request(
        `https://nulldown.test/api/branches/${roots.public}/writer/resolved/query?q=authority`,
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rootDropId: string;
      branchId: string;
      snapshotId: number;
      stale: boolean;
      heapGenerated: boolean;
      resolverId: string;
      nodes: Array<{ node: { text: string } }>;
    };
    expect(body).toMatchObject({
      rootDropId: roots.public,
      branchId: "writer",
      snapshotId: 0,
      stale: false,
      heapGenerated: true,
      resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
    });
    expect(
      body.nodes.some(({ node }) => node.text.includes("Selected authority")),
    ).toBe(true);
    expect(bucket.writes).toBe(0);
    expect(bucket.reads.deeper).toBe(0);
  });

  it("retains private-root denial and never falls back after selected source failure", async () => {
    const { bucket, db } = await setup();
    const privateEnv = await selectedEnvironment(bucket, db, roots.private);
    const denied = await queryResolvedHeap(
      privateEnv,
      { rootId: roots.private, branchId: "writer" },
      new Request(
        `https://nulldown.test/api/branches/${roots.private}/writer/resolved/query`,
      ),
    );
    expect(denied.status).toBe(404);

    const failingEnv = await selectedEnvironment(
      bucket,
      db,
      roots.public,
      true,
    );
    bucket.resetInstrumentation();
    const failed = await queryResolvedHeap(
      failingEnv,
      { rootId: roots.public, branchId: "writer" },
      new Request(
        `https://nulldown.test/api/branches/${roots.public}/writer/resolved/query`,
      ),
    );
    expect(failed.status).toBe(503);
    expect(bucket.writes).toBe(0);
    expect(bucket.reads.deeper).toBe(0);
  });

  it("rejects unsupported selected resolvers explicitly after sensitive authorization", async () => {
    const { bucket, db } = await setup();
    const env = await selectedEnvironment(bucket, db, roots.public);
    const request = new Request(
      `https://nulldown.test/api/branches/${roots.public}/writer/resolved/query?resolverId=${RESOLVED_RUNTIME_REFS_RESOLVER_ID}`,
      { headers: { "x-nulldown-account-id": writer } },
    );
    const response = await queryResolvedHeap(
      env,
      { rootId: roots.public, branchId: "writer" },
      request,
    );
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      code: "capability_unsupported",
    });
  });

  it.each([
    [roots.public, canonicalOwner],
    [roots.public, writer],
    [roots.private, canonicalOwner],
  ])(
    "serves authenticated selected document queries for %s without D1 priority reads",
    async (rootDropId, accountId) => {
      const { bucket, db } = await setup();
      const env = await selectedEnvironment(bucket, db, rootDropId);
      db.resetInstrumentation();
      const response = await queryResolvedHeap(
        env,
        { rootId: rootDropId, branchId: "writer" },
        new Request(
          `https://nulldown.test/api/branches/${rootDropId}/writer/resolved/query?q=authority`,
          { headers: { "x-nulldown-account-id": accountId } },
        ),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        nodes: Array<{ node: { text: string } }>;
      };
      expect(
        body.nodes.some(({ node }) => node.text.includes("Selected authority")),
      ).toBe(true);
      expect(db.reads.priority).toBe(0);
    },
  );

  it("rejects selected unknown snapshotters before legacy dispatch", async () => {
    const { bucket, db } = await setup();
    const env = await selectedEnvironment(bucket, db, roots.public);
    const querySnapshotter = jest.fn(() => ({ items: [{ text: "legacy" }] }));
    const response = await queryResolvedHeap(
      env,
      { rootId: roots.public, branchId: "writer" },
      new Request(
        `https://nulldown.test/api/branches/${roots.public}/writer/resolved/query?snapshotterId=legacy.snapshotter`,
        {
          headers: { "x-nulldown-account-id": writer },
        },
      ),
      { querySnapshotter },
    );
    expect(response.status).toBe(501);
    expect(querySnapshotter).not.toHaveBeenCalled();
  });

  it("rejects selected priority fact reads and writes without D1 priority access", async () => {
    const { bucket, db } = await setup();
    const env = await selectedEnvironment(bucket, db, roots.public);
    const headers = {
      "x-nulldown-account-id": writer,
      "content-type": "application/json",
    };
    const listResponse = await listResolvedPriorityFacts(
      env,
      { rootId: roots.public, branchId: "writer" },
      new Request(
        `https://nulldown.test/api/branches/${roots.public}/writer/resolved/priority`,
        { headers },
      ),
    );
    const createResponse = await createResolvedPriorityFact(
      env,
      { rootId: roots.public, branchId: "writer" },
      new Request(
        `https://nulldown.test/api/branches/${roots.public}/writer/resolved/priority`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ targetKind: "heap", priority: 2 }),
        },
      ),
    );
    const deleteResponse = await deleteResolvedPriorityFact(
      env,
      { rootId: roots.public, branchId: "writer", factId: "priority:example" },
      new Request(
        `https://nulldown.test/api/branches/${roots.public}/writer/resolved/priority/priority%3Aexample`,
        {
          method: "DELETE",
          headers,
        },
      ),
    );
    for (const response of [listResponse, createResponse, deleteResponse]) {
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({
        code: "capability_unsupported",
      });
    }
    expect(db.reads.priority).toBe(0);
    expect(db.writes.priority).toBe(0);
  });

  it("rejects selected heap rebuilds before legacy snapshot or projection access", async () => {
    const { bucket, db } = await setup();
    const env = await selectedEnvironment(bucket, db, roots.public);
    bucket.resetInstrumentation();
    const response = await updateResolvedHeap(
      env,
      { rootId: roots.public, branchId: "writer" },
      new Request(
        `https://nulldown.test/api/branches/${roots.public}/writer/resolved/update`,
        {
          method: "POST",
          headers: {
            "x-nulldown-account-id": writer,
            "content-type": "application/json",
          },
          body: JSON.stringify({ resolverId: "all" }),
        },
      ),
    );
    expect(response.status).toBe(501);
    expect(bucket.reads.deeper).toBe(0);
    expect(bucket.writes).toBe(0);
  });
});
