import { describe, it, expect } from "@jest/globals";
import {
  SearchDatabase,
  createSearchDatabase,
  type SearchDatabaseStore,
} from "./searchDatabase";

class MemorySearchDb {
  private rows: Map<string, Record<string, unknown>> = new Map();

  prepare(sql: string) {
    const self = this;
    let params: unknown[] = [];

    return {
      bind(...values: unknown[]) {
        params = values;
        return this;
      },
      async run() {
        if (sql.includes("INSERT INTO search_index") || sql.includes("ON CONFLICT")) {
          const id = String(params[0]);
          self.rows.set(id, {
            id: params[0],
            drop_id: params[1],
            title: params[2] ?? null,
            content_preview: params[3] ?? null,
            content_hash: params[4] ?? null,
            owner_account_id: params[5] ?? null,
            visibility: params[6] ?? "unlisted",
            created_at: params[7] ?? 0,
            updated_at: params[8] ?? 0,
            metadata: params[9] ?? null,
          });
        }
        if (sql.includes("DELETE FROM search_index")) {
          self.rows.delete(String(params[0]));
        }
        return { success: true };
      },
      async first<T = Record<string, unknown>>() {
        // For COUNT queries
        if (sql.includes("COUNT(*)")) {
          const matches = self.matchRows(sql, params);
          return { total: matches.length } as unknown as T;
        }
        // For single row queries
        for (const [, row] of self.rows) {
          return row as unknown as T;
        }
        return null;
      },
      async all<T = Record<string, unknown>>() {
        const matches = self.matchRows(sql, params);
        return { results: matches as T[] };
      },
    };
  }

  private matchRows(_sql: string, params: unknown[]): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    const visibilityFilter = params.filter((p) => typeof p === "string" && (p === "public" || p === "unlisted"));
    const ownerFilter = params.filter((p) => typeof p === "string" && p.length > 0 && p !== "public" && p !== "unlisted" && !String(p).startsWith("%"));
    const limitIdx = params.findIndex((p) => typeof p === "number");
    let offset = 0;
    let limit = 50;

    if (limitIdx >= 0) {
      limit = Number(params[limitIdx]);
      if (limitIdx + 1 < params.length) offset = Number(params[limitIdx + 1]) || 0;
    }

    for (const [, row] of this.rows) {
      let match = true;
      // LIKE filters
      for (let i = 0; i < params.length; i++) {
        const p = String(params[i]);
        if (p.startsWith("%") && p.endsWith("%")) {
          const term = p.slice(1, -1).toLowerCase();
          const title = String(row.title ?? "").toLowerCase();
          const preview = String(row.content_preview ?? "").toLowerCase();
          if (!title.includes(term) && !preview.includes(term)) {
            match = false;
          }
        }
      }
      if (match && visibilityFilter.length > 0) {
        if (!visibilityFilter.includes(String(row.visibility))) match = false;
      }
      if (match && ownerFilter.length > 0) {
        if (!ownerFilter.includes(String(row.owner_account_id ?? ""))) match = false;
      }
      if (match) results.push(row);
    }

    results.sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0));
    return results.slice(offset, offset + limit);
  }
}

function createTestDb(): SearchDatabaseStore {
  return new MemorySearchDb() as unknown as SearchDatabaseStore;
}

