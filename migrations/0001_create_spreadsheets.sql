CREATE TABLE IF NOT EXISTS spreadsheets (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  agent_name TEXT NOT NULL UNIQUE,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_spreadsheets_uploaded_at
  ON spreadsheets (uploaded_at DESC);
