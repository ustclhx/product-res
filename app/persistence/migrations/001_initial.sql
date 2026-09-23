CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES (1);
CREATE TABLE entities (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL,
 project_id TEXT REFERENCES entities(id),
 candidate_id TEXT REFERENCES entities(id),
 version INTEGER NOT NULL CHECK(version > 0),
 created_at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE INDEX entity_scope ON entities(kind,project_id,candidate_id);
CREATE TABLE receipts (
 scope TEXT PRIMARY KEY,
 payload_hash TEXT NOT NULL,
 response TEXT NOT NULL CHECK(json_valid(response))
);
CREATE TABLE audit (
 id TEXT PRIMARY KEY,
 actor_id TEXT NOT NULL,
 action TEXT NOT NULL,
 entity_id TEXT,
 created_at TEXT NOT NULL,
 details TEXT NOT NULL CHECK(json_valid(details))
);
