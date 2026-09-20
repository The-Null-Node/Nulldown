import { describe, expect, it } from "@jest/globals";
import { onRequestGet } from "../functions/api/search";

interface SearchRow {
  id: string;
  drop_id: string;
  title: string | null;
  content_preview: string | null;
  content_hash: string | null;
  owner_account_id: string | null;
  visibility: string;
  created_at: number;
  updated_at: number;
  metadata: string | null;
}

const rows: SearchRow[] = [
  {
    id: "idx-public-alice",
    drop_id: "drop-public-alice",
    title: "Needle public",
    content_preview: "Visible result",
    content_hash: "hash-public-alice",
    owner_account_id: "alice",
    visibility: "public",
    created_at: 10,
    updated_at: 50,
    metadata: '{"kind":"public"}',
  },
  {
    id: "idx-public-bob",
    drop_id: "drop-public-bob",
    title: "Public second",
    content_preview: "Visible result",
    content_hash: null,
    owner_account_id: "bob",
    visibility: "public",
    created_at: 20,
    updated_at: 40,
    metadata: null,
  },
  {
    id: "idx-public-third",
    drop_id: "drop-public-third",
    title: "Public third",
    content_preview: "Visible result",
    content_hash: null,
    owner_account_id: null,
    visibility: "public",
    created_at: 30,
    updated_at: 30,
    metadata: null,
  },
  {
    id: "idx-unlisted",
    drop_id: "drop-unlisted",
    title: "Needle unlisted",
    content_preview: "Sensitive preview",
    content_hash: null,
    owner_account_id: "alice",
    visibility: "unlisted",
    created_at: 40,
    updated_at: 60,
    metadata: null,
  },
  {
    id: "idx-private",
    drop_id: "drop-private",
    title: "Needle private",
    content_preview: "Sensitive preview",
    content_hash: null,
    owner_account_id: "alice",
    visibility: "private",
    created_at: 50,
    updated_at: 70,
    metadata: null,
  },
];

class SearchD1Fake {
  readonly executedSql: string[] = [];

  prepare(sql: string) {
    let params: unknown[] = [];

    return {
      bind: (...values: unknown[]) => {
        params = values;
        return {
          all: async () => ({ results: this.execute(sql, params, true) }),
          first: async () => ({ total: this.execute(sql, params, false).length }),
        };
      },
    };
  }

  private execute(sql: string, params: unknown[], paginate: boolean): SearchRow[] {
    this.executedSql.push(sql);
    let paramIndex = 0;
    let matches = [...rows];
    const likeCount = (sql.match(/LIKE \?/g) || []).length / 2;

    for (let index = 0; index < likeCount; index += 1) {
      const term = String(params[paramIndex]).slice(1, -1).toLowerCase();
      paramIndex += 2;
      matches = matches.filter((row) =>
        `${row.title || ""}\n${row.content_preview || ""}`.toLowerCase().includes(term),
      );
    }

    if (sql.includes("owner_account_id = ?")) {
      const owner = String(params[paramIndex]);
      paramIndex += 1;
      matches = matches.filter((row) => row.owner_account_id === owner);
    }

    const visibilityClause = sql.match(/visibility IN \(([^)]*)\)/);
    if (visibilityClause) {
      const visibilityCount = (visibilityClause[1].match(/\?/g) || []).length;
      const visibilities = params
        .slice(paramIndex, paramIndex + visibilityCount)
        .map(String);
      paramIndex += visibilityCount;
      matches = matches.filter((row) => visibilities.includes(row.visibility));
    }

    matches.sort((left, right) => right.updated_at - left.updated_at);
    if (!paginate) return matches;

    const limit = Number(params[paramIndex]);
    const offset = Number(params[paramIndex + 1]);
    return matches.slice(offset, offset + limit);
  }
}

const search = async (query: string, db = new SearchD1Fake()) => {
  const response = await onRequestGet({
    request: new Request(`https://nulldown.test/api/search${query}`),
    env: { DB: db as unknown as D1Database, LOG_LEVEL: "error" },
  } as unknown as Parameters<typeof onRequestGet>[0]);
  const body = (await response.json()) as {
    records: Array<Record<string, unknown>>;
    total: number;
    query: string;
    limit: number;
    offset: number;
  };
  return { response, body, db };
};

describe("GET /api/search public contracts", () => {
  it("returns and counts only public rows for an empty paginated search", async () => {
    const { response, body, db } = await search("?limit=1&offset=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body).toEqual({
      records: [
        {
          id: "idx-public-bob",
          dropId: "drop-public-bob",
          title: "Public second",
          contentPreview: "Visible result",
          contentHash: null,
          ownerAccountId: "bob",
          visibility: "public",
          createdAt: 20,
          updatedAt: 40,
          metadata: null,
        },
      ],
      total: 3,
      query: "",
      limit: 1,
      offset: 1,
    });
    expect(db.executedSql).toHaveLength(2);
    expect(db.executedSql.every((sql) => sql.includes("visibility IN (?)"))).toBe(true);
    expect(db.executedSql.some((sql) => sql.includes("COUNT(*)"))).toBe(true);
  });

  it("does not discover matching unlisted or private previews", async () => {
    const { body, db } = await search("?q=needle");

    expect(body.records.map((record) => record.dropId)).toEqual(["drop-public-alice"]);
    expect(body.total).toBe(1);
    expect(db.executedSql).toHaveLength(2);
    expect(db.executedSql.every((sql) => sql.includes("LIKE ?"))).toBe(true);
  });

  it.each(["unlisted", "private", "public,unlisted,private"])(
    "accepts but ignores visibility=%s",
    async (visibility) => {
      const { response, body } = await search(`?q=needle&visibility=${visibility}`);

      expect(response.status).toBe(200);
      expect(body.records.map((record) => record.dropId)).toEqual(["drop-public-alice"]);
      expect(body.total).toBe(1);
    },
  );

  it("intersects the owner filter with public visibility", async () => {
    const { body } = await search("?owner=alice");

    expect(body.records.map((record) => record.dropId)).toEqual(["drop-public-alice"]);
    expect(body.total).toBe(1);
  });

  it("keeps the missing database response at 500", async () => {
    const response = await onRequestGet({
      request: new Request("https://nulldown.test/api/search"),
      env: { LOG_LEVEL: "error" },
    } as unknown as Parameters<typeof onRequestGet>[0]);

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("Database binding is required.");
  });
});
