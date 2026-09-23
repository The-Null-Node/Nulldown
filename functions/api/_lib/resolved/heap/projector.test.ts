import { describe, expect, it, jest } from "@jest/globals";
import { appendEventsToBranch } from "../../nulledit/service";
import { createBranchRuntimeFactLogRepository } from "../../branches/storage/runtime-fact-log";
import { createBranchRepository } from "../../branches/storage/repository";
import { createCheckpointKey } from "../../branches/storage/keys";
import { putNullplugUiResponseFact } from "../../nullplug/facts/repository";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_DOCUMENT_RESOLVER_VERSION,
} from "../../../../../shared/drop/resolved/constants";
import { hashNulldownSourceContent } from "../../../../../shared/drop/resolved/hash";
import { heapifyResolvedDocument } from "../../../../../shared/drop/resolved/heapify/document";
import { heapifyResolvedRuntimeRefs } from "../../../../../shared/drop/resolved/heapify/runtime-refs";
import { writeResolvedNulldownState } from "../../../../../shared/drop/resolved/storage";
import { isDropSnapshotRecord } from "../../../../../shared/drop/branch";
import { dropResolvedHeapKey } from "../../../../../shared/drop/sidecar";
import { ensureResolvedHeapProjection } from "./projector";
import { readResolvedHeapState } from "./state";
import {
  memoryBlobs,
  projectionFixture,
  source,
} from "./testing/projection-fixture";
import {
  documentFixture,
  makeEvent,
  rootDropId,
} from "./testing/route-fixture";

describe("resolved projection regeneration contracts", () => {
  it("reuses a current compact SQL projection without writing or loading the R2 fallback", async () => {
    const state = await heapifyResolvedDocument(source);
    const fixture = await projectionFixture(state);
    const R2_BUCKET = memoryBlobs();
    R2_BUCKET.get = async () => {
      throw new Error("Unexpected R2 fallback");
    };
    const result = await ensureResolvedHeapProjection(
      { R2_BUCKET, DB: fixture.db },
      state.resolverId,
      source,
      state.sourceContentHash,
    );
    expect(result).toMatchObject({
      heapGenerated: false,
      stale: false,
      state: { resolverVersion: RESOLVED_DOCUMENT_RESOLVER_VERSION },
    });
    expect(result.state?.documentNodes).toEqual(state.documentNodes);
  });

  it("rebuilds a mismatched document resolver version and then reuses the current projection", async () => {
    const R2_BUCKET = memoryBlobs();
    const state = await heapifyResolvedDocument(source);
    await writeResolvedNulldownState(R2_BUCKET, {
      ...state,
      resolverVersion: `${RESOLVED_DOCUMENT_RESOLVER_VERSION}-old`,
    });
    const rebuilt = await ensureResolvedHeapProjection(
      { R2_BUCKET },
      state.resolverId,
      source,
      state.sourceContentHash,
    );
    expect(rebuilt).toMatchObject({
      heapGenerated: true,
      stale: false,
      state: { resolverVersion: RESOLVED_DOCUMENT_RESOLVER_VERSION },
    });
    const reused = await ensureResolvedHeapProjection(
      { R2_BUCKET },
      state.resolverId,
      source,
      state.sourceContentHash,
    );
    expect(reused).toEqual({ ...rebuilt, heapGenerated: false });
  });

  it("revalidates content even when snapshot zero and resolver version are unchanged", async () => {
    const R2_BUCKET = memoryBlobs();
    const state = await heapifyResolvedDocument(source);
    await writeResolvedNulldownState(R2_BUCKET, state);
    const changed = { ...source, content: "# Changed root content" };
    const expected = await heapifyResolvedDocument(changed);
    const result = await ensureResolvedHeapProjection(
      { R2_BUCKET },
      RESOLVED_DOCUMENT_RESOLVER_ID,
      changed,
      expected.sourceContentHash,
    );
    expect(result.heapGenerated).toBe(true);
    expect(result.state?.sourceContentHash).toBe(expected.sourceContentHash);
    expect(result.state?.documentNodes).toEqual(expected.documentNodes);
  });

  it("checks the durable runtime cursor again on reuse and includes newly accepted facts", async () => {
    const R2_BUCKET = memoryBlobs();
    const state = await heapifyResolvedRuntimeRefs(source);
    const ensure = () =>
      ensureResolvedHeapProjection(
        { R2_BUCKET },
        state.resolverId,
        source,
        state.sourceContentHash,
      );
    expect((await ensure()).heapGenerated).toBe(true);
    expect((await ensure()).heapGenerated).toBe(false);
    const fact = {
      version: 1 as const,
      kind: "ui.response" as const,
      id: "fresh-response",
      primitiveId: "approval",
      createdAt: 123,
      source: {
        rootDropId: source.rootDropId,
        branchId: source.branchId,
        snapshotId: 0,
      },
      data: { approved: true },
    };
    await putNullplugUiResponseFact(R2_BUCKET, fact);
    await createBranchRuntimeFactLogRepository({
      blobs: R2_BUCKET,
    }).appendBranchRuntimeFact(source.rootDropId, source.branchId, fact);
    const refreshed = await ensure();
    expect(refreshed.heapGenerated).toBe(true);
    expect(refreshed.state?.sourceSeqRange?.to).toBe(0);
    expect(refreshed.state?.runtimeNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "ui.response",
          primitiveId: "approval",
        }),
      ]),
    );
    expect((await ensure()).heapGenerated).toBe(false);
  });
});

