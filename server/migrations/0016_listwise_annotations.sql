-- listwise 标注：一次把一组（约 8 张）分数相近的图排出全序。
--
-- 为什么值得有第三种形态：一组 n 张的排序买到 C(n,2) 个成对约束，8 张一屏 = 28 对，
-- 而逐对标注拿同样的信息要点 28 次。VLM 侧实测同一结论（listwise 每对成本约为
-- pairwise 的 1/9.5，顺序效应 0.084 可忽略）；人类侧排 8 张也远比做 28 次二选一快。
-- 排序结果在训练侧分解为对（或直接进 Plackett-Luce 似然），与 pairwise 事件同流合并。
--
-- ranking 是"最好在前"的 post_id JSON 数组；空数组 = skip（这组问过了但没有产生
-- 排序信息，与 pairwise 的 skip 同义）。post_ids 是呈现顺序，留着是为了顺序效应
-- 可审计：ranking 与呈现顺序的相关性一旦异常，说明标注者在按位置而不是按图判断。

CREATE TABLE listwise_annotations (
    id             INTEGER PRIMARY KEY,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    post_ids       TEXT    NOT NULL,  -- JSON：呈现顺序
    ranking        TEXT    NOT NULL,  -- JSON：post_id 最好在前；[] = skip
    dimension      TEXT    NOT NULL,
    rubric_version TEXT    NOT NULL,
    session_id     TEXT    NOT NULL,
    elapsed_ms     INTEGER,
    edited_at      TEXT
);
CREATE INDEX idx_listwise_annotations_dimension ON listwise_annotations (dimension);

CREATE TABLE listwise_queue_items (
    queue_id INTEGER NOT NULL REFERENCES annotation_queues(id),
    position INTEGER NOT NULL,
    post_ids TEXT    NOT NULL,  -- JSON：这一屏的组成员
    done     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (queue_id, position)
);

-- annotation_queues.kind 的 CHECK 要放行 'listwise'，SQLite 改不了 CHECK，只能重建。
-- 依赖运行器在迁移期间关闭 foreign_keys（migrate.ts，SQLite 文档的标准重建流程），
-- 并在提交后用 foreign_key_check 验收。legacy_alter_table 让 RENAME 不改写子表
-- （absolute/pairwise/listwise_queue_items）里的外键目标名：改名的只是旧表，子表
-- 继续指向 annotation_queues 这个名字，随后由新表接住。
PRAGMA legacy_alter_table = ON;
ALTER TABLE annotation_queues RENAME TO annotation_queues_old;
CREATE TABLE annotation_queues (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('absolute', 'pairwise', 'listwise')),
    dimensions TEXT    NOT NULL,            -- JSON list of dimension keys
    scale      INTEGER,                     -- absolute 队列用；其余为 NULL
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO annotation_queues SELECT id, name, kind, dimensions, scale, created_at FROM annotation_queues_old;
DROP TABLE annotation_queues_old;
PRAGMA legacy_alter_table = OFF;
