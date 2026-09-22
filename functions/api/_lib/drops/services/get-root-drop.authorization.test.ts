import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest, onRequestGet } from "../../../get/[id]";
import { createRemoteAliasKey } from "../identity/id";
import type {
  SqlBindableValue,
  SqlStatement,
  SqlMetadataStore,
} from "../../../../../src/server/ports";

interface ProjectionRow {
  entry_seq: number;
  drop_id: string;
  account_id: string;
  visibility: unknown;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

class RootReadBucket {
  private readonly objects = new Map<
    string,
    { value: string; contentType: string; etag: string }
  >();
  rootGets = 0;
  rootBodyAccesses = 0;
  aliasGets = 0;
  failure: Error | null = null;

  seed(
    key: string,
    value: string,
    contentType = "application/json",
    etag = '"root-read-etag"',
  ): void {
    this.objects.set(key, { value, contentType, etag });
  }

  async get(key: string): Promise<any> {
    if (this.failure) throw this.failure;
    const alias = key.startsWith("__drop_alias__/");
    if (alias) this.aliasGets += 1;
    else this.rootGets += 1;
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bucket = this;
    return {
      key,
      httpEtag: stored.etag,
      httpMetadata: {
        contentType: stored.contentType,
        cacheControl: "public, max-age=60",
      },
      get body() {
        if (!alias) bucket.rootBodyAccesses += 1;
        return new Response(stored.value).body;
      },
      text: async () => stored.value,
      json: async <T>() => JSON.parse(stored.value) as T,
    };
  }
}

class RootReadDatabase implements SqlMetadataStore {
  runs = 0;
  aliasReads = 0;

  constructor(
    private readonly rows = new Map<string, ProjectionRow>(),
    private readonly aliases = new Map<string, string>(),
  ) {}

