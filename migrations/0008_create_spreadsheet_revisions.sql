CREATE TABLE IF NOT EXISTS spreadsheet_revisions (
  id TEXT PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  action TEXT NOT NULL,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(spreadsheet_id, revision_number),
  FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_spreadsheet_revisions_spreadsheet_id
  ON spreadsheet_revisions (spreadsheet_id, revision_number DESC);
