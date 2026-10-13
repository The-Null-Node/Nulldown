import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../../../diff/[id]";
import { resolveBranchForActor } from "../../branches/lifecycle";
import { createDiffCredentialRepository } from "./repository";
import {
  buildDiffSigningPayload,
  DIFF_CLIENT_ID_HEADER,
  DIFF_SECRET_KID_HEADER,
  DIFF_SIGNATURE_HEADER,
  DIFF_TIMESTAMP_HEADER,
} from "../../../../../shared/drop/diff-auth";
import {
  accountId,
  createPostRequest,
  createPostRequestForBranch,
  createPostRequestWithClientHeader,
  createPostRequestWithPartialProviderHeaders,
  createSeededBucket,
  makeEvent,
  rootDropId,
} from "../testing/storage-fixture";

describe("diff request authentication contracts", () => {
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

  it.each(["owner", "missing"])(
    "rejects a signed credential/query conflict targeting %s before any branch write",
    async (target) => {
      const bucket = createSeededBucket();
      await createDiffCredentialRepository({
        blobs: bucket,
      }).putDiffAuthCredential({
        version: 1,
        dropId: rootDropId,
        branchId: "credential-branch",
        clientId: "signed-client",
        kid: "test-key",
        secret: "test-secret",
        createdAt: Date.now(),
        expiresAt: null,
      });
      const original = createPostRequest([
        makeEvent({
          eventId: "conflicting-target",
          sourceClientId: "signed-client",
          text: "wrong",
          createdAt: 1,
        }),
      ]);
      const body = await original.text();
      const timestamp = String(Date.now());
      const url = new URL(original.url);
      url.searchParams.set("branchId", target);
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("test-secret"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          buildDiffSigningPayload("POST", url.pathname, timestamp, body),
        ),
      );
      const headers = new Headers(original.headers);
      headers.set(DIFF_CLIENT_ID_HEADER, "signed-client");
      headers.set(DIFF_SECRET_KID_HEADER, "test-key");
      headers.set(DIFF_TIMESTAMP_HEADER, timestamp);
      headers.set(
        DIFF_SIGNATURE_HEADER,
        `sha256=${Buffer.from(signature).toString("hex")}`,
      );
      const before = await bucket.list({});
      const response = await onRequest({
        request: new Request(url, { method: "POST", headers, body }),
        env: { R2_BUCKET: bucket as unknown as R2Bucket },
        params: { id: rootDropId },
      } as unknown as Parameters<typeof onRequest>[0]);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "branch_target_mismatch",
      });
      const identity = ({ key, etag }: { key: string; etag: string }) => ({
        key,
        etag,
      });
      expect((await bucket.list({})).objects.map(identity)).toEqual(
        before.objects.map(identity),
      );
    },
  );

  it("rejects an account session write to another account's existing branch", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      "owner-client",
    );
    const response = await onRequest({
      request: createPostRequestForBranch(
        [
          makeEvent({
            eventId: "evt-forbidden-branch-write",
            sourceClientId: "other-client",
            text: "forbidden",
            createdAt: 105,
          }),
        ],
        branch.branchId,
        "acct_other",
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "You are not allowed to write to this branch.",
      code: "branch_write_forbidden",
    });
  });

  it("does not let an insecure account header bypass configured webhook auth", async () => {
    const bucket = createSeededBucket();
    const response = await onRequest({
      request: createPostRequest([
        makeEvent({
          eventId: "evt-webhook-auth-required",
          sourceClientId: "writer-webhook-auth-required",
          text: "blocked",
          createdAt: 106,
        }),
      ]),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DIFF_WEBHOOK_SECRET: "webhook-secret",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(401);
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
});
