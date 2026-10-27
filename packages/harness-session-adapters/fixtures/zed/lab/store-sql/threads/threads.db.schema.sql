CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data_type TEXT NOT NULL,
    data BLOB NOT NULL
, parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT);
