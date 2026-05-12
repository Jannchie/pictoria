-- Pictoria initial schema (DuckDB, native).
-- Mirrors server/src/models.py at the time of the PG -> DuckDB migration.
--
-- NOTE on foreign keys:
--   DuckDB's FK implementation is severely restrictive: UPDATE on a row
--   with incoming FK references fails (because UPDATE is implemented as
--   DELETE+INSERT under MVCC). To allow normal mutations, we declare the
--   FK relationships as comments only and enforce them in the Repository
--   layer (e.g. PostRepo.delete_many removes child rows in order).
--   See: https://duckdb.org/docs/sql/constraints (Foreign Keys section).
-- ----------------------------------------------------------------------

-- ---------- tag_groups ------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS seq_tag_groups_id START 1;

CREATE TABLE tag_groups (
    id          INTEGER       PRIMARY KEY DEFAULT nextval('seq_tag_groups_id'),
    name        VARCHAR(120)  NOT NULL,
    parent_id   INTEGER,                          -- logical FK -> tag_groups(id)
    color       VARCHAR(9)    NOT NULL DEFAULT '#000000',
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX ix_tag_groups_name        ON tag_groups(name);
CREATE INDEX ix_tag_groups_created_at  ON tag_groups(created_at);
CREATE INDEX ix_tag_groups_updated_at  ON tag_groups(updated_at);

-- ---------- tags ------------------------------------------------------
CREATE TABLE tags (
    name        VARCHAR(120)  PRIMARY KEY,
    group_id    INTEGER,                           -- logical FK -> tag_groups(id)
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX ix_tags_group_id    ON tags(group_id);
CREATE INDEX ix_tags_created_at  ON tags(created_at);
CREATE INDEX ix_tags_updated_at  ON tags(updated_at);

-- ---------- posts -----------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS seq_posts_id START 1;

CREATE TABLE posts (
    id              INTEGER       PRIMARY KEY DEFAULT nextval('seq_posts_id'),
    file_path       VARCHAR       NOT NULL DEFAULT '',
    file_name       VARCHAR       NOT NULL DEFAULT '',
    extension       VARCHAR       NOT NULL DEFAULT '',
    full_path       VARCHAR       GENERATED ALWAYS AS
                                  (file_path || '/' || file_name || '.' || extension) VIRTUAL,
    width           INTEGER       NOT NULL DEFAULT 0,
    height          INTEGER       NOT NULL DEFAULT 0,
    aspect_ratio    DOUBLE        GENERATED ALWAYS AS
                                  (width * 1.0 / NULLIF(height, 0)) VIRTUAL,
    published_at    TIMESTAMPTZ,
    score           INTEGER       NOT NULL DEFAULT 0,
    rating          INTEGER       NOT NULL DEFAULT 0,
    description     VARCHAR       NOT NULL DEFAULT '',
    meta            VARCHAR       NOT NULL DEFAULT '',
    sha256          VARCHAR       NOT NULL DEFAULT '',
    size            INTEGER       NOT NULL DEFAULT 0,
    source          VARCHAR       NOT NULL DEFAULT '',
    caption         VARCHAR       NOT NULL DEFAULT '',
    dominant_color  FLOAT[3],
    thumbhash       VARCHAR,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_posts_file_path_file_name_extension
    ON posts(file_path, file_name, extension);

CREATE INDEX ix_posts_file_path        ON posts(file_path);
CREATE INDEX ix_posts_file_name        ON posts(file_name);
CREATE INDEX ix_posts_extension        ON posts(extension);
CREATE INDEX ix_posts_width            ON posts(width);
CREATE INDEX ix_posts_height           ON posts(height);
CREATE INDEX ix_posts_published_at     ON posts(published_at);
CREATE INDEX ix_posts_score            ON posts(score);
CREATE INDEX ix_posts_rating           ON posts(rating);
CREATE INDEX ix_posts_meta             ON posts(meta);
CREATE INDEX ix_posts_sha256           ON posts(sha256);
CREATE INDEX ix_posts_size             ON posts(size);
CREATE INDEX ix_posts_source           ON posts(source);
CREATE INDEX ix_posts_created_at       ON posts(created_at);
CREATE INDEX ix_posts_updated_at       ON posts(updated_at);

-- compound indexes (mirrors models.py:83-95 query optimisation hints)
CREATE INDEX ix_posts_file_path_score        ON posts(file_path, score);
CREATE INDEX ix_posts_file_path_rating       ON posts(file_path, rating);
CREATE INDEX ix_posts_file_path_extension    ON posts(file_path, extension);
CREATE INDEX ix_posts_file_path_created_at   ON posts(file_path, created_at);

-- HNSW for LAB dominant-color similarity (3-d, L2)
CREATE INDEX hnsw_posts_dominant_color
    ON posts USING HNSW(dominant_color) WITH (metric = 'l2sq');

-- ---------- post_has_tag ---------------------------------------------
CREATE TABLE post_has_tag (
    post_id   INTEGER       NOT NULL,             -- logical FK -> posts(id)
    tag_name  VARCHAR(120)  NOT NULL,             -- logical FK -> tags(name)
    is_auto   BOOLEAN       NOT NULL DEFAULT FALSE,
    PRIMARY KEY (post_id, tag_name)
);

CREATE INDEX ix_post_has_tag_post_id   ON post_has_tag(post_id);
CREATE INDEX ix_post_has_tag_tag_name  ON post_has_tag(tag_name);

-- ---------- post_has_color -------------------------------------------
CREATE TABLE post_has_color (
    post_id   INTEGER  NOT NULL,                  -- logical FK -> posts(id)
    "order"   INTEGER  NOT NULL,
    color     INTEGER  NOT NULL,
    PRIMARY KEY (post_id, "order")
);

CREATE INDEX ix_post_has_color_post_id  ON post_has_color(post_id);

-- ---------- post_vectors ---------------------------------------------
CREATE TABLE post_vectors (
    post_id    INTEGER     PRIMARY KEY,           -- logical FK -> posts(id)
    embedding  FLOAT[768]  NOT NULL
);

-- HNSW for CLIP image-embedding similarity (768-d, cosine)
CREATE INDEX hnsw_post_vectors_embedding
    ON post_vectors USING HNSW(embedding) WITH (metric = 'cosine');

-- ---------- post_waifu_scores ----------------------------------------
CREATE TABLE post_waifu_scores (
    post_id  INTEGER  PRIMARY KEY,                -- logical FK -> posts(id)
    score    DOUBLE   NOT NULL DEFAULT 0.0
);
