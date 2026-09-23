import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../../../diff/[id]";
import { resolveBranchForActor } from "../../branches/lifecycle";
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
