PRAGMA journal_mode=WAL;
CREATE TABLE sidebar_threads (thread_id BLOB PRIMARY KEY, session_id TEXT, agent_id TEXT, title TEXT NOT NULL, updated_at TEXT NOT NULL, created_at TEXT, folder_paths TEXT, folder_paths_order TEXT, archived INTEGER DEFAULT 0) STRICT;
