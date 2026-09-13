import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest as onResolvedQueryRequest } from "../functions/api/branches/[rootId]/[branchId]/resolved/query";
import { onRequest as onResolvedUpdateRequest } from "../functions/api/branches/[rootId]/[branchId]/resolved/update";
import { appendEventsToBranch } from "../functions/api/_lib/nulledit/service";
import { resolveBranchForActor } from "../functions/api/_lib/branches/lifecycle/service";
import type { DropDiffEvent } from "../shared/drop/diff";
import { NULLDOWN_ACCOUNT_ID_HEADER, isDropSnapshotRecord } from "../shared/drop/branch";
import { createBranchRepository } from "../functions/api/_lib/branches/storage/repository";
import { createCheckpointKey, createSnapshotKey } from "../functions/api/_lib/branches/storage/keys";
import { hashNulldownSourceContent } from "../shared/drop/resolved/hash";
import { heapifyResolvedDocument } from "../shared/drop/resolved/heapify/document";
import { writeResolvedNulldownState } from "../shared/drop/resolved/storage";
import { readResolvedHeapState } from "../functions/api/_lib/resolved/heap/state";
import { dropResolvedHeapKey } from "../shared/drop/sidecar";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../shared/drop/resolved/constants";
import { RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../shared/drop/resolved/constants";
import {
  nullplugUiResponseFactKey,
  nullplugUiStatePatchFactKey,
} from "../shared/nullplug/ui";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

  seed(key: string, value: string, contentType = "application/json"): string {
    const etag = this.createEtag(`${key}:${value}:${Date.now()}`);
    this.objects.set(key, {
      value,
      contentType,
      etag,
      uploaded: new Date(),
    });
    return etag;
  }

  async get(key: string): Promise<any> {
    const existing = this.objects.get(key);
    if (!existing) return null;
    return {
      body: new Response(existing.value).body,
      httpMetadata: { contentType: existing.contentType },
      httpEtag: existing.etag,
      uploaded: existing.uploaded,
      etag: existing.etag,
      key,
      size: existing.value.length,
      checksums: {
        md5: undefined,
        sha1: undefined,
        sha256: undefined,
        sha384: undefined,
        sha512: undefined,
      },
      version: "v1",
      writeHttpMetadata: () => {},
      writeChecksums: () => {},
      arrayBuffer: async () =>
        new TextEncoder().encode(existing.value).buffer as ArrayBuffer,
      text: async () => existing.value,
      json: async <T>() => JSON.parse(existing.value) as T,
      blob: async () => new Blob([existing.value]),
    };
  }

  async head(key: string): Promise<any> {
    const existing = this.objects.get(key);
    if (!existing) return null;
    return {
      key,
      etag: existing.etag,
      httpEtag: existing.etag,
      uploaded: existing.uploaded,
      size: existing.value.length,
      version: "v1",
      checksums: {
        md5: undefined,
        sha1: undefined,
        sha256: undefined,
        sha384: undefined,
        sha512: undefined,
      },
      httpMetadata: { contentType: existing.contentType },
      writeHttpMetadata: () => {},
      writeChecksums: () => {},
    };
  }

  async put(
    key: string,
    value:
      | string
      | ArrayBuffer
      | ArrayBufferView
      | Blob
      | ReadableStream
      | null,
    options?: any,
  ): Promise<any> {
    const existing = this.objects.get(key);
    const onlyIf = options?.onlyIf;
    if (onlyIf && "etagDoesNotMatch" in onlyIf) {
      if (onlyIf.etagDoesNotMatch === "*" && existing) return null;
    }
    if (onlyIf && "etagMatches" in onlyIf) {
      if (!existing || existing.etag !== onlyIf.etagMatches) return null;
    }

    const asText = await this.toText(value);
    const uploaded = new Date();
    const contentType = options?.httpMetadata?.contentType ?? "text/plain";
    const next: StoredObject = {
      value: asText,
      contentType,
      etag: this.createEtag(`${key}:${asText}:${uploaded.getTime()}`),
      uploaded,
    };
    this.objects.set(key, next);
    return {
      key,
      etag: next.etag,
      size: asText.length,
      uploaded,
      checksums: {
        md5: undefined,
        sha1: undefined,
        sha256: undefined,
        sha384: undefined,
        sha512: undefined,
      },
      httpEtag: next.etag,
      version: "v1",
      httpMetadata: { contentType: next.contentType },
      customMetadata: {},
      range: undefined,
      writeHttpMetadata: () => {},
      writeChecksums: () => {},
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    if (Array.isArray(keys)) {
      keys.forEach((key) => this.objects.delete(key));
      return;
    }
    this.objects.delete(keys);
  }

  async list(options?: { limit?: number; prefix?: string; cursor?: string }): Promise<any> {
    const prefix = options?.prefix ?? "";
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 1000));
    const startIndex = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const matching = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right));
    const page = matching.slice(startIndex, startIndex + limit);
    const nextOffset = startIndex + page.length;
    const truncated = nextOffset < matching.length;
    return {
      objects: page.map(([key, value]) => ({
        key,
        etag: value.etag,
        httpEtag: value.etag,
        uploaded: value.uploaded,
        size: value.value.length,
        version: "v1",
        checksums: {
          md5: undefined,
          sha1: undefined,
          sha256: undefined,
          sha384: undefined,
          sha512: undefined,
        },
        httpMetadata: { contentType: value.contentType },
        customMetadata: {},
        range: undefined,
        writeHttpMetadata: () => {},
        writeChecksums: () => {},
      })),
      truncated,
      cursor: truncated ? String(nextOffset) : undefined,
      delimitedPrefixes: [],
    };
  }

  private createEtag(input: string): string {
    return createHash("sha1").update(input).digest("hex");
  }

  private async toText(
    value:
      | string
      | ArrayBuffer
      | ArrayBufferView
      | Blob
      | ReadableStream
      | null,
  ): Promise<string> {
    if (typeof value === "string") return value;
    if (value === null) return "";
    return await new Response(value as BodyInit).text();
  }
}

