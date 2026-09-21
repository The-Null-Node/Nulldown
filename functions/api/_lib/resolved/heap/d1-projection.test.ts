import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../../../../shared/drop/branch";
import { dropResolvedHeapKey } from "../../../../../shared/drop/sidecar";
import { hashNulldownSourceContent } from "../../../../../shared/drop/resolved/hash";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../../../../shared/drop/resolved/constants";
import {
  createResolvedPriorityFact,
  deleteResolvedPriorityFact,
  listResolvedPriorityFacts,
  queryResolvedHeap,
} from "./service";
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

describe("D1 resolved heap metadata contracts", () => {
  it("persists generated resolved heaps and nodes to D1", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("drop_123456789", JSON.stringify({ content: "Public root" }));
    const db = new MemoryD1Database();
    const branch = createBranch({ headSnapshotId: 1 });
    const content = "# D1 Test\n\nA searchable paragraph.";
    const snapshot = createSnapshot({ snapshotId: 1, sourceContentHash: await hashNulldownSourceContent(content) });

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
    await writeSnapshotCheckpoint(
      bucket as unknown as R2Bucket,
      snapshot.rootDropId,
      snapshot.branchId,
      snapshot.snapshotId,
      content,
      snapshot.checkpointKey,
    );

    const response = await queryResolvedHeap(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
      },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/api/resolved/query?query=searchable"),
    );

    expect(response.status).toBe(200);
    expect(db.heaps.size).toBe(0);
    expect(db.nodes.size).toBeGreaterThan(0);
    expect(db.heapDeltas.size).toBe(1);
    expect(db.nodeRefs.size).toBe(db.nodes.size);
    expect(db.nodePayloads.size).toBe(db.nodes.size);
    const delta = JSON.parse(
      [...db.heapDeltas.values()][0].heap_delta_json,
    ) as {
      version: number;
      checkpointed: boolean;
      nodeRefs: unknown[];
    };
    expect(delta).toEqual(
      expect.objectContaining({ version: 1, checkpointed: true }),
    );
    expect(delta.nodeRefs.length).toBe(db.nodeRefs.size);
    const get = bucket.get.bind(bucket);
    bucket.get = async (key) => {
      if (key.startsWith("__drop_checkpoint__/") || key.startsWith("__drop_branch_diff")) {
        throw new Error("Valid SQL projection must not replay content, even after priority changes");
      }
      return get(key);
    };

    await bucket.delete(
      dropResolvedHeapKey(
        snapshot.rootDropId,
        snapshot.branchId,
        RESOLVED_DOCUMENT_RESOLVER_ID,
        snapshot.snapshotId,
      ),
    );
    const projectedResponse = await queryResolvedHeap(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
      },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/api/resolved/query?query=searchable"),
    );
    const projectedBody = (await projectedResponse.json()) as {
      heapGenerated: boolean;
      nodes: Array<{ node: { text: string } }>;
    };

    expect(projectedResponse.status).toBe(200);
    expect(projectedBody.heapGenerated).toBe(false);
    expect(projectedBody.nodes[0].node.text).toContain("searchable");
    expect(db.heaps.size).toBe(0);

    const prioritizedNode = [...db.nodes.values()]
      .map(
        (entry) =>
          JSON.parse(entry.node_json) as {
            id: string;
            kind: string;
            text: string;
          },
      )
      .find(
        (node) => node.kind === "paragraph" && node.text.includes("searchable"),
      );
    if (!prioritizedNode)
      throw new Error("Expected a searchable paragraph node.");
    const factResponse = await createResolvedPriorityFact(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/api/resolved/priority", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
        },
        body: JSON.stringify({
          targetKind: "node",
          targetId: prioritizedNode.id,
          priority: 3,
          reason: "Prioritize the paragraph for the agent.",
        }),
      }),
    );
    expect(factResponse.status).toBe(201);
    const factBody = (await factResponse.json()) as {
      fact: { factId: string; targetId: string };
    };
    expect(factBody.fact.targetId).toBe(prioritizedNode.id);
    expect(db.priorityFacts.size).toBe(1);

    const listResponse = await listResolvedPriorityFacts(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request(
        "https://example.test/api/resolved/priority?targetKind=node",
        {
          headers: {
            [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
          },
        },
      ),
    );
    const listBody = (await listResponse.json()) as {
      facts: Array<{ factId: string }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listBody.facts.map((fact) => fact.factId)).toEqual([
      factBody.fact.factId,
    ]);

    const priorityResponse = await queryResolvedHeap(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/api/resolved/query?top=1", {
        headers: {
          [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
        },
      }),
    );
    const priorityBody = (await priorityResponse.json()) as {
      heapGenerated: boolean;
      nodes: Array<{ node: { id: string }; reasons: string[] }>;
    };

    expect(priorityResponse.status).toBe(200);
    expect(priorityBody.heapGenerated).toBe(false);
    expect(priorityBody.nodes[0].node.id).toBe(prioritizedNode.id);
    expect(priorityBody.nodes[0].reasons).toContain("priority-fact");

    const deleteResponse = await deleteResolvedPriorityFact(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      {
        rootId: snapshot.rootDropId,
        branchId: snapshot.branchId,
        factId: encodeURIComponent(factBody.fact.factId),
      },
      new Request(
        `https://example.test/api/resolved/priority/${encodeURIComponent(factBody.fact.factId)}`,
        {
          method: "DELETE",
          headers: {
            [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
          },
        },
      ),
    );
    const deleteBody = (await deleteResponse.json()) as { deleted: boolean };
    expect(deleteResponse.status).toBe(200);
    expect(deleteBody.deleted).toBe(true);
    expect(db.priorityFacts.size).toBe(0);
  });

  it("runs explicit resolved query repair before reading branch content", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("drop_123456789", JSON.stringify({ content: "Public root" }));
    const db = new MemoryD1Database();
    const branch = createBranch();
    const snapshot = createSnapshot({ textLength: 45 });
    const repairs: Array<{
      rootDropId: string;
      branchId: string;
      snapshotId: number;
    }> = [];

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

    const response = await queryResolvedHeap(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
      },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/api/resolved/query?query=repair"),
      {
        repairBufferedCommits: async (target) => {
          repairs.push(target);
          await writeSnapshotCheckpoint(
            bucket as unknown as R2Bucket,
            target.rootDropId,
            target.branchId,
            target.snapshotId,
            "# Query Repair\n\nRepair materialized this content.",
            snapshot.checkpointKey,
          );
        },
      },
    );
    const body = (await response.json()) as {
      heapGenerated: boolean;
      nodes: Array<{ node: { text: string } }>;
    };

    expect(response.status).toBe(200);
    expect(repairs).toEqual([
      {
        rootDropId: snapshot.rootDropId,
        branchId: snapshot.branchId,
        snapshotId: snapshot.snapshotId,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      },
    ]);
    expect(body.heapGenerated).toBe(true);
    expect(body.nodes.some((entry) => entry.node.text.includes("Repair"))).toBe(
      true,
    );
  });

  for (const headEventSeq of [null, -1] as const) {
    it(`generates snapshot 0 resolved heaps when head event seq is ${headEventSeq}`, async () => {
      const bucket = new MemoryR2Bucket();
      await bucket.put("drop_123456789", JSON.stringify({ content: "Public root" }));
      const db = new MemoryD1Database();
      const branch = createBranch({ headEventSeq });
      const snapshot = createSnapshot();
      const content = "# Empty Branch\n\nInitial content.";

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
      await writeSnapshotCheckpoint(
        bucket as unknown as R2Bucket,
        snapshot.rootDropId,
        snapshot.branchId,
        snapshot.snapshotId,
        content,
        snapshot.checkpointKey,
      );

      const response = await queryResolvedHeap(
        {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: db as unknown as D1Database,
        },
        { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
        new Request(
          "https://example.test/api/resolved/query?snapshotId=0&query=initial",
        ),
      );
      const body = (await response.json()) as {
        heapGenerated: boolean;
        sourceContentHash?: string;
        nodes?: Array<{ node: { text: string } }>;
      };

      expect(response.status).toBe(200);
      expect(body.heapGenerated).toBe(true);
      expect(body.sourceContentHash).toMatch(/^sha256:/);
      expect(
        body.nodes?.some((entry) => entry.node.text.includes("Initial")),
      ).toBe(true);
    });
  }

  it("materializes compact v2 resolved heaps by walking parent deltas", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("drop_123456789", JSON.stringify({ content: "Public root" }));
    const db = new MemoryD1Database();
    const branch = createBranch({ headSnapshotId: 2, headEventSeq: 2 });
    const snapshots = [
      createSnapshot({ snapshotId: 0, textLength: 24 }),
      createSnapshot({ snapshotId: 1, textLength: 28 }),
      createSnapshot({ snapshotId: 2, textLength: 30 }),
    ];
    const contents = [
      "# Chain\n\nAlpha paragraph.",
      "# Chain\n\nBeta paragraph.",
      "# Chain\n\nFinal compact paragraph.",
    ];

    await writeBranch(
      bucket as unknown as R2Bucket,
      branch,
      db as unknown as D1Database,
    );
    for (const [index, snapshot] of snapshots.entries()) {
      await writeSnapshot(
        bucket as unknown as R2Bucket,
        snapshot,
        db as unknown as D1Database,
      );
      await writeSnapshotCheckpoint(
        bucket as unknown as R2Bucket,
        snapshot.rootDropId,
        snapshot.branchId,
        snapshot.snapshotId,
        contents[index],
        snapshot.checkpointKey,
      );
      const response = await queryResolvedHeap(
        {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: db as unknown as D1Database,
        },
        { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
        new Request(
          `https://example.test/api/resolved/query?snapshotId=${snapshot.snapshotId}&query=Chain`,
        ),
      );
      expect(response.status).toBe(200);
    }

    const deltas = [...db.heapDeltas.values()]
      .map(
        (entry) =>
          JSON.parse(entry.heap_delta_json) as {
            snapshotId: number;
            checkpointed: boolean;
            nodeRefs?: unknown[];
            nodeOps?: Array<{ op: string }>;
          },
      )
      .sort((left, right) => left.snapshotId - right.snapshotId);
    expect(deltas.map((delta) => delta.checkpointed)).toEqual([
      true,
      false,
      false,
    ]);
    expect(deltas[1].nodeRefs).toBeUndefined();
    expect(deltas[1].nodeOps?.some((op) => op.op === "upsert")).toBe(true);
    expect(deltas[1].nodeOps?.some((op) => op.op === "delete")).toBe(true);
    expect(
      db.sqlLog.some(
        (sql) =>
          sql.includes("INSERT INTO resolved_nodes") &&
          sql.includes(
            "ON CONFLICT(root_drop_id, branch_id, snapshot_id, resolver_id, node_id)",
          ),
      ),
    ).toBe(true);
    expect(
      db.sqlLog.some(
        (sql) =>
          sql.includes("INSERT INTO resolved_node_refs") &&
          sql.includes(
            "ON CONFLICT(root_drop_id, branch_id, snapshot_id, resolver_id, node_id)",
          ),
      ),
    ).toBe(true);

    for (const snapshot of snapshots) {
      await bucket.delete(
        dropResolvedHeapKey(
          snapshot.rootDropId,
          snapshot.branchId,
          RESOLVED_DOCUMENT_RESOLVER_ID,
          snapshot.snapshotId,
        ),
      );
    }
    db.heaps.clear();

    const compactResponse = await queryResolvedHeap(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
      },
      { rootId: branch.rootDropId, branchId: branch.branchId },
      new Request(
        "https://example.test/api/resolved/query?snapshotId=2&query=final&top=10",
      ),
    );
    const compactBody = (await compactResponse.json()) as {
      heapGenerated: boolean;
      nodes: Array<{ node: { text: string } }>;
    };

    expect(compactResponse.status).toBe(200);
    expect(compactBody.heapGenerated).toBe(false);
    expect(
      compactBody.nodes.some((entry) =>
        entry.node.text.includes("Final compact"),
      ),
    ).toBe(true);
    expect(
      compactBody.nodes.some((entry) => entry.node.text.includes("Alpha")),
    ).toBe(false);
  });
});
