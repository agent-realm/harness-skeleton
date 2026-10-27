PRAGMA journal_mode=WAL;
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', user_set_name BOOLEAN DEFAULT FALSE,
  session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  extension_data TEXT DEFAULT '{}', total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER,
  accumulated_cache_write_tokens INTEGER, accumulated_cost REAL, schedule_id TEXT, recipe_json TEXT, user_recipe_values_json TEXT, provider_name TEXT,
  model_config_json TEXT, goose_mode TEXT NOT NULL DEFAULT 'auto', archived_at TIMESTAMP, project_id TEXT, parent_session_id TEXT,
  system_prompt_override TEXT, system_prompt_extras_json TEXT, container_id TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
  content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER, metadata_json TEXT);
CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_timestamp INTEGER NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_session_created ON messages(session_id, created_timestamp, id);
CREATE INDEX idx_usage_ledger_session ON usage_ledger(session_id);
