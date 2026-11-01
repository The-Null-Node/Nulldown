import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { onRequest as state } from "../../nullplug/state";
import { onRequest as submit } from "../../nullplug/submit";
import { onRequest as resolve } from "../../nullplug/resolve";
import { onRequest as memoryQuery } from "../../branches/[rootId]/[branchId]/memory/query";
import { onRequest as memoryFact } from "../../branches/[rootId]/[branchId]/memory/facts";
import { onRequest as memoryProcedure } from "../../branches/[rootId]/[branchId]/memory/procedures";
import { onRequest as memoryDelete } from "../../branches/[rootId]/[branchId]/memory/[recordId]";
import { onRequest as resolvedQuery } from "../../branches/[rootId]/[branchId]/resolved/query";
import { onRequest as resolvedUpdate } from "../../branches/[rootId]/[branchId]/resolved/update";
import { onRequest as priority } from "../../branches/[rootId]/[branchId]/resolved/priority";
import { onRequest as priorityDelete } from "../../branches/[rootId]/[branchId]/resolved/priority/[factId]";
import { onRequest as branchBackfill } from "../../branches/backfill/[id]";
import { onRequest as metadataBackfill } from "../../metadata/backfill";
import { issueAccountSessionToken } from "../accounts/session/token";
import { createStoreDatabase } from "../drops/testing/storage-fixture";
import { createRemoteAliasKey } from "../drops/identity/id";
import {
  documentFixture,
  rootDropId,
  accountId,
} from "../resolved/heap/testing/route-fixture";
import type { BranchBatchStatePlane } from "../../../../shared/drop/branch-state";
import { hashMarkdownSource } from "../../../../shared/drop/resolved/hash";

const shortId = rootDropId.slice(0, 6);
const base = `/api/branches/${shortId}/owner`;
const secret = "local-capability-guard-account-secret";
const maintenanceToken = "local-capability-guard-maintenance-token";
const source = { rootDropId: shortId, branchId: "owner", snapshotId: 1 };

const routes = [
  {
    name: "nullplug state",
    handler: state,
    method: "POST",
    path: "/api/nullplug/state",
    body: {
      version: 1,
      kind: "ui.state.patch",
      id: "patch",
      callId: "call",
      createdAt: 1,
      source,
      patch: [{ op: "set", path: ["approved"], value: true }],
    },
  },
  {
    name: "nullplug submit",
    handler: submit,
    method: "POST",
    path: "/api/nullplug/submit",
    body: {
      version: 1,
      kind: "ui.response",
      id: "response",
      primitiveId: "approval",
      createdAt: 1,
      source,
      data: { approved: true },
    },
  },
  {
    name: "nullplug resolve",
    handler: resolve,
    method: "POST",
    path: "/api/nullplug/resolve",
    body: {
      call: {
        pluginId: "nd",
        args: { id: rootDropId },
        caller: { dropId: shortId, branchId: "owner" },
      },
      context: {
        providerId: "nulldown-provider",
        baseUrl: "https://nulldown.test",
        capabilities: ["render", "drop.read"],
      },
    },
  },
  {
    name: "memory query",
    handler: memoryQuery,
    method: "GET",
    path: `${base}/memory/query?includeFreshness=true`,
  },
  {
    name: "memory fact",
    handler: memoryFact,
    method: "POST",
    path: `${base}/memory/facts`,
    body: { text: "memory" },
  },
  {
    name: "memory procedure",
    handler: memoryProcedure,
    method: "POST",
    path: `${base}/memory/procedures`,
    body: { goal: "goal", summary: "summary", steps: [] },
  },
  {
    name: "memory delete",
    handler: memoryDelete,
    method: "DELETE",
    path: `${base}/memory/record`,
  },
  {
    name: "resolved latest repair",
    handler: resolvedQuery,
    method: "GET",
    path: `${base}/resolved/query`,
  },
  {
    name: "resolved explicit snapshot",
    handler: resolvedQuery,
    method: "GET",
    path: `${base}/resolved/query?snapshotId=1`,
  },
  {
    name: "resolved runtime projection",
    handler: resolvedQuery,
    method: "GET",
    path: `${base}/resolved/query?resolverId=nulldown.resolved.runtime-refs`,
  },
  {
    name: "resolved snapshotter",
    handler: resolvedQuery,
    method: "GET",
    path: `${base}/resolved/query?snapshotterId=nulledit.nullmem-freshness`,
  },
  {
    name: "resolved update",
    handler: resolvedUpdate,
    method: "POST",
    path: `${base}/resolved/update`,
    body: { snapshotId: "latest" },
  },
  {
    name: "priority read",
    handler: priority,
    method: "GET",
    path: `${base}/resolved/priority`,
  },
  {
    name: "priority write",
    handler: priority,
    method: "POST",
    path: `${base}/resolved/priority`,
    body: { targetKind: "heap", priority: 1 },
  },
  {
    name: "priority delete",
    handler: priorityDelete,
    method: "DELETE",
    path: `${base}/resolved/priority/fact`,
  },
  {
    name: "branch backfill",
    handler: branchBackfill,
    method: "POST",
    path: `/api/branches/backfill/${shortId}`,
    maintenance: true,
  },
  {
    name: "metadata backfill",
    handler: metadataBackfill,
    method: "POST",
    path: "/api/metadata/backfill",
    maintenance: true,
  },
  {
    name: "metadata account-library backfill",
    handler: metadataBackfill,
    method: "POST",
    path: "/api/metadata/backfill?mode=account-library",
    maintenance: true,
  },
] as const;

