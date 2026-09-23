import { jest } from "@jest/globals";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../../../diff/[id]";
import { createBranchRuntimeFactLogRepository } from "../../branches/storage/runtime-fact-log";
import { createBranchKey } from "../../branches/storage/keys";
import { resolveBranchForActor } from "../../branches/lifecycle";
import { createRemoteAliasKey } from "../../drops/identity/id";
import {
  accountId,
  createGetRequest,
  createSeededBucket,
  makeEvent,
  MemoryD1Database,
  rootDropId,
} from "../testing/storage-fixture";

describe("diff read authorization contracts", () => {
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

  it("enforces projected root reads before diff and fact repository access", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const { branch: resolvedOwner } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );
    const ownerBranch = { ...resolvedOwner, headEventSeq: 0 };
    bucket.seed(
      createBranchKey(rootDropId, ownerBranch.branchId),
      JSON.stringify(ownerBranch),
    );
    db.seedBranchEvent(rootDropId, ownerBranch.branchId, {
      ...makeEvent({
        eventId: "evt-private-owner",
        sourceClientId: "writer-owner",
        text: "owner",
        createdAt: 201,
      }),
      snapshotId: 1,
    });
    const setProjection = (
      visibility: unknown,
      deletedAt: number | null = null,
    ) => {
      db.accountLibraryEntries.set(rootDropId, {
        entry_seq: 1,
        drop_id: rootDropId,
        account_id: accountId,
        visibility,
        created_at: 1,
        updated_at: 1,
        deleted_at: deletedAt,
      });
    };
    const call = async (
      query: string,
      requestAccountId?: string,
      includeDevelopmentAuth = false,
    ) => {
      const headers = new Headers();
      if (requestAccountId) {
        headers.set("x-nulldown-account-id", requestAccountId);
      }
      return onRequest({
        request: new Request(
          `https://nulldown.test/api/diff/${rootDropId}${query}`,
          { headers },
        ),
        env: {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: db as unknown as D1Database,
          ACCOUNT_AUTH_SECRET: "test-secret",
          ...(includeDevelopmentAuth
            ? { ALLOW_INSECURE_ACCOUNT_HEADER: "1" }
            : {}),
        },
        params: { id: rootDropId },
      } as unknown as Parameters<typeof onRequest>[0]);
    };
    const expectNoDiffOrFactReads = () => {
      expect(bucket.listCalls).toEqual([]);
      expect(
        bucket.getCalls.filter(
          (key) =>
            key.startsWith("__drop_branch_diffs__/") ||
            key.startsWith("__drop_branch_diff_events__/") ||
            key.startsWith("__drop_branch_runtime_fact_events__/"),
        ),
      ).toEqual([]);
    };

    setProjection("private");
    for (const [query, requestAccountId, developmentAuth] of [
      ["?cursor=__latest__", undefined, false],
      [
        `?cursor=-1&branchId=${encodeURIComponent(ownerBranch.branchId)}`,
        "account-unrelated",
        true,
      ],
      [
        `?cursor=-1&factCursor=-1&branchId=${encodeURIComponent(ownerBranch.branchId)}`,
        undefined,
        false,
      ],
    ] as const) {
      bucket.clearReadMetrics();
      const response = await call(query, requestAccountId, developmentAuth);
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Branch not found.");
      expectNoDiffOrFactReads();
    }

    for (const [visibility, deletedAt] of [
      ["unknown", null],
      ["public", 2],
      ["unlisted", 2],
      ["private", 2],
    ] as const) {
      setProjection(visibility, deletedAt);
      bucket.clearReadMetrics();
      const response = await call(
        `?cursor=__latest__&branchId=${encodeURIComponent(ownerBranch.branchId)}`,
        accountId,
        true,
      );
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Branch not found.");
      expectNoDiffOrFactReads();
      expect(
        bucket.getCalls.filter((key) => key.startsWith("__drop_branch__/")),
      ).toEqual([]);
    }
  });

  it.each([
    ["private", "DfPr01", "private", null, undefined],
    ["tombstoned", "DfDe01", "public", 2, accountId],
    ["malformed", "DfBa01", "unknown", null, accountId],
  ] as const)(
    "hides malformed poll validation for an R2-only alias to a denied %s root",
    async (_label, shortId, visibility, deletedAt, requestAccountId) => {
      const bucket = createSeededBucket();
      const db = new MemoryD1Database();
      const { branch } = await resolveBranchForActor(
        bucket as never,
        rootDropId,
        accountId,
        null,
      );
      bucket.seed(createRemoteAliasKey(shortId), rootDropId, "text/plain");
      db.accountLibraryEntries.set(rootDropId, {
        entry_seq: 1,
        drop_id: rootDropId,
        account_id: accountId,
        visibility,
        created_at: 1,
        updated_at: 1,
        deleted_at: deletedAt,
      });
      bucket.clearReadMetrics();
      db.runCalls = 0;
      const headers = requestAccountId
        ? { "x-nulldown-account-id": requestAccountId }
        : undefined;

      const response = await onRequest({
        request: new Request(
          `https://nulldown.test/api/diff/${shortId}?cursor=invalid&limit=0&factCursor=invalid&factLimit=0&branchId=${encodeURIComponent(branch.branchId)}`,
          { headers },
        ),
        env: {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: db as unknown as D1Database,
          ACCOUNT_AUTH_SECRET: "test-secret",
          ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        },
        params: { id: shortId },
      } as unknown as Parameters<typeof onRequest>[0]);

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Branch not found.");
      expect(db.runCalls).toBe(0);
      expect(
        bucket.getCalls.filter(
          (key) =>
            key.startsWith("__drop_branch__/") ||
            key.startsWith("__drop_branch_diffs__/") ||
            key.startsWith("__drop_branch_diff_events__/") ||
            key.startsWith("__drop_branch_runtime_fact_events__/"),
        ),
      ).toEqual([]);
      expect(bucket.listCalls).toEqual([]);
    },
  );

  it("preserves poll validation errors for an allowed projected public root", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    db.accountLibraryEntries.set(rootDropId, {
      entry_seq: 1,
      drop_id: rootDropId,
      account_id: accountId,
      visibility: "public",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    });

    const response = await onRequest({
      request: new Request(
        `https://nulldown.test/api/diff/${rootDropId}?cursor=invalid&limit=0&factCursor=invalid&factLimit=0`,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ACCOUNT_AUTH_SECRET: "test-secret",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid diff poll query.",
      code: "validation_failed",
    });
    expect(
      bucket.getCalls.filter((key) => key.startsWith("__drop_branch__/")),
    ).toEqual([]);
    expect(db.runCalls).toBe(0);
  });

  it("resolves an allowed R2-only short alias for diff polling", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );
    bucket.seed(createRemoteAliasKey("DfPu01"), rootDropId, "text/plain");
    db.accountLibraryEntries.set(rootDropId, {
      entry_seq: 1,
      drop_id: rootDropId,
      account_id: accountId,
      visibility: "public",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    });
    db.runCalls = 0;

    const response = await onRequest({
      request: new Request(
        `https://nulldown.test/api/diff/DfPu01?cursor=__latest__&branchId=${encodeURIComponent(branch.branchId)}`,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ACCOUNT_AUTH_SECRET: "test-secret",
      },
      params: { id: "DfPu01" },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(200);
    expect(db.runCalls).toBe(0);
  });

  it("allows projected private owner and explicit writer event polls but hides siblings", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const { branch: resolvedOwner } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );
    const ownerBranch = { ...resolvedOwner, headEventSeq: 0 };
    const writerBranch = {
      ...ownerBranch,
      branchId: "writer-branch",
      mode: "clone" as const,
      ownerAccountId: "forged-owner",
      writerAccountId: "account-writer",
    };
    const siblingBranch = {
      ...writerBranch,
      branchId: "sibling-branch",
      writerAccountId: "account-sibling",
    };
    for (const branch of [ownerBranch, writerBranch, siblingBranch]) {
      bucket.seed(
        createBranchKey(rootDropId, branch.branchId),
        JSON.stringify(branch),
      );
      db.seedBranchEvent(rootDropId, branch.branchId, {
        ...makeEvent({
          eventId: `evt-${branch.branchId}`,
          sourceClientId: branch.branchId,
          text: branch.branchId,
          createdAt: 202,
        }),
        snapshotId: 1,
      });
    }
    db.accountLibraryEntries.set(rootDropId, {
      entry_seq: 1,
      drop_id: rootDropId,
      account_id: accountId,
      visibility: "private",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    });
    const call = (branchId: string, cursor: string, requestAccountId: string) =>
      onRequest({
        request: new Request(
          `https://nulldown.test/api/diff/${rootDropId}?cursor=${cursor}&branchId=${encodeURIComponent(branchId)}`,
          { headers: { "x-nulldown-account-id": requestAccountId } },
        ),
        env: {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: db as unknown as D1Database,
          ACCOUNT_AUTH_SECRET: "test-secret",
          ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        },
        params: { id: rootDropId },
      } as unknown as Parameters<typeof onRequest>[0]);

    const ownerLatest = await call(
      ownerBranch.branchId,
      "__latest__",
      accountId,
    );
    expect(ownerLatest.status).toBe(200);
    await expect(ownerLatest.json()).resolves.toEqual({
      events: [],
      cursor: "0",
    });

    const writerPage = await call(
      writerBranch.branchId,
      "-1",
      "account-writer",
    );
    expect(writerPage.status).toBe(200);
    await expect(writerPage.json()).resolves.toMatchObject({
      cursor: "0",
      events: [{ eventId: "evt-writer-branch", seq: 0 }],
    });

    const sibling = await call(siblingBranch.branchId, "-1", "account-writer");
    expect(sibling.status).toBe(404);
    await expect(sibling.text()).resolves.toBe("Branch not found.");
  });

  it.each(["public", "unlisted"] as const)(
    "keeps projected %s ordinary event polling anonymously readable",
    async (visibility) => {
      const bucket = createSeededBucket();
      const db = new MemoryD1Database();
      const { branch } = await resolveBranchForActor(
        bucket as never,
        rootDropId,
        null,
        null,
      );
      bucket.seed(
        createBranchKey(rootDropId, branch.branchId),
        JSON.stringify({ ...branch, headEventSeq: 0 }),
      );
      db.accountLibraryEntries.set(rootDropId, {
        entry_seq: 1,
        drop_id: rootDropId,
        account_id: accountId,
        visibility,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      });
      db.seedBranchEvent(rootDropId, branch.branchId, {
        ...makeEvent({
          eventId: `evt-${visibility}`,
          sourceClientId: "anonymous-source",
          text: visibility,
          createdAt: 203,
        }),
        snapshotId: 1,
      });

      const response = await onRequest({
        request: new Request(
          `https://nulldown.test/api/diff/${rootDropId}?cursor=-1&branchId=${encodeURIComponent(branch.branchId)}`,
        ),
        env: {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: db as unknown as D1Database,
          ACCOUNT_AUTH_SECRET: "test-secret",
        },
        params: { id: rootDropId },
      } as unknown as Parameters<typeof onRequest>[0]);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        events: [{ eventId: `evt-${visibility}` }],
      });
    },
  );

  it("returns authenticated runtime fact pages with an independent cursor", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      accountId,
      null,
    );
    const facts = createBranchRuntimeFactLogRepository({
      blobs: bucket as never,
    });
    await facts.appendBranchRuntimeFact(rootDropId, branch.branchId, {
      version: 1,
      kind: "ui.state.patch",
      id: "patch-1",
      callId: "call-1",
      createdAt: 1,
      source: {
        rootDropId,
        branchId: branch.branchId,
        snapshotId: branch.headSnapshotId,
        callId: "call-1",
      },
      patch: [{ op: "set", path: ["approved"], value: true }],
    });

    const response = await onRequest({
      request: createGetRequest(
        `?cursor=-1&factCursor=-1&branchId=${encodeURIComponent(branch.branchId)}`,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    const body = (await response.json()) as {
      cursor: string | null;
      events: unknown[];
      factCursor?: string | null;
      facts?: Array<{ seq: number; fact: { id: string } }>;
    };

    expect(response.status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.cursor).toBeNull();
    expect(body.factCursor).toBe("0");
    expect(body.facts).toEqual([
      expect.objectContaining({
        seq: 0,
        fact: expect.objectContaining({ id: "patch-1" }),
      }),
    ]);
  });

  it.each([
    ["public", "-1", 1],
    ["public", "__latest__", 0],
    ["unlisted", "-1", 1],
    ["unlisted", "__latest__", 0],
  ] as const)(
    "allows the projected canonical owner to read %s runtime facts from cursor %s despite forged branch ownership",
    async (visibility, factCursor, expectedFactCount) => {
      const bucket = createSeededBucket();
      const db = new MemoryD1Database();
      const { branch: resolvedBranch } = await resolveBranchForActor(
        bucket as never,
        rootDropId,
        null,
        null,
      );
      const branch = {
        ...resolvedBranch,
        ownerAccountId: "forged-owner",
        writerAccountId: "account-writer",
      };
      bucket.seed(
        createBranchKey(rootDropId, branch.branchId),
        JSON.stringify(branch),
      );
      db.accountLibraryEntries.set(rootDropId, {
        entry_seq: 1,
        drop_id: rootDropId,
        account_id: accountId,
        visibility,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      });
      const facts = createBranchRuntimeFactLogRepository({
        blobs: bucket as never,
        sql: db as never,
      });
      await facts.appendBranchRuntimeFact(rootDropId, branch.branchId, {
        version: 1,
        kind: "ui.state.patch",
        id: `patch-owner-${visibility}-${factCursor}`,
        callId: "call-owner",
        createdAt: 1,
        source: {
          rootDropId,
          branchId: branch.branchId,
          snapshotId: branch.headSnapshotId,
          callId: "call-owner",
        },
        patch: [{ op: "set", path: ["approved"], value: true }],
      });

      const response = await onRequest({
        request: new Request(
          `https://nulldown.test/api/diff/${rootDropId}?cursor=-1&factCursor=${factCursor}&branchId=${encodeURIComponent(branch.branchId)}`,
          { headers: { "x-nulldown-account-id": accountId } },
        ),
        env: {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: db as unknown as D1Database,
          ACCOUNT_AUTH_SECRET: "test-secret",
          ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        },
        params: { id: rootDropId },
      } as unknown as Parameters<typeof onRequest>[0]);
      const body = (await response.json()) as {
        facts?: unknown[];
        factCursor?: string | null;
      };

      expect(response.status).toBe(200);
      expect(body.facts).toHaveLength(expectedFactCount);
      expect(body.factCursor).toBe("0");
    },
  );

  it("uses only projected canonical ownership or the exact branch writer for public runtime facts", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const { branch: resolvedBranch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      null,
      null,
    );
    const branch = {
      ...resolvedBranch,
      ownerAccountId: "forged-owner",
      writerAccountId: "account-writer",
    };
    const siblingBranch = {
      ...branch,
      branchId: "fact-sibling",
      ownerAccountId: "account-writer",
      writerAccountId: "account-sibling",
    };
    for (const record of [branch, siblingBranch]) {
      bucket.seed(
        createBranchKey(rootDropId, record.branchId),
        JSON.stringify(record),
      );
    }
    db.accountLibraryEntries.set(rootDropId, {
      entry_seq: 1,
      drop_id: rootDropId,
      account_id: accountId,
      visibility: "public",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    });
    const call = (branchId: string, requestAccountId?: string) => {
      const headers = new Headers();
      if (requestAccountId) {
        headers.set("x-nulldown-account-id", requestAccountId);
      }
      return onRequest({
        request: new Request(
          `https://nulldown.test/api/diff/${rootDropId}?cursor=-1&factCursor=-1&branchId=${encodeURIComponent(branchId)}`,
          { headers },
        ),
        env: {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: db as unknown as D1Database,
          ACCOUNT_AUTH_SECRET: "test-secret",
          ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        },
        params: { id: rootDropId },
      } as unknown as Parameters<typeof onRequest>[0]);
    };

    await expect(
      call(branch.branchId, "account-writer"),
    ).resolves.toMatchObject({
      status: 200,
    });
    for (const response of [
      await call(branch.branchId, "forged-owner"),
      await call(siblingBranch.branchId, "account-writer"),
      await call(branch.branchId, "account-unrelated"),
      await call(branch.branchId),
    ]) {
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe(
        "You are not allowed to read runtime facts for this branch.",
      );
    }
  });

  it("preserves legacy projection-absent runtime fact reads for the exact writer", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const { branch: resolvedBranch } = await resolveBranchForActor(
      bucket as never,
      rootDropId,
      null,
      null,
    );
    const branch = {
      ...resolvedBranch,
      ownerAccountId: "forged-owner",
      writerAccountId: "legacy-writer",
    };
    bucket.seed(
      createBranchKey(rootDropId, branch.branchId),
      JSON.stringify(branch),
    );

    const response = await onRequest({
      request: new Request(
        `https://nulldown.test/api/diff/${rootDropId}?cursor=-1&factCursor=__latest__&branchId=${encodeURIComponent(branch.branchId)}`,
        { headers: { "x-nulldown-account-id": "legacy-writer" } },
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ACCOUNT_AUTH_SECRET: "test-secret",
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      facts: [],
      factCursor: "-1",
    });
  });

  it("requires branch-writer access for runtime facts on a projected public root", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    db.accountLibraryEntries.set(rootDropId, {
      entry_seq: 1,
      drop_id: rootDropId,
      account_id: accountId,
      visibility: "public",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    });
    const response = await onRequest({
      request: new Request(
        `https://nulldown.test/api/diff/${rootDropId}?cursor=-1&factCursor=-1`,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ACCOUNT_AUTH_SECRET: "production-secret",
      },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe(
      "You are not allowed to read runtime facts for this branch.",
    );
  });
});
