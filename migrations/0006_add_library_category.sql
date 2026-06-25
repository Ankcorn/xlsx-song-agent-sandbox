ALTER TABLE spreadsheets
  ADD COLUMN category TEXT NOT NULL DEFAULT 'Uncategorised';

CREATE INDEX IF NOT EXISTS idx_spreadsheets_category_updated_at
  ON spreadsheets (category, updated_at DESC);
