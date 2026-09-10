CREATE TABLE IF NOT EXISTS _clarity_legacy_imports (
  source_sha256 TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_size BIGINT NOT NULL CHECK (source_size >= 0),
  imported_rows INTEGER NOT NULL CHECK (imported_rows >= 0),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
