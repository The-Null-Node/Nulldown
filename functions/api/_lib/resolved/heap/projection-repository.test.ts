import { describe, expect, it } from "@jest/globals";
import { createResolvedHeapProjectionRepository } from "./projection-repository";
import { readResolvedHeapState } from "./state";
import { RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../../../../../shared/drop/resolved/constants";
import { heapifyResolvedDocument } from "../../../../../shared/drop/resolved/heapify/document";
import { heapifyResolvedRuntimeRefs } from "../../../../../shared/drop/resolved/heapify/runtime-refs";
import { writeResolvedNulldownState } from "../../../../../shared/drop/resolved/storage";
import {
  memoryBlobs,
  projectionFixture,
  source,
} from "./testing/projection-fixture";

describe("resolved projection repository reuse contracts", () => {
  it("hydrates more than two chunks with ceil(unique hashes / 100) queries, preserving order and duplicates", async () => {
    const state = await heapifyResolvedDocument({
      ...source,
      content: Array.from({ length: 230 }, (_, i) => `Paragraph ${i}.`).join(
        "\n\n",
      ),
    });
    expect(state.documentNodes!.length).toBeGreaterThan(200);
    const fixture = await projectionFixture(state);
    fixture.delta.nodeRefs!.push(
      fixture.delta.nodeRefs![0],
      fixture.delta.nodeRefs![2],
    );
    const result = await fixture.read();
    expect(result?.documentNodes).toEqual([
      ...state.documentNodes!,
      state.documentNodes![0],
      state.documentNodes![2],
    ]);
    const reads = fixture.queries.filter(({ sql }) =>
      sql.includes("FROM resolved_node_payloads"),
    );
    expect(reads).toHaveLength(Math.ceil(fixture.payloads.size / 100));
    expect(reads.flatMap(({ values }) => values)).toHaveLength(
      fixture.payloads.size,
    );
    expect(
      fixture.queries.some(({ sql }) => sql.includes("FROM resolved_nodes")),
    ).toBe(false);
  });

  it("does not query payloads or legacy rows for empty refs", async () => {
    const state = {
      ...(await heapifyResolvedDocument(source)),
      documentNodes: [],
    };
    const fixture = await projectionFixture(state);
    expect((await fixture.read())?.documentNodes).toEqual([]);
    expect(
      fixture.queries.every(({ sql }) =>
        sql.includes("FROM resolved_heap_deltas"),
      ),
    ).toBe(true);
  });

  it.each(["missing", "invalid"])(
    "falls back as a whole for %s payloads and preserves ref order and duplicates",
    async (mode) => {
      const state = await heapifyResolvedDocument(source);
      const fixture = await projectionFixture(state);
      const hash = fixture.delta.nodeRefs![0].nodeHash;
      if (mode === "missing") fixture.payloads.delete(hash);
      else fixture.payloads.set(hash, "{}");
      for (const node of state.documentNodes!)
        fixture.legacyNodes.set(node.id, JSON.stringify(node));
      fixture.delta.nodeRefs!.push(fixture.delta.nodeRefs![0]);
      expect((await fixture.read())?.documentNodes).toEqual([
        ...state.documentNodes!,
        state.documentNodes![0],
      ]);
      expect(
        fixture.queries.filter(({ sql }) =>
          sql.includes("FROM resolved_nodes"),
        ),
      ).toHaveLength(1);
    },
  );

  it("rejects partial hydration, then uses full legacy state or R2 fallback", async () => {
    const state = await heapifyResolvedDocument(source);
    const fixture = await projectionFixture(state);
    fixture.payloads.clear();
    fixture.legacyNodes.set(
      state.documentNodes![0].id,
      JSON.stringify(state.documentNodes![0]),
    );
    expect(await fixture.read()).toBeNull();
    fixture.fixture.legacyState = state;
    expect(await fixture.read()).toEqual(state);
    fixture.fixture.legacyState = null;
    const R2_BUCKET = memoryBlobs();
    await writeResolvedNulldownState(R2_BUCKET, state);
    expect(
      await readResolvedHeapState(
        { R2_BUCKET, DB: fixture.db },
        source.rootDropId,
        source.branchId,
        state.resolverId,
        source.snapshotId,
      ),
    ).toEqual(state);
  });

  it("hydrates runtime payloads using the runtime validator", async () => {
    const state = await heapifyResolvedRuntimeRefs({
      ...source,
      content: '```nd(id="child-drop")\n```',
    });
    expect(state.runtimeNodes!.length).toBeGreaterThan(0);
    const fixture = await projectionFixture(state);
    expect((await fixture.read())?.runtimeNodes).toEqual(state.runtimeNodes);
    expect(state.resolverId).toBe(RESOLVED_RUNTIME_REFS_RESOLVER_ID);
  });

  it("does not share projection state across store, branch, snapshot, or resolver targets", async () => {
    const state = await heapifyResolvedDocument(source);
    const fixture = await projectionFixture(state);
    await fixture.read();
    const repository = createResolvedHeapProjectionRepository({
      sql: fixture.db,
    });
    for (const [root, branch, resolver, snapshot] of [
      ["other-root", source.branchId, state.resolverId, 0],
      [source.rootDropId, "other-branch", state.resolverId, 0],
      [source.rootDropId, source.branchId, "other-resolver", 0],
      [source.rootDropId, source.branchId, state.resolverId, 1],
    ] as const)
      expect(
        await repository.readState(root, branch, resolver, snapshot),
      ).toBeNull();
    const other = await projectionFixture(state);
    other.fixture.delta = null;
    expect(await other.read()).toBeNull();
  });
});