describe("SearchDatabase", () => {
  let db: SearchDatabase;

  beforeEach(() => {
    db = createSearchDatabase(createTestDb());
  });

  it("indexes a record and retrieves it by drop ID", async () => {
    await db.index({
      id: "idx-1",
      dropId: "drop-abc",
      title: "Test Strategy",
      contentPreview: "This is a test strategy document about onboarding",
      contentHash: null,
      ownerAccountId: null,
      visibility: "public",
      createdAt: 1000,
      updatedAt: 2000,
      metadata: null,
    });

    const found = await db.getByDropId("drop-abc");
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Test Strategy");
    expect(found!.visibility).toBe("public");
  });

  it("searches by content match", async () => {
    await db.index({
      id: "idx-1",
      dropId: "drop-1",
      title: "Onboarding Router",
      contentPreview: "Routes users through onboarding flows",
      contentHash: null,
      ownerAccountId: null,
      visibility: "public",
      createdAt: 1000,
      updatedAt: 1000,
      metadata: null,
    });

    await db.index({
      id: "idx-2",
      dropId: "drop-2",
      title: "Benchmarking",
      contentPreview: "Performance benchmarking and profiling",
      contentHash: null,
      ownerAccountId: null,
      visibility: "public",
      createdAt: 2000,
      updatedAt: 2000,
      metadata: null,
    });

    const result = await db.search({ query: "onboarding" });
    expect(result.records.length).toBe(1);
    expect(result.records[0].dropId).toBe("drop-1");
  });

  it("searches by title match", async () => {
    await db.index({
      id: "idx-1",
      dropId: "drop-1",
      title: "MCP Quickstart Strategy",
      contentPreview: "Getting started with MCP tools",
      contentHash: null,
      ownerAccountId: null,
      visibility: "public",
      createdAt: 1000,
      updatedAt: 1000,
      metadata: null,
    });

    const result = await db.search({ query: "mcp" });
    expect(result.records.length).toBe(1);
  });

  it("handles multi-word queries as AND", async () => {
    await db.index({
      id: "idx-1",
      dropId: "drop-1",
      title: "Onboarding Router",
      contentPreview: "Routes users through onboarding flows",
      contentHash: null,
      ownerAccountId: null,
      visibility: "public",
      createdAt: 1000,
      updatedAt: 1000,
      metadata: null,
    });

    await db.index({
      id: "idx-2",
      dropId: "drop-2",
      title: "Codebase Onboarding",
      contentPreview: "Onboarding developers to codebase",
      contentHash: null,
      ownerAccountId: null,
      visibility: "public",
      createdAt: 2000,
      updatedAt: 2000,
      metadata: null,
    });

    const result = await db.search({ query: "onboarding router" });
    expect(result.records.length).toBe(1);
    expect(result.records[0].dropId).toBe("drop-1");
  });

  it("returns all records when query is empty", async () => {
    await db.index({
      id: "idx-1",
      dropId: "drop-1",
      title: "Strategy",
      contentPreview: "Preview",
      contentHash: null,
      ownerAccountId: null,
      visibility: "public",
      createdAt: 1000,
      updatedAt: 1000,
      metadata: null,
    });

    const result = await db.search({ query: "" });
    expect(result.records.length).toBe(1);
  });

  it("removes a record", async () => {
    await db.index({
      id: "idx-1",
      dropId: "drop-1",
      title: "Test",
      contentPreview: "Test",
      contentHash: null,
      ownerAccountId: null,
      visibility: "public",
      createdAt: 1000,
      updatedAt: 1000,
      metadata: null,
    });

    await db.remove("idx-1");

    const result = await db.search({ query: "test" });
    expect(result.records.length).toBe(0);
  });

  it("upserts on duplicate index ID", async () => {
    await db.index({
      id: "idx-1",
      dropId: "drop-1",
      title: "Old Title",
      contentPreview: "Old preview",
      contentHash: null,
      ownerAccountId: null,
      visibility: "public",
      createdAt: 1000,
      updatedAt: 1000,
      metadata: null,
    });

    await db.index({
      id: "idx-1",
      dropId: "drop-1",
      title: "New Title",
      contentPreview: "New preview",
      contentHash: null,
      ownerAccountId: null,
      visibility: "public",
      createdAt: 1000,
      updatedAt: 2000,
      metadata: null,
    });

    const result = await db.search({ query: "new" });
    expect(result.records.length).toBe(1);
    expect(result.records[0].title).toBe("New Title");
  });
});

describe("createSearchDatabase", () => {
  it("creates a SearchDatabase instance", () => {
    const db = createSearchDatabase(createTestDb());
    expect(db).toBeInstanceOf(SearchDatabase);
  });
});
