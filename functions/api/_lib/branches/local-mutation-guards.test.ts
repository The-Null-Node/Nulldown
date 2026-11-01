import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { BranchBatchStatePlane } from "../../../../shared/drop/branch-state";
import { hashNulldownSourceContent } from "../../../../shared/drop/resolved/hash";
import { onRequest as store } from "../../store";
import { onRequest as publish } from "../../branches/[rootId]/[branchId]/publish";
import { onRequest as promote } from "../../branches/[rootId]/[branchId]/promote";
import { onRequest as content } from "../../branches/[rootId]/[branchId]/content";
import { onRequest as remove } from "../../delete/[id]";
import { onRequestPost as register } from "../../diff-auth/register/[id]";
import { MemoryR2Bucket } from "../diffs/testing/storage-fixture";
import {
  createDeleteRequest,
  createEnvelope,
  createSignedOwnerEnvelope,
  createStoreDatabase,
  createStoreRequest,
} from "../drops/testing/storage-fixture";

const rootId = "GuardRoot123456";
const accountId = "guard-owner";
const params = { rootId, branchId: "owner" };

describe("local credential registration guard", () => {
  it.each([true, false])(
    "does not resolve a legacy branch while local authority is selected (authenticated=%s)",
    async (authenticated) => {
      const f = await fixture();
      const response = await register({
        env: f.env,
        params: { id: rootId },
        request: new Request(
          `https://nulldown.test/api/diff-auth/register/${rootId}`,
          {
            method: "POST",
            headers: authenticated
              ? { "x-nulldown-account-id": accountId }
              : {},
            body: JSON.stringify({
              clientId: "client",
              requesterPublicJwk: {},
            }),
          },
        ),
      } as unknown as Parameters<typeof register>[0]);
      expect(response.status).toBe(authenticated ? 501 : 401);
      f.expectNoStorageAccess();
    },
  );
});

