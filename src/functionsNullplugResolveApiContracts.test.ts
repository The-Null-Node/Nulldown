import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../functions/api/nullplug/resolve";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../shared/drop/branch";
import {
  NULLPLUG_INVOKE_CONTENT_TYPE,
  remoteNullplugLatestKey,
} from "../shared/nullplug/registry";
import { createBranchKey } from "../functions/api/_lib/branches/storage/keys";
import { createRemoteAliasKey } from "../functions/api/_lib/drops/identity/id";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();
  getCalls = 0;
  readonly getKeys: string[] = [];

  seed(key: string, value: string, contentType = "application/json"): void {
    const uploaded = new Date();
    this.objects.set(key, {
      value,
      contentType,
      etag: createHash("sha1").update(`${key}:${value}`).digest("hex"),
      uploaded,
    });
  }

  async get(key: string): Promise<any> {
    this.getCalls += 1;
    this.getKeys.push(key);
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
}

interface ProjectionRow {
  entry_seq: number;
  drop_id: string;
  account_id: string;
  visibility: unknown;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

class MemoryD1Database {
  runs = 0;
  readonly projectionReads: string[] = [];

  constructor(
    private readonly projections = new Map<string, ProjectionRow>(),
    private readonly aliases = new Map<string, string>(),
  ) {}

  prepare(sql: string): any {
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      first: async () => {
        if (sql.includes("FROM drop_aliases")) {
          const fullId = this.aliases.get(String(values[0]));
          return fullId ? { full_id: fullId } : null;
        }
        if (sql.includes("FROM account_library_entries")) {
          const id = String(values[0]);
          this.projectionReads.push(id);
          return this.projections.get(id) ?? null;
        }
        return null;
      },
      run: async () => {
        this.runs += 1;
        return { success: true };
      },
      all: async () => ({ results: [] }),
      raw: async () => [],
    };
    return statement;
  }
}

const projection = (
  dropId: string,
  visibility: unknown,
  ownerAccountId: string,
  deletedAt: number | null = null,
): ProjectionRow => ({
  entry_seq: 1,
  drop_id: dropId,
  account_id: ownerAccountId,
  visibility,
  created_at: 1,
  updated_at: 1,
  deleted_at: deletedAt,
});

const rootDropId = "RootDrop1122";
const childDropId = "ChildDrop3344";
const branchId = "clone_author";
const accountId = "acct-author";

const createResolveRequest = (
  body: unknown,
  requestAccountId: string | null = accountId,
): Request =>
  new Request("https://nulldown.test/api/nullplug/resolve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(requestAccountId
        ? { [NULLDOWN_ACCOUNT_ID_HEADER]: requestAccountId }
        : {}),
    },
    body: JSON.stringify(body),
  });

const createInvokeBody = (
  pluginId = "nd",
  id = childDropId,
  callerDropId = rootDropId,
  contextCallerDropId?: string,
  capabilities = ["render", "drop.read"],
) => ({
  call: {
    pluginId,
    args: { id },
    caller: { dropId: callerDropId, branchId },
  },
  context: {
    providerId: "nulldown-provider",
    baseUrl: "https://nulldown.test",
    ...(contextCallerDropId ? { callerDropId: contextCallerDropId } : {}),
    capabilities,
  },
});