describe("resolved projection route repair contracts", () => {
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

  it("stamps authoritative content at append and reuses even the first legacy projection query without replay", async () => {
    const { bucket, blobs, result, query, branch } = await documentFixture();
    expect(result.snapshot?.sourceContentHash).toBe(
      await hashNulldownSourceContent(result.content),
    );
    const initial = await createBranchRepository({ blobs }).readSnapshot(
      rootDropId,
      branch.branchId,
      0,
    );
    expect(initial?.sourceContentHash).toBeUndefined();
    const get = jest.spyOn(bucket, "get");
    for (let i = 0; i < 2; i++) {
      const response = await query();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        heapGenerated: false,
        stale: false,
      });
    }
    expect(
      get.mock.calls.some(
        ([key]) =>
          key.startsWith("__drop_checkpoint__/") ||
          key.startsWith("__drop_branch_diff"),
      ),
    ).toBe(false);
  });

  it("keeps legacy snapshots readable but replays each query without backfilling authority", async () => {
    const { bucket, result, query, snapshotKey } = await documentFixture();
    const legacy = { ...result.snapshot! };
    delete legacy.sourceContentHash;
    expect(isDropSnapshotRecord(legacy)).toBe(true);
    bucket.seed(snapshotKey, JSON.stringify(legacy));
    const get = jest.spyOn(bucket, "get");
    for (let i = 0; i < 2; i++) {
      get.mockClear();
      expect((await query()).status).toBe(200);
      expect(
        get.mock.calls.some(([key]) => key.startsWith("__drop_checkpoint__/")),
      ).toBe(true);
      expect(
        get.mock.calls.some(([key]) =>
          key.startsWith("__drop_branch_diff_events__/"),
        ),
      ).toBe(true);
    }
    expect(await (await bucket.get(snapshotKey)).json()).toEqual(legacy);
  });

  it.each([
    "hash",
    "version",
    "root",
    "branch",
    "snapshot",
    "resolver",
    "missing",
  ])(
    "repairs a %s projection only after replay and then reuses it",
    async (mismatch) => {
      const { bucket, state, projectionKey, query } = await documentFixture();
      const invalid = { ...state };
      if (mismatch === "hash")
        invalid.sourceContentHash = await hashNulldownSourceContent("old");
      if (mismatch === "version") invalid.resolverVersion = "old";
      if (mismatch === "root") invalid.rootDropId = "other";
      if (mismatch === "branch") invalid.branchId = "other";
      if (mismatch === "snapshot") invalid.snapshotId = 2;
      if (mismatch === "resolver") invalid.resolverId = "other";
      bucket.seed(projectionKey, JSON.stringify(invalid));
      if (mismatch === "missing") await bucket.delete(projectionKey);
      const get = jest.spyOn(bucket, "get");
      const response = await query();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        heapGenerated: true,
        sourceContentHash: state.sourceContentHash,
      });
      expect(
        get.mock.calls.some(([key]) => key.startsWith("__drop_checkpoint__/")),
      ).toBe(true);
      get.mockClear();
      expect(await (await query()).json()).toMatchObject({
        heapGenerated: false,
      });
      expect(
        get.mock.calls.some(([key]) => key.startsWith("__drop_checkpoint__/")),
      ).toBe(false);
    },
  );

  it.each([
    "hash",
    "malformed-hash",
    "null-hash",
    "metadata",
    "root",
    "branch",
    "snapshot",
  ])(
    "fails explicitly for inconsistent %s snapshot authority without overwriting it",
    async (mismatch) => {
      const { bucket, result, query, snapshotKey } = await documentFixture();
      const invalid = { ...result.snapshot! } as Record<string, unknown>;
      if (mismatch === "hash")
        invalid.sourceContentHash =
          await hashNulldownSourceContent("not accepted");
      if (mismatch === "malformed-hash")
        invalid.sourceContentHash = "sha256:broken";
      if (mismatch === "null-hash") invalid.sourceContentHash = null;
      if (mismatch === "metadata") invalid.textLength = "broken";
      if (mismatch === "root") invalid.rootDropId = "other";
      if (mismatch === "branch") invalid.branchId = "other";
      if (mismatch === "snapshot") invalid.snapshotId = 2;
      bucket.seed(snapshotKey, JSON.stringify(invalid));
      const put = jest.spyOn(bucket, "put");
      const response = await query();
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining(
          mismatch === "hash"
            ? "snapshot_source_hash_mismatch"
            : "snapshot_source_identity_invalid",
        ),
      });
      expect(put).not.toHaveBeenCalled();
      expect(await (await bucket.get(snapshotKey)).json()).toEqual(invalid);
    },
  );

  it("always reconstructs mutable snapshot zero even if a hash and matching old projection are present", async () => {
    const { bucket, blobs, branch, query } = await documentFixture();
    const repository = createBranchRepository({ blobs });
    const initial = (await repository.readSnapshot(
      rootDropId,
      branch.branchId,
      0,
    ))!;
    const old = await heapifyResolvedDocument({
      rootDropId,
      branchId: branch.branchId,
      snapshotId: 0,
      content: "",
    });
    await repository.writeSnapshot({
      ...initial,
      sourceContentHash: old.sourceContentHash,
    });
    await writeResolvedNulldownState(blobs, old);
    bucket.seed(
      createCheckpointKey(rootDropId, branch.branchId, 0),
      "# Mutable replacement",
      "text/plain",
    );
    const response = await query(0);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      heapGenerated: true,
      sourceContentHash: await hashNulldownSourceContent(
        "# Mutable replacement",
      ),
    });
  });

  it("repairs historical projections with the selected snapshot event cursor, not the current head", async () => {
    const { bucket, blobs, branch, result, query, projectionKey } =
      await documentFixture();
    await appendEventsToBranch(blobs, result.branch, [
      { ...makeEvent("later"), eventId: "later" },
    ]);
    await bucket.delete(projectionKey);
    expect((await query()).status).toBe(200);
    const state = await readResolvedHeapState(
      { R2_BUCKET: blobs },
      rootDropId,
      branch.branchId,
      RESOLVED_DOCUMENT_RESOLVER_ID,
      1,
    );
    expect(state?.sourceSeqRange).toEqual({ from: 0, to: 0 });
    expect(
      await bucket.get(
        dropResolvedHeapKey(
          rootDropId,
          branch.branchId,
          RESOLVED_DOCUMENT_RESOLVER_ID,
          2,
        ),
      ),
    ).toBeNull();
  });
});
