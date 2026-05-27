import type { D1Database } from "@cloudflare/workers-types";

export interface SearchIndexRecord {
  id: string;
  dropId: string;
  title: string | null;
  contentPreview: string | null;
  contentHash: string | null;
  ownerAccountId: string | null;
  visibility: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown> | null;
}

export interface SearchQuery {
  query: string;
  ownerAccountId?: string | null;
  visibility?: string[];
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  records: SearchIndexRecord[];
  total: number;
}

export class SearchDatabase {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async index(record: SearchIndexRecord): Promise<void> {
    const metadataJson = record.metadata
      ? JSON.stringify(record.metadata)
      : null;

    await this.db
      .prepare(
        `INSERT INTO search_index (id, drop_id, title, content_preview, content_hash, owner_account_id, visibility, created_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           content_preview = excluded.content_preview,
           content_hash = excluded.content_hash,
           owner_account_id = excluded.owner_account_id,
           visibility = excluded.visibility,
           updated_at = excluded.updated_at,
           metadata = excluded.metadata`,
      )
      .bind(
        record.id,
        record.dropId,
        record.title,
        record.contentPreview,
        record.contentHash,
        record.ownerAccountId,
        record.visibility,
        record.createdAt,
        record.updatedAt,
        metadataJson,
      )
      .run();
  }

  async remove(id: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM search_index WHERE id = ?")
      .bind(id)
      .run();
  }

  async search(options: SearchQuery): Promise<SearchResult> {
    const {
      query,
      ownerAccountId,
      visibility,
      limit = 50,
      offset = 0,
    } = options;

    if (!query.trim()) {
      return this.listAll({ ownerAccountId, visibility, limit, offset });
    }

    // Use FTS5 for full-text search
    const ftsQuery = query
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .map((term) => `${term}*`)
      .join(" ");

    let sql = `
      SELECT si.* FROM search_index si
      INNER JOIN search_fts fts ON fts.rowid = si.id
      WHERE search_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (ownerAccountId !== undefined && ownerAccountId !== null) {
      sql += " AND si.owner_account_id = ?";
      params.push(ownerAccountId);
    }

    if (visibility && visibility.length > 0) {
      sql += ` AND si.visibility IN (${visibility.map(() => "?").join(", ")})`;
      params.push(...visibility);
    }

    sql += " ORDER BY si.updated_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const { results } = await this.db
      .prepare(sql)
      .bind(...params)
      .all();

    // Get total count
    let countSql = `
      SELECT COUNT(*) as total FROM search_index si
      INNER JOIN search_fts fts ON fts.rowid = si.id
      WHERE search_fts MATCH ?
    `;
    const countParams: (string | number)[] = [ftsQuery];

    if (ownerAccountId !== undefined && ownerAccountId !== null) {
      countSql += " AND si.owner_account_id = ?";
      countParams.push(ownerAccountId);
    }

    if (visibility && visibility.length > 0) {
      countSql += ` AND si.visibility IN (${visibility.map(() => "?").join(", ")})`;
      countParams.push(...visibility);
    }

    const countResult = await this.db
      .prepare(countSql)
      .bind(...countParams)
      .first();
    const total = countResult ? (countResult.total as number) : 0;

    return {
      records: (results || []).map(this.mapRowToRecord),
      total,
    };
  }

  async listAll(options: {
    ownerAccountId?: string | null;
    visibility?: string[];
    limit?: number;
    offset?: number;
  }): Promise<SearchResult> {
    const { ownerAccountId, visibility, limit = 50, offset = 0 } = options;

    let sql = "SELECT * FROM search_index WHERE 1=1";
    const params: (string | number)[] = [];

    if (ownerAccountId !== undefined && ownerAccountId !== null) {
      sql += " AND owner_account_id = ?";
      params.push(ownerAccountId);
    }

    if (visibility && visibility.length > 0) {
      sql += ` AND visibility IN (${visibility.map(() => "?").join(", ")})`;
      params.push(...visibility);
    }

    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const { results } = await this.db
      .prepare(sql)
      .bind(...params)
      .all();

    let countSql = "SELECT COUNT(*) as total FROM search_index WHERE 1=1";
    const countParams: (string | number)[] = [];

    if (ownerAccountId !== undefined && ownerAccountId !== null) {
      countSql += " AND owner_account_id = ?";
      countParams.push(ownerAccountId);
    }

    if (visibility && visibility.length > 0) {
      countSql += ` AND visibility IN (${visibility.map(() => "?").join(", ")})`;
      countParams.push(...visibility);
    }

    const countResult = await this.db
      .prepare(countSql)
      .bind(...countParams)
      .first();
    const total = countResult ? (countResult.total as number) : 0;

    return {
      records: (results || []).map(this.mapRowToRecord),
      total,
    };
  }

  async getByDropId(dropId: string): Promise<SearchIndexRecord | null> {
    const result = await this.db
      .prepare("SELECT * FROM search_index WHERE drop_id = ?")
      .bind(dropId)
      .first();

    if (!result) return null;
    return this.mapRowToRecord(result);
  }

  private mapRowToRecord(row: Record<string, unknown>): SearchIndexRecord {
    return {
      id: String(row.id),
      dropId: String(row.drop_id),
      title: row.title ? String(row.title) : null,
      contentPreview: row.content_preview ? String(row.content_preview) : null,
      contentHash: row.content_hash ? String(row.content_hash) : null,
      ownerAccountId: row.owner_account_id
        ? String(row.owner_account_id)
        : null,
      visibility: String(row.visibility || "unlisted"),
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      metadata: row.metadata ? JSON.parse(String(row.metadata)) : null,
    };
  }
}

export function createSearchDatabase(db: D1Database): SearchDatabase {
  return new SearchDatabase(db);
}
