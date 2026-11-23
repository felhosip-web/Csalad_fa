-- Családfa SQLite Schema (v2)
-- Foreign keys must also be enabled per connection: PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tree_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persons (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
    birth_name TEXT NOT NULL DEFAULT '',
    gender TEXT NOT NULL DEFAULT 'unknown'
        CHECK (gender IN ('male', 'female', 'other', 'unknown')),
    birth_date TEXT NOT NULL DEFAULT '',
    death_date TEXT NOT NULL DEFAULT '',
    is_living INTEGER NOT NULL DEFAULT 1 CHECK (is_living IN (0, 1)),
    avatar_path TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS unions (
    id TEXT PRIMARY KEY,
    partner1_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    partner2_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'married'
        CHECK (status IN ('married', 'divorced', 'partner', 'widowed', 'separated', 'unknown')),
    start_date TEXT NOT NULL DEFAULT '',
    end_date TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (partner2_id IS NULL OR partner1_id != partner2_id)
);

CREATE TABLE IF NOT EXISTS parent_child (
    child_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    union_id TEXT REFERENCES unions(id) ON DELETE SET NULL,
    relation_type TEXT NOT NULL DEFAULT 'biological'
        CHECK (relation_type IN ('biological', 'adoptive', 'step', 'foster', 'guardian')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (child_id, parent_id),
    CHECK (child_id != parent_id)
);

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL DEFAULT 'document'
        CHECK (source_type IN ('registry', 'photo', 'oral_history', 'document', 'other')),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    reference TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_sources (
    person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    citation_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (person_id, source_id)
);

-- Indexes for fast genealogy traversal & search
CREATE INDEX IF NOT EXISTS idx_persons_full_name
    ON persons(full_name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_persons_birth_name
    ON persons(birth_name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_persons_is_living
    ON persons(is_living);

CREATE INDEX IF NOT EXISTS idx_unions_partner1
    ON unions(partner1_id);

CREATE INDEX IF NOT EXISTS idx_unions_partner2
    ON unions(partner2_id);

CREATE INDEX IF NOT EXISTS idx_unions_status
    ON unions(status);

CREATE INDEX IF NOT EXISTS idx_parent_child_child
    ON parent_child(child_id);

CREATE INDEX IF NOT EXISTS idx_parent_child_parent
    ON parent_child(parent_id);

CREATE INDEX IF NOT EXISTS idx_parent_child_union
    ON parent_child(union_id);

CREATE INDEX IF NOT EXISTS idx_sources_type
    ON sources(source_type);

CREATE INDEX IF NOT EXISTS idx_sources_title
    ON sources(title COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_person_sources_person
    ON person_sources(person_id);

CREATE INDEX IF NOT EXISTS idx_person_sources_source
    ON person_sources(source_id);

