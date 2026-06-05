-- 标注事件（append-only，永不 UPDATE/DELETE）与标注队列。
-- 按形态分表：absolute / pairwise / content-flag 的消费路径完全分离。
-- dimension 合法值由应用层校验（'color'|'finish'|'composition'|'overall'），不 CHECK，留扩展。

CREATE TABLE absolute_annotations (
    id             INTEGER PRIMARY KEY,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    post_id        INTEGER NOT NULL,
    dimension      TEXT    NOT NULL,
    scale          INTEGER NOT NULL CHECK (scale IN (2, 3, 5)),
    value          INTEGER NOT NULL,
    rubric_version TEXT    NOT NULL,
    session_id     TEXT    NOT NULL,
    elapsed_ms     INTEGER
);
CREATE INDEX idx_absolute_annotations_post ON absolute_annotations (post_id, dimension);

CREATE TABLE pairwise_annotations (
    id             INTEGER PRIMARY KEY,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    post_a         INTEGER NOT NULL,
    post_b         INTEGER NOT NULL CHECK (post_b != post_a),
    dimension      TEXT    NOT NULL,
    winner         TEXT    NOT NULL CHECK (winner IN ('a', 'b', 'tie', 'skip')),
    rubric_version TEXT    NOT NULL,
    session_id     TEXT    NOT NULL,
    elapsed_ms     INTEGER
);
CREATE INDEX idx_pairwise_annotations_posts ON pairwise_annotations (post_a, post_b, dimension);

CREATE TABLE content_flag_events (
    id         INTEGER PRIMARY KEY,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    post_id    INTEGER NOT NULL,
    flag       TEXT    NOT NULL CHECK (flag IN ('love', 'hate', 'none')),
    session_id TEXT    NOT NULL
);
CREATE INDEX idx_content_flag_events_post ON content_flag_events (post_id);

CREATE TABLE annotation_queues (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('absolute', 'pairwise')),
    dimensions TEXT    NOT NULL,            -- JSON list of dimension keys
    scale      INTEGER,                     -- absolute 队列用；pairwise 为 NULL
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE absolute_queue_items (
    queue_id INTEGER NOT NULL REFERENCES annotation_queues(id),
    position INTEGER NOT NULL,
    post_id  INTEGER NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (queue_id, position)
);

CREATE TABLE pairwise_queue_items (
    queue_id INTEGER NOT NULL REFERENCES annotation_queues(id),
    position INTEGER NOT NULL,
    post_a   INTEGER NOT NULL,
    post_b   INTEGER NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (queue_id, position)
);

CREATE VIEW annotation_timeline AS
    SELECT id, created_at, 'absolute' AS kind, post_id, dimension, session_id FROM absolute_annotations
    UNION ALL
    SELECT id, created_at, 'pairwise' AS kind, post_a AS post_id, dimension, session_id FROM pairwise_annotations;