const fixture = async () => {
  // Real legacy lifecycle + append + projection: these are not clean DO-only 404 cases.
  const legacy = await documentFixture();
  legacy.bucket.seed(createRemoteAliasKey(shortId), rootDropId, "text/plain");
  const db = createStoreDatabase({
    entry: {
      entry_seq: 1,
      drop_id: rootDropId,
      account_id: accountId,
      visibility: "public",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    },
  });
  const commits = {
    append: jest.fn<BranchBatchStatePlane["append"]>(),
    appendBatch: jest.fn<BranchBatchStatePlane["appendBatch"]>(),
    readHead: jest.fn<BranchBatchStatePlane["readHead"]>(),
    readContent: jest.fn<BranchBatchStatePlane["readContent"]>(),
    readEvents: jest.fn<BranchBatchStatePlane["readEvents"]>(),
  };
  const env = {
    R2_BUCKET: legacy.blobs,
    DB: db,
    ACCOUNT_AUTH_SECRET: secret,
    METADATA_BACKFILL_TOKEN: maintenanceToken,
    BRANCH_HEAP_BACKFILL_TOKEN: maintenanceToken,
    localBranchApplication: {
      mode: "local-test" as const,
      commits,
      placement: { routingVersion: 1, generation: 1 },
    },
  };
  const { token } = await issueAccountSessionToken(accountId, {
    ACCOUNT_AUTH_SECRET: secret,
  });
  const failStorage = () => {
    throw new Error("legacy storage must not be accessed");
  };
  const storage = [
    jest.spyOn(legacy.bucket, "get").mockImplementation(failStorage),
    jest.spyOn(legacy.bucket, "head").mockImplementation(failStorage),
    jest.spyOn(legacy.bucket, "list").mockImplementation(failStorage),
    jest.spyOn(legacy.bucket, "put").mockImplementation(failStorage),
    jest.spyOn(legacy.bucket, "delete").mockImplementation(failStorage),
    jest.spyOn(db, "prepare").mockImplementation(failStorage),
  ];
  const call = async (
    route: (typeof routes)[number],
    authorization = `Bearer ${"maintenance" in route ? maintenanceToken : token}`,
    bindings: unknown = env,
  ) => {
    const body = "body" in route ? route.body : undefined;
    const payload =
      body && "source" in body
        ? {
            ...body,
            source: {
              ...body.source,
              sourceContentHash: await hashMarkdownSource(
                legacy.result.content,
              ),
            },
          }
        : body;
    return await (route.handler as typeof resolvedQuery)({
      env: bindings,
      params: {
        rootId: shortId,
        branchId: "owner",
        id: shortId,
        recordId: "record",
        factId: "fact",
      },
      request: new Request(`https://nulldown.test${route.path}`, {
        method: route.method,
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          "Content-Type": "application/json",
          "x-request-id": "local-capability-guard-test",
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      }),
    } as unknown as Parameters<typeof resolvedQuery>[0]);
  };
  return {
    env,
    call,
    storage,
    expectNoStorageAccess: () => {
      for (const spy of [...storage, ...Object.values(commits)])
        expect(spy).not.toHaveBeenCalled();
    },
  };
};

describe("selected local unsupported capabilities through actual Pages handlers", () => {
  beforeEach(() => {
    for (const method of ["info", "warn", "error", "debug"] as const)
      jest.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(routes)(
    "$name rejects before existing legacy state can be read or mutated",
    async (route) => {
      const f = await fixture();
      const response = await f.call(route);
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({
        code: "capability_unsupported",
      });
      f.expectNoStorageAccess();
    },
  );

  it.each(routes.filter((route) => route.method !== "GET"))(
    "$name retains authentication before rejecting unsupported capability",
    async (route) => {
      const f = await fixture();
      for (const authorization of ["", "Bearer invalid"]) {
        const response = await f.call(route, authorization);
        expect(response.status).toBe(401);
      }
      f.expectNoStorageAccess();
    },
  );

  it.each(
    routes.filter(
      (route) =>
        route.name.startsWith("memory") || route.name.startsWith("priority"),
    ),
  )(
    "$name rejects unsupported capability even without legacy SQL binding",
    async (route) => {
      const f = await fixture();
      const response = await f.call(route, undefined, {
        ...f.env,
        DB: undefined,
      });
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({
        code: "capability_unsupported",
      });
      f.expectNoStorageAccess();
    },
  );

  it.each([
    "resolved latest repair",
    "resolved explicit snapshot",
    "resolved update",
  ])(
    "%s still uses the existing legacy path without selection",
    async (name) => {
      const f = await fixture();
      for (const spy of f.storage) spy.mockRestore();
      const route = routes.find((route) => route.name === name)!;
      const response = await f.call(route, undefined, {
        ...f.env,
        localBranchApplication: undefined,
        DB: undefined,
      });
      expect(response.status).toBe(200);
    },
  );
});
