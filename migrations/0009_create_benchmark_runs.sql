CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  error TEXT,
  model_provider TEXT,
  model_name TEXT,
  spreadsheet_id TEXT NOT NULL,
  spreadsheet_filename TEXT,
  request_id TEXT,
  finish_reason TEXT,
  answer_seconds REAL NOT NULL DEFAULT 0,
  total_seconds REAL NOT NULL DEFAULT 0,
  upload_seconds REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  quality INTEGER,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_created_at
  ON benchmark_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model
  ON benchmark_runs (model_provider, model_name);