  prepare(sql: string): SqlStatement {
    let values: SqlBindableValue[] = [];
    const statement: SqlStatement = {
      bind: (...bound) => {
        values = bound;
        return statement;
      },
      run: async () => {
        this.runs += 1;
        return { success: true };
      },
      first: async <T>() => {
        if (sql.includes("FROM drop_aliases")) {
          this.aliasReads += 1;
          const id = this.aliases.get(String(values[0]));
          return id ? ({ full_id: id } as T) : null;
        }
        if (sql.includes("FROM account_library_entries")) {
          return (this.rows.get(String(values[0])) as T | undefined) ?? null;
        }
        return null;
      },
      all: async <T>() => ({ results: [] as T[] }),
    };
    return statement;
  }
}

const projection = (
  id: string,
  visibility: unknown,
  owner = "canonical-owner",
  deletedAt: number | null = null,
): ProjectionRow => ({
  entry_seq: 1,
  drop_id: id,
  account_id: owner,
  visibility,
  created_at: 1,
  updated_at: 1,
  deleted_at: deletedAt,
});

const callGet = (
  bucket: RootReadBucket,
  id: string,
  options: {
    db?: SqlMetadataStore;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  } = {},
): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request(`https://nulldown.test/api/get/${id}`, {
        headers: options.headers,
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: options.db,
        ...options.env,
      },
      params: { id },
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

describe("GET root-object read authorization", () => {
  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(["public", "unlisted"] as const)(
    "streams projected %s roots anonymously with compatible metadata",
    async (visibility) => {
      const id = visibility === "public" ? "GetPublic001" : "GetUnlist001";
      const bucket = new RootReadBucket();
      const body = JSON.stringify({ content: `${visibility} body` });
      bucket.seed(id, body);
      const db = new RootReadDatabase(
        new Map([[id, projection(id, visibility)]]),
      );

      const response = await callGet(bucket, id, { db });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
      expect(response.headers.get("ETag")).toBe('"root-read-etag"');
      expect(response.headers.get("X-Drop-Revision")).toBe('"root-read-etag"');
      expect(response.headers.get("X-Drop-Canonical-Id")).toBe(id);
      await expect(response.text()).resolves.toBe(body);
      expect(bucket.rootBodyAccesses).toBe(1);
    },
  );

  it("preserves anonymous identifier reads when the projection or DB is absent", async () => {
    for (const db of [new RootReadDatabase(), undefined]) {
      const id = db ? "GetNoProj001" : "GetNoDb00001";
      const bucket = new RootReadBucket();
      bucket.seed(id, "legacy plaintext", "text/plain");
      const response = await callGet(bucket, id, { db });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("legacy plaintext");
    }
  });

  it("allows only the canonical projected owner for a private root", async () => {
    const id = "GetPrivate01";
    const actors = [
      ["owner", "canonical-owner", 200],
      ["anonymous", null, 404],
      ["unrelated", "unrelated-account", 404],
      ["writer-only", "branch-writer", 404],
    ] as const;

    for (const [, accountId, status] of actors) {
      const bucket = new RootReadBucket();
      bucket.seed(id, "private body", "text/plain");
      const db = new RootReadDatabase(
        new Map([[id, projection(id, "private")]]),
      );
      const response = await callGet(bucket, id, {
        db,
        headers: accountId ? { "x-nulldown-account-id": accountId } : undefined,
        env: { ALLOW_INSECURE_ACCOUNT_HEADER: "1" },
      });
      expect(response.status).toBe(status);
      if (status === 404) {
        await expect(response.text()).resolves.toBe("Drop not found.");
        expect(bucket.rootGets).toBe(0);
        expect(bucket.rootBodyAccesses).toBe(0);
      }
    }
  });

  it.each(["public", "unlisted", "private"])(
    "denies tombstoned %s roots before object access",
    async (visibility) => {
      const id = `GetTomb${visibility.slice(0, 3)}1`;
      const bucket = new RootReadBucket();
      bucket.seed(id, "must not read");
      const db = new RootReadDatabase(
        new Map([[id, projection(id, visibility, "canonical-owner", 2)]]),
      );
      const response = await callGet(bucket, id, {
        db,
        headers: { "x-nulldown-account-id": "canonical-owner" },
        env: { ALLOW_INSECURE_ACCOUNT_HEADER: "1" },
      });
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Drop not found.");
      expect(bucket.rootGets).toBe(0);
      expect(bucket.rootBodyAccesses).toBe(0);
    },
  );

  it("denies malformed visibility and an invalid bearer without fallback", async () => {
    for (const [id, visibility, headers] of [
      ["GetBadVis001", "friends", {}],
      [
        "GetBadBear01",
        "private",
        {
          Authorization: "bEaReR invalid",
          "x-nulldown-account-id": "canonical-owner",
        },
      ],
    ] as const) {
      const bucket = new RootReadBucket();
      bucket.seed(id, "must not read");
      const db = new RootReadDatabase(
        new Map([[id, projection(id, visibility)]]),
      );
      const response = await callGet(bucket, id, {
        db,
        headers,
        env: {
          ACCOUNT_AUTH_SECRET: "root-read-secret",
          ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        },
      });
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Drop not found.");
      expect(bucket.rootGets).toBe(0);
    }
  });

  it("resolves an R2-only short alias without a SQL write", async () => {
    const shortId = "GetR21";
    const fullId = "GetR21Full01";
    const bucket = new RootReadBucket();
    bucket.seed(createRemoteAliasKey(shortId), fullId, "text/plain");
    bucket.seed(fullId, "aliased body", "text/plain");
    const db = new RootReadDatabase(
      new Map([[fullId, projection(fullId, "unlisted")]]),
    );
    const response = await callGet(bucket, shortId, { db });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Drop-Canonical-Id")).toBe(fullId);
    expect(db.aliasReads).toBe(1);
    expect(db.runs).toBe(0);
    expect(bucket.aliasGets).toBe(1);
  });

  it("preserves invalid ID, absent object, and method responses", async () => {
    const invalid = await callGet(new RootReadBucket(), "bad id");
    expect(invalid.status).toBe(400);
    await expect(invalid.text()).resolves.toBe("Drop ID is required.");

    const missing = await callGet(new RootReadBucket(), "GetMissing01");
    expect(missing.status).toBe(404);
    await expect(missing.text()).resolves.toBe("Drop not found.");

    const method = await onRequest({
      request: new Request("https://nulldown.test/api/get/GetMissing01", {
        method: "POST",
      }),
      env: { R2_BUCKET: new RootReadBucket() as unknown as R2Bucket },
      params: { id: "GetMissing01" },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(method.status).toBe(405);
    await expect(method.text()).resolves.toBe("Method Not Allowed");
  });

  it("redacts unexpected failures", async () => {
    const bucket = new RootReadBucket();
    bucket.failure = new Error("storage-secret-detail");
    const response = await callGet(bucket, "GetFailure01");
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe("Failed to retrieve drop.");
    expect(body).not.toContain("storage-secret-detail");
  });
});