describe("functions api nullplug resolve contracts", () => {
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
      JSON.stringify({ content: "# Root Plan", metadata: {} }),
    );
    bucket.seed(
      childDropId,
      JSON.stringify({
        content: "# Child Plan\n\nThis child plan is resolved by the provider.",
        metadata: { rootDropId },
      }),
    );
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
    return bucket;
  };

  const seedRootRuntimePolicy = (
    bucket: MemoryR2Bucket,
    runtimePolicy: unknown,
  ): void => {
    bucket.seed(
      rootDropId,
      JSON.stringify({ content: "# Root Plan", metadata: { runtimePolicy } }),
    );
  };

  const seedActiveRemoteManifest = (
    bucket: MemoryR2Bucket,
    pluginId: string,
  ): void => {
    bucket.seed(
      remoteNullplugLatestKey(pluginId),
      JSON.stringify({
        version: 1,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        manifest: {
          id: pluginId,
          version: "1.0.0",
          endpoint: "https://plugins.nulldown.test/summary",
          contentType: NULLPLUG_INVOKE_CONTENT_TYPE,
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          permissions: [
            { kind: "drop.read", scope: "caller" },
            { kind: "null.call" },
          ],
        },
      }),
    );
  };

  it("resolves built-in nd calls through the provider boundary", async () => {
    const bucket = createSeededBucket();

    const response = await onRequest({
      request: createResolveRequest(createInvokeBody()),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as {
      result: { content: string; metadata: Record<string, unknown> };
      diagnostics: Array<{ level: string; message: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.result.content).toContain("[Child Plan](/d/ChildD)");
    expect(body.result.content).toContain(
      "This child plan is resolved by the provider.",
    );
    expect(body.result.metadata.resolvedDropId).toBe(childDropId);
    expect(body.diagnostics[0].level).toBe("info");
  });

  it("requires the caller branch writer before resolving provider-readable data", async () => {
    const bucket = createSeededBucket();

    const unauthenticated = await onRequest({
      request: createResolveRequest(createInvokeBody(), null),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ACCOUNT_AUTH_SECRET: "production-secret",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      code: "account_required",
    });
    expect(unauthenticated.status).toBe(401);

    const forbidden = await onRequest({
      request: createResolveRequest(createInvokeBody(), "acct-other"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    await expect(forbidden.json()).resolves.toMatchObject({
      code: "caller_branch_forbidden",
    });
    expect(forbidden.status).toBe(403);
  });

  it("uses canonical caller ownership or the exact writer, never branch owner metadata", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database(
      new Map([
        [rootDropId, projection(rootDropId, "private", "canonical-owner")],
      ]),
    );

    const writerResponse = await onRequest({
      request: createResolveRequest(createInvokeBody(), accountId),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(writerResponse.status).toBe(200);

    bucket.seed(
      createBranchKey(rootDropId, branchId),
      JSON.stringify({
        version: 1,
        branchId,
        rootDropId,
        baseDropId: rootDropId,
        mode: "clone",
        status: "active",
        ownerAccountId: accountId,
        writerAccountId: "acct-other",
        writerClientId: "client-1",
        headSnapshotId: 0,
        headEventSeq: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const canonicalOwnerResponse = await onRequest({
      request: createResolveRequest(createInvokeBody(), "canonical-owner"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(canonicalOwnerResponse.status).toBe(200);

    const forgedOwnerResponse = await onRequest({
      request: createResolveRequest(createInvokeBody(), accountId),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(forgedOwnerResponse.status).toBe(404);
    await expect(forgedOwnerResponse.json()).resolves.toEqual({
      error: "Caller root not found.",
      code: "caller_root_not_found",
    });
  });

  it("keeps public and unlisted targets readable while tombstone and malformed projections fail closed", async () => {
    for (const [visibility, expectedStatus] of [
      ["public", 200],
      ["unlisted", 200],
      ["private", 404],
      ["friends", 404],
    ] as const) {
      const targetId = `Target${visibility.slice(0, 3)}001`;
      const bucket = createSeededBucket();
      bucket.seed(targetId, JSON.stringify({ content: `# ${visibility}` }));
      const db = new MemoryD1Database(
        new Map([
          [rootDropId, projection(rootDropId, "public", "caller-owner")],
          [targetId, projection(targetId, visibility, "target-owner")],
        ]),
      );
      const response = await onRequest({
        request: createResolveRequest(createInvokeBody("nd", targetId)),
        env: {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: db as unknown as D1Database,
          ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        },
        params: {},
      } as unknown as Parameters<typeof onRequest>[0]);
      expect(response.status).toBe(expectedStatus);
      expect(bucket.getKeys.includes(targetId)).toBe(expectedStatus === 200);
    }

    const tombstonedId = "TargetTom001";
    const bucket = createSeededBucket();
    bucket.seed(tombstonedId, JSON.stringify({ content: "must not read" }));
    const response = await onRequest({
      request: createResolveRequest(createInvokeBody("nd", tombstonedId)),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: new MemoryD1Database(
          new Map([
            [rootDropId, projection(rootDropId, "public", "caller-owner")],
            [
              tombstonedId,
              projection(tombstonedId, "public", "target-owner", 2),
            ],
          ]),
        ) as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(response.status).toBe(404);
    expect(bucket.getKeys).not.toContain(tombstonedId);
  });

  it("rejects an invalid bearer without falling back to the development account header", async () => {
    const bucket = createSeededBucket();
    const request = createResolveRequest(createInvokeBody(), accountId);
    request.headers.set("Authorization", "Bearer invalid-token");
    const response = await onRequest({
      request,
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: new MemoryD1Database(
          new Map([
            [rootDropId, projection(rootDropId, "public", "caller-owner")],
          ]),
        ) as unknown as D1Database,
        ACCOUNT_AUTH_SECRET: "test-secret",
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "account_required",
    });
    expect(bucket.getKeys).not.toContain(createBranchKey(rootDropId, branchId));
  });

  it("denies a tombstoned caller alias before branch, payload, or runtime reads and never backfills D1", async () => {
    const bucket = createSeededBucket();
    const alias = "RootTs";
    bucket.seed(createRemoteAliasKey(alias), rootDropId, "text/plain");
    const db = new MemoryD1Database(
      new Map([[rootDropId, projection(rootDropId, "private", accountId, 2)]]),
    );

    const response = await onRequest({
      request: createResolveRequest(createInvokeBody("nd", childDropId, alias)),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Caller root not found.",
      code: "caller_root_not_found",
    });
    expect(db.runs).toBe(0);
    expect(bucket.getKeys).toEqual([createRemoteAliasKey(alias)]);
  });

  it("authorizes the built-in target independently from caller branch authority", async () => {
    const targetOwner = "target-owner";
    const projections = new Map([
      [rootDropId, projection(rootDropId, "public", "caller-owner")],
      [childDropId, projection(childDropId, "private", targetOwner)],
    ]);
    const deniedBucket = createSeededBucket();
    const denied = await onRequest({
      request: createResolveRequest(createInvokeBody(), accountId),
      env: {
        R2_BUCKET: deniedBucket as unknown as R2Bucket,
        DB: new MemoryD1Database(projections) as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(denied.status).toBe(404);
    await expect(denied.json()).resolves.toEqual({
      error: "Drop not found.",
      code: "drop_not_found",
    });
    expect(deniedBucket.getKeys).not.toContain(childDropId);

    const ownerBucket = createSeededBucket();
    ownerBucket.seed(
      createBranchKey(rootDropId, branchId),
      JSON.stringify({
        version: 1,
        branchId,
        rootDropId,
        baseDropId: rootDropId,
        mode: "clone",
        status: "active",
        ownerAccountId: "forged-owner",
        writerAccountId: targetOwner,
        writerClientId: "client-1",
        headSnapshotId: 0,
        headEventSeq: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const allowed = await onRequest({
      request: createResolveRequest(createInvokeBody(), targetOwner),
      env: {
        R2_BUCKET: ownerBucket as unknown as R2Bucket,
        DB: new MemoryD1Database(projections) as unknown as D1Database,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(allowed.status).toBe(200);
  });

  it("rejects unsupported plugins instead of resolving remote code", async () => {
    const bucket = createSeededBucket();
    seedRootRuntimePolicy(bucket, {
      version: 1,
      nullplugs: { "remote-plugin": { invoke: "allow" } },
    });

    const response = await onRequest({
      request: createResolveRequest(createInvokeBody("remote-plugin")),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as { code: string };
    expect(response.status).toBe(404);
    expect(body.code).toBe("unsupported_plugin");
  });

  it("invokes authorized remote manifests with narrowed capabilities and filtered effects", async () => {
    const bucket = createSeededBucket();
    seedRootRuntimePolicy(bucket, {
      version: 1,
      nullplugs: {
        "remote.summary": {
          invoke: "allow",
          capabilities: ["drop.read"],
        },
      },
    });
    seedActiveRemoteManifest(bucket, "remote.summary");
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://plugins.nulldown.test/summary");
      expect(new Headers(init?.headers).get("Content-Type")).toBe(
        NULLPLUG_INVOKE_CONTENT_TYPE,
      );
      const body = JSON.parse(String(init?.body)) as {
        call: { version?: string };
        context: { capabilities: string[] };
      };
      expect(body.call.version).toBe("1.0.0");
      expect(body.context.capabilities).toEqual(["drop.read"]);
      return new Response(
        JSON.stringify({
          result: {
            content: "Remote result",
            calls: [{ pluginId: "other", args: {}, caller: {} }],
          },
        }),
        { headers: { "Content-Type": NULLPLUG_INVOKE_CONTENT_TYPE } },
      );
    };

    const response = await onRequest({
      request: createResolveRequest(
        createInvokeBody("remote.summary", childDropId, rootDropId, undefined, [
          "render",
          "drop.read",
          "null.call",
        ]),
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        NULLPLUG_REGISTRY_ALLOWED_HOSTS: "plugins.nulldown.test",
        fetchImpl,
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: { content: "Remote result" },
      diagnostics: [
        {
          level: "warn",
          code: "policy_nested_call_rejected",
          message: "Root policy rejected one or more nested nullplug calls.",
        },
      ],
    });
  });

  it("denies unapproved remote plugins before fetching their manifest endpoint", async () => {
    const bucket = createSeededBucket();
    seedActiveRemoteManifest(bucket, "remote.summary");
    const fetchImpl = jest.fn<typeof fetch>();

    const response = await onRequest({
      request: createResolveRequest(
        createInvokeBody("remote.summary", childDropId),
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        NULLPLUG_REGISTRY_ALLOWED_HOSTS: "plugins.nulldown.test",
        fetchImpl,
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    await expect(response.json()).resolves.toMatchObject({
      code: "policy_denied",
    });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not treat a client rootPolicyRef as remote authorization", async () => {
    const bucket = createSeededBucket();
    seedActiveRemoteManifest(bucket, "remote.summary");
    const fetchImpl = jest.fn<typeof fetch>();
    const body = createInvokeBody("remote.summary", childDropId);
    body.call.caller = {} as never;
    (
      body.context as typeof body.context & { rootPolicyRef: string }
    ).rootPolicyRef = rootDropId;

    const response = await onRequest({
      request: createResolveRequest(body),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        NULLPLUG_REGISTRY_ALLOWED_HOSTS: "plugins.nulldown.test",
        fetchImpl,
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    await expect(response.json()).resolves.toMatchObject({
      code: "caller_branch_required",
    });
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed while conditional remote invocation remains unavailable", async () => {
    const bucket = createSeededBucket();
    seedRootRuntimePolicy(bucket, {
      version: 1,
      nullplugs: { "remote.summary": { invoke: "conditional" } },
    });
    seedActiveRemoteManifest(bucket, "remote.summary");
    const fetchImpl = jest.fn<typeof fetch>();

    const response = await onRequest({
      request: createResolveRequest(
        createInvokeBody("remote.summary", childDropId),
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        NULLPLUG_REGISTRY_ALLOWED_HOSTS: "plugins.nulldown.test",
        fetchImpl,
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    await expect(response.json()).resolves.toMatchObject({
      code: "policy_conditional",
    });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("denies explicitly blocked built-ins before resolving their target", async () => {
    const bucket = createSeededBucket();
    seedRootRuntimePolicy(bucket, {
      version: 1,
      nullplugs: { nd: { invoke: "deny" } },
    });

    const response = await onRequest({
      request: createResolveRequest(createInvokeBody()),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    await expect(response.json()).resolves.toMatchObject({
      code: "policy_denied",
    });
    expect(response.status).toBe(403);
  });

  it("fails closed when a claimed caller root cannot supply valid policy metadata", async () => {
    const bucket = createSeededBucket();
    seedActiveRemoteManifest(bucket, "remote.summary");
    bucket.seed(rootDropId, JSON.stringify({ not: "a drop payload" }));
    const fetchImpl = jest.fn<typeof fetch>();

    const response = await onRequest({
      request: createResolveRequest(
        createInvokeBody("remote.summary", childDropId),
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        NULLPLUG_REGISTRY_ALLOWED_HOSTS: "plugins.nulldown.test",
        fetchImpl,
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    await expect(response.json()).resolves.toMatchObject({
      code: "policy_source_unreadable",
    });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed root policy and mismatched caller roots before resolution", async () => {
    const bucket = createSeededBucket();
    seedRootRuntimePolicy(bucket, { version: 2 });

    const malformed = await onRequest({
      request: createResolveRequest(createInvokeBody()),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    await expect(malformed.json()).resolves.toMatchObject({
      code: "invalid_root_policy",
    });
    expect(malformed.status).toBe(403);

    const mismatch = await onRequest({
      request: createResolveRequest(
        createInvokeBody("nd", childDropId, rootDropId, "OtherRoot5566"),
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    await expect(mismatch.json()).resolves.toMatchObject({
      code: "caller_mismatch",
    });
    expect(mismatch.status).toBe(400);
  });

  it("rejects invalid invoke requests", async () => {
    const bucket = createSeededBucket();

    const response = await onRequest({
      request: createResolveRequest({ call: { pluginId: "nd" } }),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as { code: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_failed");
  });
});
