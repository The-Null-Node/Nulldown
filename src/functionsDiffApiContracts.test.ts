import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../functions/api/diff/[id]";
import {
  appendEventsToBranch,
  type BranchAppendObserver,
} from "../functions/api/_lib/branchAppendService";
import { resolveBranchForActor } from "../functions/api/_lib/branchLifecycleService";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

  seed(key: string, value: string, contentType = "application/json"): string {
    const now = Date.now();
    const etag = this.createEtag(`${key}:${value}:${now}`);
    this.objects.set(key, {
      value,
      contentType,
      etag,
      uploaded: new Date(now),
    });
    return etag;
  }

  async get(key: string): Promise<any> {
    const existing = this.objects.get(key);
    if (!existing) {
      return null;
    }

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
    if (!existing) {
      return null;
    }

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
      if (onlyIf.etagDoesNotMatch === "*" && existing) {
        return null;
      }
    }

    if (onlyIf && "etagMatches" in onlyIf) {
      if (!existing || existing.etag !== onlyIf.etagMatches) {
        return null;
      }
    }

    const asText = await this.toText(value);
    const uploaded = new Date();
    const contentType =
      typeof options?.httpMetadata?.contentType === "string"
        ? options.httpMetadata.contentType
        : "text/plain";

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
    startAfter?: string;
  }): Promise<any> {
    const prefix = options?.prefix ?? "";
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 1000));
    const startAfter = options?.startAfter ?? "";
    const startIndex = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;

    const matching = [...this.objects.entries()]
      .map(([key, value]) => ({ key, value }))
      .filter((entry) => entry.key.startsWith(prefix))
      .filter((entry) => (startAfter ? entry.key > startAfter : true))
      .sort((a, b) => a.key.localeCompare(b.key));

    const page = matching.slice(startIndex, startIndex + limit);
    const nextOffset = startIndex + page.length;
    const truncated = nextOffset < matching.length;

    return {
      objects: page.map((entry) => ({
        key: entry.key,
        etag: entry.value.etag,
        httpEtag: entry.value.etag,
        uploaded: entry.value.uploaded,
        size: entry.value.value.length,
        version: "v1",
        checksums: {
          md5: undefined,
          sha1: undefined,
          sha256: undefined,
          sha384: undefined,
          sha512: undefined,
        },
        httpMetadata: { contentType: entry.value.contentType },
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
    if (typeof value === "string") {
      return value;
    }

    if (value === null) {
      return "";
    }

    return await new Response(value as BodyInit).text();
  }
}

const rootDropId = "AaBbCc112233";
const accountId = "acct_1";

const createPostRequest = (events: unknown): Request =>
  new Request(`https://nulldown.test/api/diff/${rootDropId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nulldown-account-id": accountId,
    },
    body: JSON.stringify({ version: 1, events }),
  });

const createPostRequestWithClientHeader = (
  events: unknown,
  clientId: string,
): Request =>
  new Request(`https://nulldown.test/api/diff/${rootDropId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nulldown-account-id": accountId,
      "x-nulldown-client-id": clientId,
    },
    body: JSON.stringify({ version: 1, events }),
  });

const createPostRequestWithPartialProviderHeaders = (
  events: unknown,
  clientId: string,
): Request =>
  new Request(`https://nulldown.test/api/diff/${rootDropId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nulldown-account-id": accountId,
      "x-nulldown-client-id": clientId,
      "x-nulldown-timestamp": String(Date.now()),
    },
    body: JSON.stringify({ version: 1, events }),
  });

const createGetRequest = (query = ""): Request =>
  new Request(`https://nulldown.test/api/diff/${rootDropId}${query}`, {
    method: "GET",
    headers: {
      "x-nulldown-account-id": accountId,
    },
  });

const makeEvent = (input: {
  eventId: string;
  sourceClientId: string;
  text: string;
  createdAt: number;
  metadata?: unknown;
}) => ({
  eventId: input.eventId,
  seq: 0,
  dropId: rootDropId,
  sourceClientId: input.sourceClientId,
  createdAt: input.createdAt,
  ops: [
    {
      type: "insert" as const,
      start: 0,
      end: 0,
      text: input.text,
    },
  ],
  ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
});

