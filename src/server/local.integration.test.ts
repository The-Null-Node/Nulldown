import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranchRepository } from "../../functions/api/_lib/branches/storage/repository";
import { hashMarkdownSource } from "../../shared/drop/resolved/hash";
import { NULLPLUG_INVOKE_CONTENT_TYPE } from "../../shared/nullplug/protocol";
import { remoteNullplugLatestKey } from "../../shared/nullplug/registry";
import { createFilesystemBlobStore } from "./filesystem-blob-store";
import { createLocalNulldownServer } from "./local";
import { createMemoryRuntimeDataStore } from "./memory-data-store";
import { createNullMemFreshnessWatermarkKey } from "./nulledit";
import type {
  RuntimeDataStore,
  SqlBindableValue,
  SqlStatement,
  SqlMetadataStore,
} from "./ports";

const localRootDropId = "LocalAdapterRoot";
const localBranchId = "writer";
const localOwnerAccountId = "local-adapter-owner";

class LocalReadDatabase implements SqlMetadataStore {
  prepare(sql: string): SqlStatement {
    let values: SqlBindableValue[] = [];
    const statement: SqlStatement = {
      bind: (...bound) => {
        values = bound;
        return statement;
      },
      run: async () => ({ success: true }),
      first: async <T>() => {
        if (
          sql.includes("FROM account_library_entries") &&
          values[0] === localRootDropId
        ) {
          return {
            entry_seq: 1,
            drop_id: localRootDropId,
            account_id: localOwnerAccountId,
            visibility: "public",
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          } as T;
        }
        return null;
      },
      all: async <T>() => ({ results: [] as T[] }),
    };
    return statement;
  }
}

class LocalRootProjectionDatabase implements SqlMetadataStore {
  constructor(
    private readonly visibility: unknown,
    private readonly ownerAccountId: string,
  ) {}

  prepare(sql: string): SqlStatement {
    let values: SqlBindableValue[] = [];
    const statement: SqlStatement = {
      bind: (...bound) => {
        values = bound;
        return statement;
      },
      run: async () => ({ success: true }),
      first: async <T>() =>
        sql.includes("FROM account_library_entries")
          ? ({
              entry_seq: 1,
              drop_id: String(values[0]),
              account_id: this.ownerAccountId,
              visibility: this.visibility,
              created_at: 1,
              updated_at: 1,
              deleted_at: null,
            } as T)
          : null,
      all: async <T>() => ({ results: [] as T[] }),
    };
    return statement;
  }
}

