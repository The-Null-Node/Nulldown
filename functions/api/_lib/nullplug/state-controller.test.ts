import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../../nullplug/state";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../../../shared/drop/branch";
import {
  nullplugUiRuntimeFactId,
  nullplugUiStatePatchFactKey,
} from "../../../../shared/nullplug/ui";
import { createBranchKey, createCheckpointKey } from "../branches/storage/keys";
import { createBranchRuntimeFactLogRepository } from "../branches/storage/runtime-fact-log";
import { MemoryR2Bucket } from "./testing/storage-fixture";

const rootDropId = "RootDrop1122";
const branchId = "clone_author";
const accountId = "acct-author";
const rootContent = "# Root";
const rootContentHash = `sha256:${createHash("sha256")
  .update(`nulldown.source-content.v1\n${rootContent}`)
  .digest("base64url")}`;

const createStateRequest = (
  body: unknown,
  requestAccountId = accountId,
): Request =>
  new Request("https://nulldown.test/api/nullplug/state", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [NULLDOWN_ACCOUNT_ID_HEADER]: requestAccountId,
    },
    body: JSON.stringify(body),
  });

const createPatchFact = () => ({
  version: 1 as const,
  kind: "ui.state.patch" as const,
  id: "patch-1",
  callId: "call-1",
  createdAt: 123,
  source: {
    rootDropId,
    branchId,
    snapshotId: 4,
    sourceContentHash: rootContentHash,
    callId: "call-1",
  },
  patch: [{ op: "set" as const, path: ["approved"], value: true }],
});

describe("functions api nullplug state contracts", () => {
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
    bucket.seed(rootDropId, JSON.stringify({ content: rootContent }));
    bucket.seed(
      createBranchKey(rootDropId, branchId),
      JSON.stringify({
        version: 1,
        branchId,
        rootDropId,
        baseDropId: rootDropId,
        mode: "clone",
        status: "active",
        ownerAccountId: "acct-owner",
        writerAccountId: accountId,
        writerClientId: "client-1",
        headSnapshotId: 0,
        headEventSeq: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    bucket.seed(
      createCheckpointKey(rootDropId, branchId, 0),
      rootContent,
      "text/plain",
    );
    return bucket;
  };

  it("stores immutable UI state facts", async () => {
    const bucket = createSeededBucket();
    const fact = createPatchFact();

    const response = await onRequest({
      request: createStateRequest(fact),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as {
      stored: boolean;
      key: string;
      fact: typeof fact;
    };

    expect(response.status).toBe(200);
    expect(body.stored).toBe(true);
    expect(body.key).toBe(nullplugUiStatePatchFactKey(fact));
    await expect(
      bucket.get(body.key).then((object) => object?.json()),
    ).resolves.toEqual(body.fact);
  });

  it("repairs duplicate state facts and keeps same ids distinct by call", async () => {
    const bucket = createSeededBucket();
    const fact = createPatchFact();

    await onRequest({
      request: createStateRequest(fact),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    const storedObject = await bucket.get(
      createBranchKey(rootDropId, branchId),
    );
    const storedBranch = (await storedObject?.json()) as
      Record<string, unknown> | undefined;
    bucket.seed(
      createBranchKey(rootDropId, branchId),
      JSON.stringify({ ...storedBranch, status: "archived" }),
    );
    const duplicate = await onRequest({
      request: createStateRequest(fact),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    const duplicateBody = (await duplicate.json()) as {
      duplicate: boolean;
      runtimeFact: { appended: boolean };
    };
    expect(duplicate.status).toBe(200);
    expect(duplicateBody).toMatchObject({
      duplicate: true,
      runtimeFact: expect.objectContaining({ appended: false }),
    });
    const reused = await onRequest({
      request: createStateRequest({
        ...fact,
        patch: [{ op: "set", path: ["approved"], value: false }],
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(reused.status).toBe(409);
    bucket.seed(
      createBranchKey(rootDropId, branchId),
      JSON.stringify({ ...storedBranch, status: "active" }),
    );

    const otherCall = {
      ...fact,
      callId: "call-2",
      source: { ...fact.source, callId: "call-2" },
    };
    const second = await onRequest({
      request: createStateRequest(otherCall),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(second.status).toBe(200);

    const timeline = await createBranchRuntimeFactLogRepository({
      blobs: bucket as any,
    }).pollBranchRuntimeFactsSince(rootDropId, branchId, -1, 10);
    expect(timeline.facts.map((entry) => entry.factId)).toEqual([
      nullplugUiRuntimeFactId(fact),
      nullplugUiRuntimeFactId(otherCall),
    ]);
  });

  it("rejects invalid, stale, and missing-root state facts", async () => {
    const bucket = createSeededBucket();
    const fact = createPatchFact();

    const invalid = await onRequest({
      request: createStateRequest({
        ...fact,
        patch: [{ op: "delete", path: [] }],
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(invalid.status).toBe(400);

    const stale = await onRequest({
      request: createStateRequest({
        ...fact,
        id: "patch-stale-source",
        source: { ...fact.source, sourceContentHash: "sha256:stale" },
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(stale.status).toBe(409);

    const missingRoot = await onRequest({
      request: createStateRequest({
        ...fact,
        id: "patch-missing-root",
        source: {
          rootDropId: "MissingRoot",
          branchId: "clone_anonymous",
          sourceContentHash: rootContentHash,
        },
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(missingRoot.status).toBe(404);
  });

  it("requires an authenticated branch writer", async () => {
    const bucket = createSeededBucket();
    const fact = createPatchFact();
    const unauthenticated = await onRequest({
      request: new Request("https://nulldown.test/api/nullplug/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fact),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ACCOUNT_AUTH_SECRET: "production-secret",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(unauthenticated.status).toBe(401);

    const forbidden = await onRequest({
      request: createStateRequest(fact, "acct-other"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(forbidden.status).toBe(403);
  });
});
