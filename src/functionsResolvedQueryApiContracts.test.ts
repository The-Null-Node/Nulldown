import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest as onResolvedQueryRequest } from "../functions/api/branches/[rootId]/[branchId]/resolved/query";
import { onRequest as onResolvedUpdateRequest } from "../functions/api/branches/[rootId]/[branchId]/resolved/update";
import { appendEventsToBranch } from "../functions/api/_lib/branchAppendService";
import { resolveBranchForActor } from "../functions/api/_lib/branchLifecycleService";
import type { DropDiffEvent } from "../shared/drop/diff";
import { RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../shared/drop/resolved";
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
          headers: { "Content-Type": "application/json" },
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
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
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
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
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
