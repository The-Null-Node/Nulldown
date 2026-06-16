-- Drop broken FTS5 virtual table and its triggers.
-- search_fts had content_rowid='id' but search_index.id is TEXT,
-- not INTEGER. The triggers would fail on INSERT.
-- Replace with LIKE-based search in the application layer.

DROP TRIGGER IF EXISTS search_index_insert;
DROP TRIGGER IF EXISTS search_index_delete;
DROP TRIGGER IF EXISTS search_index_update;
DROP TABLE IF EXISTS search_fts;
