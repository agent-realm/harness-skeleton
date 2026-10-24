-- cursor-agent 2026.10.19 store.db, from ../cursor-sdk-local-runtime/dist/run-store/sqlite-blob-store.js (source)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB);   -- id = hex(sha256(data)); written with INSERT OR REPLACE
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);  -- only key "0": hex(utf8(JSON metadata)); INSERT OR REPLACE
