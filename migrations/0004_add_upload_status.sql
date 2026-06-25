ALTER TABLE spreadsheets
  ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';

ALTER TABLE spreadsheets
  ADD COLUMN error_message TEXT;

ALTER TABLE spreadsheets
  ADD COLUMN updated_at TEXT;

UPDATE spreadsheets
  SET updated_at = COALESCE(updated_at, uploaded_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE INDEX IF NOT EXISTS idx_spreadsheets_status_updated_at
  ON spreadsheets (status, updated_at DESC);