describe("functions api diff contracts", () => {
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

  const createSeededBucket = (): MemoryR2Bucket => {
    const bucket = new MemoryR2Bucket();
    bucket.seed(
      rootDropId,
      JSON.stringify({
        content: "",
        metadata: {
          ownerAccountId: accountId,
        },
      }),
      "application/json",
    );
    return bucket;
  };

  it("deduplicates repeat event ids across writes", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-1",
      sourceClientId: "writer-a",
      text: "hello",
      createdAt: 100,
    });

    const first = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const firstBody = (await first.json()) as {
      accepted: number;
      totalStored: number;
    };

    const second = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const secondBody = (await second.json()) as {
      accepted: number;
      totalStored: number;
    };

    expect(first.status).toBe(200);
    expect(firstBody.accepted).toBe(1);
    expect(firstBody.totalStored).toBe(1);

    expect(second.status).toBe(200);
    expect(secondBody.accepted).toBe(0);
    expect(secondBody.totalStored).toBe(1);
  });

  it("returns filtered diff pages with cursor", async () => {
    const bucket = createSeededBucket();
    const eventA = makeEvent({
      eventId: "evt-a",
      sourceClientId: "writer-a",
      text: "A",
      createdAt: 101,
    });
    const eventB = makeEvent({
      eventId: "evt-b",
      sourceClientId: "writer-b",
      text: "B",
      createdAt: 102,
    });

    const post = await onRequest({
      request: createPostRequest([eventA, eventB]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(post.status).toBe(200);

    const latest = await onRequest({
      request: createGetRequest("?cursor=__latest__"),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const latestBody = (await latest.json()) as {
      cursor: string | null;
      events: unknown[];
    };
    expect(latest.status).toBe(200);
    expect(latestBody.events).toHaveLength(0);
    expect(latestBody.cursor).toBe("1");

    const poll = await onRequest({
      request: createGetRequest("?cursor=-1&excludeClient=writer-a&limit=10"),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const pollBody = (await poll.json()) as {
      cursor: string | null;
      events: Array<{ sourceClientId: string; eventId: string; seq: number }>;
    };

    expect(poll.status).toBe(200);
    expect(pollBody.events).toHaveLength(1);
    expect(pollBody.events[0].sourceClientId).toBe("writer-b");
    expect(pollBody.events[0].eventId).toBe("evt-b");
    expect(pollBody.cursor).toBe("1");
  });

  it("preserves event metadata through append and poll", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-metadata",
      sourceClientId: "writer-meta",
      text: "M",
      createdAt: 105,
      metadata: {
        kind: "nullplug.invoke",
        intent: "embed child plan",
        pluginId: "nd",
        args: {
          id: "child123",
          mode: "card",
        },
        labels: ["plan", "nullplug"],
        confidence: 0.9,
      },
    });

    const post = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(post.status).toBe(200);

    const poll = await onRequest({
      request: createGetRequest("?cursor=-1&limit=10"),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const pollBody = (await poll.json()) as {
      events: Array<{ metadata?: unknown }>;
    };

    expect(poll.status).toBe(200);
    expect(pollBody.events).toHaveLength(1);
    expect(pollBody.events[0].metadata).toEqual({
      kind: "nullplug.invoke",
      intent: "embed child plan",
      pluginId: "nd",
      args: {
        id: "child123",
        mode: "card",
      },
      labels: ["plan", "nullplug"],
      confidence: 0.9,
    });
  });

  it("rejects invalid diff event metadata", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-invalid-metadata",
      sourceClientId: "writer-invalid-meta",
      text: "X",
      createdAt: 106,
      metadata: {
        kind: "invalid.kind",
      },
    });

    const response = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as { code?: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_failed");
  });

  it("accepts plain client id header without provider signature", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-client-only",
      sourceClientId: "writer-c",
      text: "C",
      createdAt: 103,
    });

    const response = await onRequest({
      request: createPostRequestWithClientHeader([event], "client-only-header"),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(200);
  });

  it("ignores partial provider auth headers for normal diff writes", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-partial-provider",
      sourceClientId: "writer-d",
      text: "D",
      createdAt: 104,
    });

    const response = await onRequest({
      request: createPostRequestWithPartialProviderHeaders(
        [event],
        "client-partial-provider",
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(200);
  });

  it("runs branch append observers after accepted writes", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-observed",
      sourceClientId: "writer-observed",
      text: "O",
      createdAt: 107,
    });
    const calls: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];
    const observer: BranchAppendObserver = {
      id: "observer-1",
      onDiffAccepted(observedEvent, context) {
        calls.push(
          `event:${observedEvent.eventId}:${observedEvent.seq}:${context.branch.headSnapshotId}`,
        );
      },
      onSnapshotCreated(snapshot, context) {
        calls.push(
          `snapshot:${snapshot.snapshotId}:${context.acceptedEvents.length}:${context.totalStored}`,
        );
      },
    };

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        observers: [observer],
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    expect(appended.snapshot?.snapshotId).toBe(1);
    expect(waitUntilPromises).toHaveLength(1);
    await waitUntilPromises[0];
    expect(calls).toEqual(["event:evt-observed:0:1", "snapshot:1:1:1"]);
  });

  it("isolates branch append observer failures", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-observer-error",
      sourceClientId: "writer-observer-error",
      text: "E",
      createdAt: 108,
    });
    const errors: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        observers: [
          {
            id: "bad-observer",
            onDiffAccepted() {
              throw new Error("observer failed");
            },
          },
        ],
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
        onObserverError: (_error, observerId) => {
          errors.push(observerId);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    await waitUntilPromises[0];
    expect(errors).toEqual(["bad-observer"]);
  });
});
