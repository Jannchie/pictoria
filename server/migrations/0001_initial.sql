-- Pictoria initial schema (SQLite + sqlite-vec).
--
-- Conventions:
--   * Timestamps are TEXT (ISO 8601, "YYYY-MM-DD HH:MM:SS+00:00"). SQLite has
--     no native timestamp type; sqlite3.PARSE_DECLTYPES handles the round-trip.
--   * Foreign keys are declared on every child table and `PRAGMA foreign_keys
--     = ON` is set per-connection (db.connection); ON DELETE CASCADE replaces
--     the application-level cascade chain that the DuckDB era needed.
--   * Vector columns live in sqlite-vec `vec0` virtual tables, NOT regular
--     columns. Joining them with `posts` is normal-table-friendly.
-- ----------------------------------------------------------------------

-- ---------- tag_groups ------------------------------------------------
CREATE TABLE tag_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    parent_id   INTEGER,
    color       TEXT    NOT NULL DEFAULT '#000000',
    created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES tag_groups(id) ON DELETE SET NULL
);

-- ---------- tags ------------------------------------------------------
CREATE TABLE tags (
    name        TEXT    PRIMARY KEY,
    group_id    INTEGER,
    created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES tag_groups(id) ON DELETE SET NULL
);

CREATE INDEX ix_tags_group_id ON tags(group_id);

-- ---------- posts -----------------------------------------------------
CREATE TABLE posts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path       TEXT    NOT NULL DEFAULT '',
    file_name       TEXT    NOT NULL DEFAULT '',
    extension       TEXT    NOT NULL DEFAULT '',
    full_path       TEXT    GENERATED ALWAYS AS
                            (file_path || '/' || file_name || '.' || extension) VIRTUAL,
    width           INTEGER NOT NULL DEFAULT 0,
    height          INTEGER NOT NULL DEFAULT 0,
    aspect_ratio    REAL    GENERATED ALWAYS AS
                            (CASE WHEN height = 0 THEN NULL
                                  ELSE (width * 1.0) / height END) VIRTUAL,
    published_at    TEXT,
    score           INTEGER NOT NULL DEFAULT 0,
    rating          INTEGER NOT NULL DEFAULT 0,
    description     TEXT    NOT NULL DEFAULT '',
    meta            TEXT    NOT NULL DEFAULT '',
    sha256          TEXT    NOT NULL DEFAULT '',
    size            INTEGER NOT NULL DEFAULT 0,
    source          TEXT    NOT NULL DEFAULT '',
    caption         TEXT    NOT NULL DEFAULT '',
    -- Serialized FLOAT[3] (LAB) via sqlite_vec.serialize_float32, NULL if
    -- dominant color hasn't been computed. KNN reads via vec_distance_L2.
    -- 3-d brute-force scan over ~150k rows is sub-millisecond, so we don't
    -- bother building a separate vec0 table for it.
    dominant_color  BLOB,
    thumbhash       TEXT,
    created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX uq_posts_file_path_file_name_extension
    ON posts(file_path, file_name, extension);

CREATE INDEX ix_posts_file_path        ON posts(file_path);
CREATE INDEX ix_posts_extension        ON posts(extension);
CREATE INDEX ix_posts_score            ON posts(score);
CREATE INDEX ix_posts_rating           ON posts(rating);
CREATE INDEX ix_posts_sha256           ON posts(sha256);
CREATE INDEX ix_posts_created_at       ON posts(created_at);
CREATE INDEX ix_posts_published_at     ON posts(published_at);

-- Compound index covering the most common UI list query (folder + sort).
CREATE INDEX ix_posts_file_path_score      ON posts(file_path, score);
CREATE INDEX ix_posts_file_path_rating     ON posts(file_path, rating);
CREATE INDEX ix_posts_file_path_created_at ON posts(file_path, created_at);

-- ---------- post_has_tag ---------------------------------------------
CREATE TABLE post_has_tag (
    post_id   INTEGER NOT NULL,
    tag_name  TEXT    NOT NULL,
    is_auto   INTEGER NOT NULL DEFAULT 0,  -- SQLite has no BOOLEAN; 0/1
    PRIMARY KEY (post_id, tag_name),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_name) REFERENCES tags(name) ON DELETE CASCADE
);

CREATE INDEX ix_post_has_tag_tag_name ON post_has_tag(tag_name);

-- ---------- post_has_color -------------------------------------------
CREATE TABLE post_has_color (
    post_id  INTEGER NOT NULL,
    "order"  INTEGER NOT NULL,
    color    INTEGER NOT NULL,
    PRIMARY KEY (post_id, "order"),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- ---------- post_waifu_scores ----------------------------------------
CREATE TABLE post_waifu_scores (
    post_id  INTEGER PRIMARY KEY,
    score    REAL    NOT NULL DEFAULT 0.0,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- ---------- vec0 virtual table (sqlite-vec) --------------------------
-- post_vectors: 768-d CLIP image embedding, cosine distance.
-- vec0 stores the embedding as a vec virtual column; post_id is the rowid
-- (named so the FK-style joins in queries read naturally).
CREATE VIRTUAL TABLE post_vectors USING vec0(
    post_id INTEGER PRIMARY KEY,
    embedding FLOAT[768] distance_metric=cosine
);