const fixture = async () => {
  const bucket = new MemoryR2Bucket();
  const original = JSON.stringify({
    content: "root before local edits",
    metadata: { ownerAccountId: accountId },
  });
  const revision = bucket.seed(rootId, original);
  const db = createStoreDatabase({
    entry: {
      entry_seq: 1,
      drop_id: rootId,
      account_id: accountId,
      visibility: "private",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    },
  });
  const placement = { routingVersion: 1, generation: 7 };
  const commits = {
    append: jest.fn<BranchBatchStatePlane["append"]>(),
    appendBatch: jest.fn<BranchBatchStatePlane["appendBatch"]>(),
    readHead: jest.fn<BranchBatchStatePlane["readHead"]>().mockResolvedValue({
      target: { rootDropId: rootId, branchId: "owner" },
      placement,
      version: {
        snapshotId: 1,
        eventSeq: 0,
        sourceContentHash: await hashNulldownSourceContent("local edits"),
      },
      branch: {
        version: 1,
        rootDropId: rootId,
        baseDropId: rootId,
        branchId: "owner",
        mode: "owner",
        status: "active",
        ownerAccountId: accountId,
        writerAccountId: accountId,
        writerClientId: null,
        headSnapshotId: 1,
        headEventSeq: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    }),
    readContent: jest
      .fn<BranchBatchStatePlane["readContent"]>()
      .mockImplementation(async (query) => ({
        ...query,
        content: "local edits",
      })),
    readEvents: jest.fn<BranchBatchStatePlane["readEvents"]>(),
  };
  const env = {
    R2_BUCKET: bucket,
    DB: db,
    PUBLIC_BASE_URL: "https://nulldown.test",
    ALLOW_INSECURE_ACCOUNT_HEADER: "1",
    localBranchApplication: { mode: "local-test" as const, commits, placement },
  };
  const reads = [
    jest.spyOn(bucket, "get"),
    jest.spyOn(bucket, "head"),
    jest.spyOn(bucket, "list"),
  ];
  const writes = [jest.spyOn(bucket, "put"), jest.spyOn(bucket, "delete")];
  const sql = jest.spyOn(db, "prepare");
  const expectNoStorageAccess = () => {
    for (const spy of [...reads, ...writes, sql])
      expect(spy).not.toHaveBeenCalled();
    for (const spy of Object.values(commits))
      expect(spy).not.toHaveBeenCalled();
  };
  return { env, bucket, revision, original, commits, expectNoStorageAccess };
};

const mutationRequest = (
  operation: "publish" | "promote",
  revision: string,
  actor: string | null = accountId,
  bearer?: string,
) =>
  new Request(
    `https://nulldown.test/api/branches/${rootId}/owner/${operation}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(actor ? { "x-nulldown-account-id": actor } : {}),
        ...(bearer ? { Authorization: bearer } : {}),
      },
      body: JSON.stringify({
        expectedSnapshotId: 1,
        ...(operation === "publish" ? { expectedRevision: revision } : {}),
        idempotencyKey: "local-guard-retry",
      }),
    },
  );

const expectUnsupported = async (response: Response) => {
  expect(response.status).toBe(501);
  await expect(response.json()).resolves.toMatchObject({
    code: "capability_unsupported",
  });
};

describe("selected local authority root-mutation guards through Pages", () => {
  beforeEach(() => {
    for (const method of ["info", "warn", "error", "debug"] as const)
      jest.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([rootId, "AbsentRoot123456", undefined])(
    "rejects upsert target %s before any root lease, metadata or branch access",
    async (id) => {
      const f = await fixture();
      const response = await store({
        env: f.env,
        request: createStoreRequest({
          id,
          upsert: true,
          expectedRevision: f.revision,
          envelope: { content: "replacement" },
        }),
      } as unknown as Parameters<typeof store>[0]);
      await expectUnsupported(response);
      f.expectNoStorageAccess();
    },
  );

  it("permits create-only roots but cannot overwrite an existing root", async () => {
    const f = await fixture();
    const invoke = (id: string) =>
      store({
        env: f.env,
        request: createStoreRequest({
          id,
          upsert: false,
          envelope: { content: "new root" },
        }),
      } as unknown as Parameters<typeof store>[0]);
    expect((await invoke("FreshGuard123456")).status).toBe(200);
    const collision = await invoke(rootId);
    expect(collision.status).toBe(409);
    await expect(collision.json()).resolves.toMatchObject({
      code: "object_conflict",
    });
    expect(await (await f.bucket.get(rootId)).text()).toBe(f.original);
  });

  it("retains authenticated-envelope requirements for local root creation", async () => {
    const f = await fixture();
    const response = await store({
      env: f.env,
      request: createStoreRequest({
        id: "PrivateGuard123456",
        upsert: false,
        envelope: createEnvelope(accountId),
      }),
    } as unknown as Parameters<typeof store>[0]);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "account_auth_required",
    });
    f.expectNoStorageAccess();
  });

  it("keeps nonselected legacy upserts available", async () => {
    const f = await fixture();
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);
    const response = await store({
      env: {
        ...f.env,
        localBranchApplication: undefined,
        DB: createStoreDatabase({
          entry: {
            entry_seq: 1,
            drop_id: rootId,
            account_id: accountId,
            visibility: "private",
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          },
          accounts: new Map([
            [
              accountId,
              {
                account_id: accountId,
                signing_public_jwk: JSON.stringify(signingPublicJwk),
                created_at: 1,
                updated_at: 1,
              },
            ],
          ]),
        }),
      },
      request: createStoreRequest(
        { id: rootId, upsert: true, expectedRevision: f.revision, envelope },
        accountId,
      ),
    } as unknown as Parameters<typeof store>[0]);
    expect(response.status).toBe(200);
    expect(await (await f.bucket.get(rootId)).text()).not.toBe(f.original);
  });

  for (const [operation, handler] of [
    ["publish", publish],
    ["promote", promote],
  ] as const) {
    it(`rejects ${operation} and retry before any legacy branch, receipt, lease or root access`, async () => {
      const f = await fixture();
      for (let attempt = 0; attempt < 2; attempt++) {
        await expectUnsupported(
          await handler({
            env: f.env,
            params,
            request: mutationRequest(operation, f.revision),
          } as unknown as Parameters<typeof handler>[0]),
        );
      }
      f.expectNoStorageAccess();
    });

    it.each(["anonymous", "invalid bearer", "untrusted header"])(
      `${operation} retains authentication for %s`,
      async (scenario) => {
        const f = await fixture();
        const response = await handler({
          env: {
            ...f.env,
            ALLOW_INSECURE_ACCOUNT_HEADER:
              scenario === "untrusted header" ? "0" : "1",
          },
          params,
          request: mutationRequest(
            operation,
            f.revision,
            scenario === "anonymous" ? null : accountId,
            scenario === "invalid bearer" ? "Bearer invalid" : undefined,
          ),
        } as unknown as Parameters<typeof handler>[0]);
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
          code: "account_required",
        });
        f.expectNoStorageAccess();
      },
    );
  }

  it("uses the same selected root for content and rejects every unsupported mutation", async () => {
    const f = await fixture();
    const response = await content({
      env: f.env,
      params,
      request: new Request(
        `https://nulldown.test/api/branches/${rootId}/owner/content`,
        {
          headers: { "x-nulldown-account-id": accountId },
        },
      ),
    } as unknown as Parameters<typeof content>[0]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rootDropId: rootId,
      snapshotId: 1,
      content: "local edits",
    });
    expect(f.commits.readHead).toHaveBeenCalledWith({
      target: { rootDropId: rootId, branchId: "owner" },
      placement: f.env.localBranchApplication.placement,
    });
    jest.clearAllMocks();
    await expectUnsupported(
      await store({
        env: f.env,
        request: createStoreRequest({
          id: rootId,
          upsert: true,
          envelope: { content: "replacement" },
        }),
      } as unknown as Parameters<typeof store>[0]),
    );
    for (const [operation, handler] of [
      ["publish", publish],
      ["promote", promote],
    ] as const)
      await expectUnsupported(
        await handler({
          env: f.env,
          params,
          request: mutationRequest(operation, f.revision),
        } as unknown as Parameters<typeof handler>[0]),
      );
    f.expectNoStorageAccess();
  });

  it("rejects selected-root deletion before taking a lease or tombstoning ownership", async () => {
    const f = await fixture();
    const response = await remove({
      env: f.env,
      params: { id: rootId },
      request: createDeleteRequest(rootId, f.revision, accountId),
    } as unknown as Parameters<typeof remove>[0]);
    await expectUnsupported(response);
    f.expectNoStorageAccess();
  });

  it("retains authentication before selected-root deletion rejection", async () => {
    const f = await fixture();
    const response = await remove({
      env: f.env,
      params: { id: rootId },
      request: createDeleteRequest(rootId, f.revision),
    } as unknown as Parameters<typeof remove>[0]);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "account_auth_required",
    });
    f.expectNoStorageAccess();
  });

  it("keeps authenticated nonselected legacy deletion available", async () => {
    const f = await fixture();
    const response = await remove({
      env: { ...f.env, localBranchApplication: undefined },
      params: { id: rootId },
      request: createDeleteRequest(rootId, f.revision, accountId),
    } as unknown as Parameters<typeof remove>[0]);
    expect(response.status).toBe(204);
    expect(await f.bucket.get(rootId)).toBeNull();
  });
});