const rootDropId = "ResolvedRoot1122";
const accountId = "acct_1";

const createSeededBucket = (): MemoryR2Bucket => {
  const bucket = new MemoryR2Bucket();
  bucket.seed(
    rootDropId,
    JSON.stringify({ content: "", metadata: { ownerAccountId: accountId } }),
  );
  return bucket;
};

const makeEvent = (text: string): DropDiffEvent => ({
  eventId: "evt-policy-doc",
  seq: 0,
  dropId: rootDropId,
  sourceClientId: "agent",
  createdAt: 123,
  metadata: {
    kind: "agent.edit",
    intent: "Add policy section and nullplug reference.",
    labels: ["policy", "nullplug"],
  },
  ops: [{ type: "insert", start: 0, end: 0, text }],
});

const documentFixture = async () => {
  const bucket = createSeededBucket();
  const blobs = bucket as unknown as R2Bucket;
  const { branch } = await resolveBranchForActor(blobs, rootDropId, accountId, null);
  const result = await appendEventsToBranch(blobs, branch, [makeEvent("# Authoritative content")]);
  const state = await heapifyResolvedDocument({ rootDropId, branchId: branch.branchId, snapshotId: 1, content: result.content });
  const projectionKey = await writeResolvedNulldownState(blobs, state);
  const query = (snapshotId = 1) => onResolvedQueryRequest({
    request: new Request(`https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/query?snapshotId=${snapshotId}`),
    env: { R2_BUCKET: blobs }, params: { rootId: rootDropId, branchId: branch.branchId },
  } as unknown as Parameters<typeof onResolvedQueryRequest>[0]);
  return { bucket, blobs, branch, result, state, projectionKey, query,
    snapshotKey: createSnapshotKey(rootDropId, branch.branchId, 1) };
};

