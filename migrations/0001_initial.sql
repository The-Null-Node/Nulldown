-- Initial schema for Nulldown search indexing
-- This enables full-text search across drops and drafts

CREATE TABLE IF NOT EXISTS search_index (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL,
  title TEXT,
  content_preview TEXT,
  content_hash TEXT,
  owner_account_id TEXT,
  visibility TEXT DEFAULT 'unlisted',
  created_at INTEGER,
  updated_at INTEGER,
  metadata TEXT -- JSON blob for extensibility
);

-- Full-text search virtual table using FTS5
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title,
  content_preview,
  content='search_index',
  content_rowid='id'
);

-- Trigger to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS search_index_insert AFTER INSERT ON search_index BEGIN
  INSERT INTO search_fts(rowid, title, content_preview)
  VALUES (new.id, new.title, new.content_preview);
END;

CREATE TRIGGER IF NOT EXISTS search_index_delete AFTER DELETE ON search_index BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, content_preview)
  VALUES ('delete', old.id, old.title, old.content_preview);
END;

CREATE TRIGGER IF NOT EXISTS search_index_update AFTER UPDATE ON search_index BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, content_preview)
  VALUES ('delete', old.id, old.title, old.content_preview);
  INSERT INTO search_fts(rowid, title, content_preview)
  VALUES (new.id, new.title, new.content_preview);
END;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_search_owner ON search_index(owner_account_id);
CREATE INDEX IF NOT EXISTS idx_search_visibility ON search_index(visibility);
CREATE INDEX IF NOT EXISTS idx_search_updated ON search_index(updated_at);