const seedLocalReadTarget = async (dataDir: string): Promise<void> => {
  const blobs = createFilesystemBlobStore({ rootDir: join(dataDir, "blobs") });
  const branches = createBranchRepository({ blobs });
  await branches.writeBranch({
    version: 1,
    rootDropId: localRootDropId,
    branchId: localBranchId,
    baseDropId: localRootDropId,
    mode: "clone",
    status: "active",
    ownerAccountId: localOwnerAccountId,
    writerAccountId: localOwnerAccountId,
    writerClientId: null,
    headSnapshotId: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  await blobs.put(
    remoteNullplugLatestKey("remote-tool"),
    JSON.stringify({
      version: 1,
      manifest: {
        id: "remote-tool",
        version: "1.0.0",
        endpoint: "https://tools.example.test/invoke",
        contentType: NULLPLUG_INVOKE_CONTENT_TYPE,
        inputSchema: {},
        outputSchema: {},
        permissions: [],
        description: "Remote tool catalog fixture.",
      },
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
};

describe("createLocalNulldownServer", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "nulldown-local-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("stores and retrieves a plaintext drop through Web routes", async () => {
    const server = createLocalNulldownServer({
      dataDir,
      publicBaseUrl: "http://127.0.0.1:8788",
      logLevel: "error",
    });

    const stored = await server.fetch("http://127.0.0.1:8788/api/store", {
      method: "POST",
      body: "hello void",
      headers: { "Content-Type": "text/plain" },
    });
    const storedBody = (await stored.json()) as { id: string };

    expect(stored.status).toBe(200);
    expect(storedBody.id).toEqual(expect.any(String));

    const fetched = await server.fetch(
      `http://127.0.0.1:8788/api/get/${storedBody.id}`,
    );

    expect(fetched.status).toBe(200);
    await expect(fetched.text()).resolves.toBe("hello void");
  });

  it("matches Cloudflare private-root authorization and response metadata locally", async () => {
    const id = "LocalPrivate1";
    const owner = "local-private-owner";
    const blobs = createFilesystemBlobStore({
      rootDir: join(dataDir, "blobs"),
    });
    await blobs.put(id, "private local body", {
      httpMetadata: { contentType: "text/plain" },
    });
    const server = createLocalNulldownServer({
      dataDir,
      sql: new LocalRootProjectionDatabase("private", owner),
      logLevel: "error",
    });
    const url = `http://127.0.0.1:8788/api/get/${id}`;

    for (const headers of [
      undefined,
      { "x-nulldown-account-id": "unrelated" },
      { "x-nulldown-account-id": "branch-writer-only" },
    ]) {
      const denied = await server.fetch(url, { headers });
      expect(denied.status).toBe(404);
      await expect(denied.text()).resolves.toBe("Drop not found.");
    }

    const allowed = await server.fetch(url, {
      headers: { "x-nulldown-account-id": owner },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Content-Type")).toBe("text/plain");
    expect(allowed.headers.get("ETag")).toEqual(expect.any(String));
    expect(allowed.headers.get("X-Drop-Revision")).toBe(
      allowed.headers.get("ETag"),
    );
    expect(allowed.headers.get("X-Drop-Canonical-Id")).toBe(id);
    await expect(allowed.text()).resolves.toBe("private local body");
  });

  it("appends diff events and materializes branch content locally", async () => {
    const server = createLocalNulldownServer({
      dataDir,
      publicBaseUrl: "http://127.0.0.1:8788",
      logLevel: "error",
    });
    const stored = await server.fetch("http://127.0.0.1:8788/api/store", {
      method: "POST",
      body: "base",
      headers: { "Content-Type": "text/plain" },
    });
    const { id } = (await stored.json()) as { id: string };

    const appended = await server.fetch(
      `http://127.0.0.1:8788/api/diff/${id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          events: [
            {
              eventId: "evt-local-1",
              seq: 0,
              dropId: id,
              sourceClientId: "local-test",
              createdAt: Date.now(),
              ops: [{ type: "insert", start: 0, end: 0, text: "local " }],
            },
          ],
        }),
      },
    );
    const appendBody = (await appended.json()) as {
      branchId: string;
      snapshotId: number;
    };

    expect(appended.status).toBe(200);
    expect(appendBody).toEqual(
      expect.objectContaining({ branchId: "clone_anonymous", snapshotId: 1 }),
    );

    const branches = await server.fetch(
      `http://127.0.0.1:8788/api/branches/${id}`,
    );

    expect(branches.status).toBe(200);
    await expect(branches.json()).resolves.toEqual(
      expect.objectContaining({
        rootDropId: id,
        branches: [
          expect.objectContaining({
            branchId: appendBody.branchId,
            headSnapshotId: 1,
            headEventSeq: 0,
          }),
        ],
      }),
    );

    const content = await server.fetch(
      `http://127.0.0.1:8788/api/branches/${id}/${appendBody.branchId}/content`,
    );

    expect(content.status).toBe(200);
    await expect(content.json()).resolves.toEqual(
      expect.objectContaining({ content: "local base", headEventSeq: 0 }),
    );
  });

  it("persists nullplug state facts through local routes", async () => {
    const server = createLocalNulldownServer({
      dataDir,
      publicBaseUrl: "http://127.0.0.1:8788",
      logLevel: "error",
    });
    const accountId = "local-nullplug-owner";
    const content = "# Local nullplug";
    const stored = await server.fetch("http://127.0.0.1:8788/api/store", {
      method: "POST",
      body: content,
      headers: { "Content-Type": "text/plain" },
    });
    const { id } = (await stored.json()) as { id: string };
    const resolved = await server.fetch(
      `http://127.0.0.1:8788/api/branches/resolve/${id}`,
      {
        method: "POST",
        headers: { "x-nulldown-account-id": accountId },
      },
    );
    const branch = (await resolved.json()) as { branchId: string };
    const sourceContentHash = await hashMarkdownSource(content);

    const submitted = await server.fetch(
      "http://127.0.0.1:8788/api/nullplug/state",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-nulldown-account-id": accountId,
        },
        body: JSON.stringify({
          version: 1,
          kind: "ui.state.patch",
          id: "local-state",
          callId: "local-call",
          createdAt: 1,
          source: {
            rootDropId: id,
            branchId: branch.branchId,
            snapshotId: 0,
            sourceContentHash,
            callId: "local-call",
          },
          patch: [{ op: "set", path: ["approved"], value: true }],
        }),
      },
    );

    expect(submitted.status).toBe(200);
    await expect(submitted.json()).resolves.toEqual(
      expect.objectContaining({ stored: true, indexed: true }),
    );
  });

  it("dispatches authorized sensitive snapshotter queries and rejects anonymous dispatch", async () => {
    await seedLocalReadTarget(dataDir);
    const server = createLocalNulldownServer({
      dataDir,
      sql: new LocalReadDatabase(),
      logLevel: "error",
    });
    const url = `http://127.0.0.1:8788/api/branches/${localRootDropId}/${localBranchId}/resolved/query?snapshotterId=nulledit.policy-observer&q=next&k=2`;

    const anonymous = await server.fetch(url);
    expect(anonymous.status).toBe(403);
    await expect(anonymous.json()).resolves.toEqual({
      error: "Authenticated branch capability is required.",
      code: "forbidden",
    });

    const authorized = await server.fetch(url, {
      headers: { "x-nulldown-account-id": localOwnerAccountId },
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({ items: [] });
  });

  it("uses local freshness data while filtering public remote capability catalogs", async () => {
    await seedLocalReadTarget(dataDir);
    const storedData = createMemoryRuntimeDataStore();
    await storedData.put(
      createNullMemFreshnessWatermarkKey(localRootDropId, localBranchId),
      {
        version: 1,
        rootDropId: localRootDropId,
        branchId: localBranchId,
        headSnapshotId: 9,
        previousSnapshotId: 8,
        updatedAt: 10,
        acceptedEventCount: 1,
      },
    );
    let freshnessReads = 0;
    const data: RuntimeDataStore = {
      ...storedData,
      get: <T = unknown>(key: Parameters<RuntimeDataStore["get"]>[0]) => {
        freshnessReads += 1;
        return storedData.get<T>(key);
      },
    };
    const server = createLocalNulldownServer({
      dataDir,
      sql: new LocalReadDatabase(),
      data,
      logLevel: "error",
    });
    const url = `http://127.0.0.1:8788/api/branches/${localRootDropId}/${localBranchId}/memory/query?kind=capability&q=remote-tool&includeFreshness=true`;

    const publicResponse = await server.fetch(url);
    expect(publicResponse.status).toBe(200);
    await expect(publicResponse.json()).resolves.toEqual(
      expect.objectContaining({ records: [], freshness: [] }),
    );
    expect(freshnessReads).toBe(1);

    const sensitiveResponse = await server.fetch(url, {
      headers: { "x-nulldown-account-id": localOwnerAccountId },
    });
    expect(sensitiveResponse.status).toBe(200);
    const body = (await sensitiveResponse.json()) as {
      records: Array<{ recordId: string }>;
      freshness: Array<{ currentSnapshotId?: number }>;
    };
    expect(body.records.map(({ recordId }) => recordId)).toContain(
      "capability:nullplug:remote-tool:1.0.0",
    );
    expect(body.freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "capability:nullplug:remote-tool:1.0.0",
          currentSnapshotId: 9,
        }),
      ]),
    );
    expect(freshnessReads).toBe(2);
  });
});