describe("functions api branch resolved query contracts", () => {
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
    expect(result.snapshot?.sourceContentHash).toBe(await hashNulldownSourceContent(result.content));
    const initial = await createBranchRepository({ blobs }).readSnapshot(rootDropId, branch.branchId, 0);
    expect(initial?.sourceContentHash).toBeUndefined();
    const get = jest.spyOn(bucket, "get");
    for (let i = 0; i < 2; i++) {
      const response = await query();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ heapGenerated: false, stale: false });
    }
    expect(get.mock.calls.some(([key]) => key.startsWith("__drop_checkpoint__/") || key.startsWith("__drop_branch_diff"))).toBe(false);
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
      expect(get.mock.calls.some(([key]) => key.startsWith("__drop_checkpoint__/"))).toBe(true);
      expect(get.mock.calls.some(([key]) => key.startsWith("__drop_branch_diff_events__/"))).toBe(true);
    }
    expect(await (await bucket.get(snapshotKey)).json()).toEqual(legacy);
  });

  it.each(["hash", "version", "root", "branch", "snapshot", "resolver", "missing"])(
    "repairs a %s projection only after replay and then reuses it", async (mismatch) => {
      const { bucket, state, projectionKey, query } = await documentFixture();
      const invalid = { ...state };
      if (mismatch === "hash") invalid.sourceContentHash = await hashNulldownSourceContent("old");
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
      expect(await response.json()).toMatchObject({ heapGenerated: true, sourceContentHash: state.sourceContentHash });
      expect(get.mock.calls.some(([key]) => key.startsWith("__drop_checkpoint__/"))).toBe(true);
      get.mockClear();
      expect(await (await query()).json()).toMatchObject({ heapGenerated: false });
      expect(get.mock.calls.some(([key]) => key.startsWith("__drop_checkpoint__/"))).toBe(false);
    },
  );

  it.each(["hash", "malformed-hash", "null-hash", "metadata", "root", "branch", "snapshot"])(
    "fails explicitly for inconsistent %s snapshot authority without overwriting it", async (mismatch) => {
      const { bucket, result, query, snapshotKey } = await documentFixture();
      const invalid = { ...result.snapshot! } as Record<string, unknown>;
      if (mismatch === "hash") invalid.sourceContentHash = await hashNulldownSourceContent("not accepted");
      if (mismatch === "malformed-hash") invalid.sourceContentHash = "sha256:broken";
      if (mismatch === "null-hash") invalid.sourceContentHash = null;
      if (mismatch === "metadata") invalid.textLength = "broken";
      if (mismatch === "root") invalid.rootDropId = "other";
      if (mismatch === "branch") invalid.branchId = "other";
      if (mismatch === "snapshot") invalid.snapshotId = 2;
      bucket.seed(snapshotKey, JSON.stringify(invalid));
      const put = jest.spyOn(bucket, "put");
      const response = await query();
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining(
        mismatch === "hash" ? "snapshot_source_hash_mismatch" : "snapshot_source_identity_invalid",
      ) });
      expect(put).not.toHaveBeenCalled();
      expect(await (await bucket.get(snapshotKey)).json()).toEqual(invalid);
    },
  );

  it("always reconstructs mutable snapshot zero even if a hash and matching old projection are present", async () => {
    const { bucket, blobs, branch, query } = await documentFixture();
    const repository = createBranchRepository({ blobs });
    const initial = (await repository.readSnapshot(rootDropId, branch.branchId, 0))!;
    const old = await heapifyResolvedDocument({ rootDropId, branchId: branch.branchId, snapshotId: 0, content: "" });
    await repository.writeSnapshot({ ...initial, sourceContentHash: old.sourceContentHash });
    await writeResolvedNulldownState(blobs, old);
    bucket.seed(createCheckpointKey(rootDropId, branch.branchId, 0), "# Mutable replacement", "text/plain");
    const response = await query(0);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ heapGenerated: true, sourceContentHash: await hashNulldownSourceContent("# Mutable replacement") });
  });

  it("repairs historical projections with the selected snapshot event cursor, not the current head", async () => {
    const { bucket, blobs, branch, result, query, projectionKey } = await documentFixture();
    await appendEventsToBranch(blobs, result.branch, [{ ...makeEvent("later"), eventId: "later" }]);
    await bucket.delete(projectionKey);
    expect((await query()).status).toBe(200);
    const state = await readResolvedHeapState({ R2_BUCKET: blobs }, rootDropId, branch.branchId, RESOLVED_DOCUMENT_RESOLVER_ID, 1);
    expect(state?.sourceSeqRange).toEqual({ from: 0, to: 0 });
    expect(await bucket.get(dropResolvedHeapKey(rootDropId, branch.branchId, RESOLVED_DOCUMENT_RESOLVER_ID, 2))).toBeNull();
  });

  it("returns top resolved document nodes with diff metadata refs", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const content = [
      "# Runtime Plan",
      "",
      "## Policy",
      "Policy mutation downgrade rules live here.",
      "```nd(id=\"child-drop-1\")",
      "```",
    ].join("\n");
    await appendEventsToBranch(bucket as unknown as R2Bucket, branch, [makeEvent(content)]);

    const response = await onResolvedQueryRequest({
      request: new Request(
        `https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/query?q=mutation&fromSeq=0&toSeq=0&k=20`,
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { rootId: rootDropId, branchId: branch.branchId },
    } as unknown as Parameters<typeof onResolvedQueryRequest>[0]);

    const body = (await response.json()) as {
      heapGenerated: boolean;
      nodes: Array<{
        node: { kind: string; text: string; pluginId?: string };
        reasons: string[];
        eventRefs?: Array<{ metadata?: { intent?: string } }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.heapGenerated).toBe(true);
    expect(body.nodes[0].node.text).toContain("Policy");
    expect(body.nodes[0].reasons).toEqual(
      expect.arrayContaining(["query-match", "changed-range-overlap"]),
    );
    expect(body.nodes[0].eventRefs?.[0].metadata?.intent).toBe(
      "Add policy section and nullplug reference.",
    );
    expect(body.nodes.some((entry) => entry.node.pluginId === "nd")).toBe(true);
  });

  it("returns compact resolved document items for the snapshotterId projection", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const content = [
      "# Compact Projection Plan",
      "",
      "## Policy",
      "Compact projection policy content should be available without full node payloads.",
      "This extra sentence makes the source section long enough to prove text trimming stays bounded.",
    ].join("\n");
    await appendEventsToBranch(bucket as unknown as R2Bucket, branch, [makeEvent(content)]);

    const response = await onResolvedQueryRequest({
      request: new Request(
        `https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/query?snapshotterId=nulledit.resolved-document&q=projection&k=2`,
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { rootId: rootDropId, branchId: branch.branchId },
    } as unknown as Parameters<typeof onResolvedQueryRequest>[0]);

    const body = (await response.json()) as {
      items: Array<{
        id: string;
        kind: string;
        score: number;
        text: string;
        sourceRange: { start: number; end: number };
        node?: unknown;
      }>;
      nodes?: unknown[];
      snapshotterId?: string;
    };

    expect(response.status).toBe(200);
    expect(body.snapshotterId).toBe("nulledit.resolved-document");
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        kind: expect.any(String),
        score: expect.any(Number),
        text: expect.stringMatching(/projection/i),
        sourceRange: expect.objectContaining({
          start: expect.any(Number),
          end: expect.any(Number),
        }),
      }),
    );
    expect(body.items[0].node).toBeUndefined();
    expect(body.nodes).toBeUndefined();
    expect(JSON.stringify(body).length).toBeLessThan(2_000);
  });

  it("updates and queries runtime resolved heap nodes from durable UI facts", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const appendResult = await appendEventsToBranch(bucket as unknown as R2Bucket, branch, [
      makeEvent(["# UI Runtime", "```form(id=\"approval\")", "```"].join("\n")),
    ]);
    const snapshotId = appendResult.snapshot?.snapshotId ?? appendResult.branch.headSnapshotId;
    const responseFact = {
      version: 1 as const,
      kind: "ui.response" as const,
      id: "response-approval",
      primitiveId: "approval",
      createdAt: 124,
      source: {
        rootDropId,
        branchId: appendResult.branch.branchId,
        snapshotId,
        callId: "call-approval",
      },
      data: { approved: true },
    };
    const statePatchFact = {
      version: 1 as const,
      kind: "ui.state.patch" as const,
      id: "patch-approval",
      callId: "call-approval",
      createdAt: 125,
      source: {
        rootDropId,
        branchId: appendResult.branch.branchId,
        snapshotId,
        callId: "call-approval",
      },
      patch: [{ op: "set" as const, path: ["approved"], value: true }],
    };
    bucket.seed(nullplugUiResponseFactKey(responseFact), JSON.stringify(responseFact));
    bucket.seed(nullplugUiStatePatchFactKey(statePatchFact), JSON.stringify(statePatchFact));

    const update = await onResolvedUpdateRequest({
      request: new Request(
        `https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/update`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", [NULLDOWN_ACCOUNT_ID_HEADER]: accountId },
          body: JSON.stringify({
            resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
            uiPrimitives: [
              {
                kind: "action",
                id: "approve-action",
                label: "Approve",
                source: responseFact.source,
              },
            ],
          }),
        },
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket, ALLOW_INSECURE_ACCOUNT_HEADER: "1" },
      params: { rootId: rootDropId, branchId: branch.branchId },
    } as unknown as Parameters<typeof onResolvedUpdateRequest>[0]);

    const updateBody = (await update.json()) as {
      updated: Array<{ resolverId: string; nodeCount: number }>;
    };
    expect(update.status).toBe(200);
    expect(updateBody.updated[0]).toEqual(
      expect.objectContaining({
        resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
        nodeCount: expect.any(Number),
      }),
    );

    const query = await onResolvedQueryRequest({
      request: new Request(
        `https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/query?resolverId=${encodeURIComponent(
          RESOLVED_RUNTIME_REFS_RESOLVER_ID,
        )}&q=approve&kind=ui.primitive,ui.response,ui.state`,
        { headers: { [NULLDOWN_ACCOUNT_ID_HEADER]: accountId } },
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket, ALLOW_INSECURE_ACCOUNT_HEADER: "1" },
      params: { rootId: rootDropId, branchId: branch.branchId },
    } as unknown as Parameters<typeof onResolvedQueryRequest>[0]);

    const queryBody = (await query.json()) as {
      nodes: Array<{ node: { kind: string; primitiveId?: string; callId?: string } }>;
    };
    expect(query.status).toBe(200);
    expect(queryBody.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ node: expect.objectContaining({ kind: "ui.response" }) }),
        expect.objectContaining({ node: expect.objectContaining({ kind: "ui.primitive" }) }),
        expect.objectContaining({ node: expect.objectContaining({ kind: "ui.state" }) }),
      ]),
    );
  });
});
