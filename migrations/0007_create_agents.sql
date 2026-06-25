CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ready',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS agent_sheets (
  agent_id TEXT NOT NULL,
  spreadsheet_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (agent_id, spreadsheet_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agents_updated_at
  ON agents (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_sheets_spreadsheet_id
  ON agent_sheets (spreadsheet_id);
