import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../functions/api/nullplug/resolve";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../shared/drop/branch";
import {
  NULLPLUG_INVOKE_CONTENT_TYPE,
  remoteNullplugLatestKey,
} from "../shared/nullplug/registry";
import { createBranchKey } from "../functions/api/_lib/branches/storage/keys";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();
  getCalls = 0;

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
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
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
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    await expect(forbidden.json()).resolves.toMatchObject({
      code: "caller_branch_forbidden",
    });
    expect(forbidden.status).toBe(403);
  });

  it("rejects unsupported plugins instead of resolving remote code", async () => {
    const bucket = createSeededBucket();
    seedRootRuntimePolicy(bucket, {
      version: 1,
      nullplugs: { "remote-plugin": { invoke: "allow" } },
    });

    const response = await onRequest({
      request: createResolveRequest(createInvokeBody("remote-plugin")),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
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
      expect(String(input)).toBe(
        "https://plugins.nulldown.test/summary",
      );
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
        createInvokeBody(
          "remote.summary",
          childDropId,
          rootDropId,
          undefined,
          ["render", "drop.read", "null.call"],
        ),
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
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
    body.call.caller = {};
    body.context.rootPolicyRef = rootDropId;

    const response = await onRequest({
      request: createResolveRequest(body),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
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
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
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
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
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
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
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
