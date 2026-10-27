PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, subagentTypeName TEXT, value TEXT);
CREATE INDEX idx_composerHeaders_0 ON composerHeaders (workspaceId, isSubagent, isArchived, recency);
CREATE INDEX idx_composerHeaders_1 ON composerHeaders (recency, composerId);
