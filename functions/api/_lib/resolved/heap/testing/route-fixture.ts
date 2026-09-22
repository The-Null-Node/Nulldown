import { createHash } from "node:crypto";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest as onResolvedQueryRequest } from "../../../../branches/[rootId]/[branchId]/resolved/query";
import { appendEventsToBranch } from "../../../nulledit/service";
import { resolveBranchForActor } from "../../../branches/lifecycle";
import { createSnapshotKey } from "../../../branches/storage/keys";
import type { DropDiffEvent } from "../../../../../../shared/drop/diff";
import { heapifyResolvedDocument } from "../../../../../../shared/drop/resolved/heapify/document";
import { writeResolvedNulldownState } from "../../../../../../shared/drop/resolved/storage";

export interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

export class MemoryR2Bucket {
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
      string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null,
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

  async list(options?: {
    limit?: number;
    prefix?: string;
    cursor?: string;
  }): Promise<any> {
    const prefix = options?.prefix ?? "";
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 1000));
    const startIndex = options?.cursor
      ? Number.parseInt(options.cursor, 10)
      : 0;
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
      string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null,
  ): Promise<string> {
    if (typeof value === "string") return value;
    if (value === null) return "";
    return await new Response(value as BodyInit).text();
  }
}

export const rootDropId = "ResolvedRoot1122";
export const accountId = "acct_1";

export const createSeededBucket = (): MemoryR2Bucket => {
  const bucket = new MemoryR2Bucket();
  bucket.seed(
    rootDropId,
    JSON.stringify({ content: "", metadata: { ownerAccountId: accountId } }),
  );
  return bucket;
};

export const makeEvent = (text: string): DropDiffEvent => ({
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

export const documentFixture = async () => {
  const bucket = createSeededBucket();
  const blobs = bucket as unknown as R2Bucket;
  const { branch } = await resolveBranchForActor(
    blobs,
    rootDropId,
    accountId,
    null,
  );
  const result = await appendEventsToBranch(blobs, branch, [
    makeEvent("# Authoritative content"),
  ]);
  const state = await heapifyResolvedDocument({
    rootDropId,
    branchId: branch.branchId,
    snapshotId: 1,
    content: result.content,
  });
  const projectionKey = await writeResolvedNulldownState(blobs, state);
  const query = (snapshotId = 1) =>
    onResolvedQueryRequest({
      request: new Request(
        `https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/query?snapshotId=${snapshotId}`,
      ),
      env: { R2_BUCKET: blobs },
      params: { rootId: rootDropId, branchId: branch.branchId },
    } as unknown as Parameters<typeof onResolvedQueryRequest>[0]);
  return {
    bucket,
    blobs,
    branch,
    result,
    state,
    projectionKey,
    query,
    snapshotKey: createSnapshotKey(rootDropId, branch.branchId, 1),
  };
};
