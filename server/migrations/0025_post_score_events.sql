-- 打分事件流：`posts.score` 每被用户写一次，这里追加一行（append-only）。
--
-- `posts.score` 只有最终值，没有"什么时候打的"。SILVA 那边按导入时间拆近重复对，
-- 发现同一张图隔一天以上重打，只有 74.5% 给出同一档（同一小时内是 92.1%）——
-- 评分标准会随会话浮动，而没有打分时间就既量不准这个浮动，也没法在训练里按会话
-- 把它扣掉。`updated_at` 顶不了这个用途：改 caption、换 tagger 都会动它。
--
-- 一次用户动作一行，记被直接操作的那张图：
--   score     写入的新分，0 = 清空
--   previous  这张图动作之前的分。previous != 0 且 != score 就是一次改判，
--             previous == score 是一次原样确认 —— 两者都是重测信号
--   bulk      1 = 来自批量打分（一次给一批图同一个分，判断粒度比单张粗）
--   source    这一分是在哪种情境下打的。NULL = 图库里随手打的（看得见旧分和模型分）；
--             'grade:new' / 'grade:random' / 'grade:suspect' = 快速打分页的盲打，冒号后
--             是这张图被抽中的原因（见 repositories/grading.ts）。自洽度只能用
--             'grade:random' 算：'suspect' 是按"与模型分歧大"抽的，天然偏向改判
--
-- 近重复组的镜像写入**不**记：成员是被同一个动作带着改的，不是独立判断，
-- 记了会在重测统计里伪造一致。会话不单独存，按 created_at 的间隔切即可。
--
-- post_id 不加外键，和其它标注事件表一样：图删了，"当时打过几分"仍是事实。

CREATE TABLE post_score_events (
    id         INTEGER PRIMARY KEY,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    post_id    INTEGER NOT NULL,
    score      INTEGER NOT NULL,
    previous   INTEGER NOT NULL,
    bulk       INTEGER NOT NULL DEFAULT 0,
    source     TEXT
);
CREATE INDEX idx_post_score_events_post ON post_score_events (post_id);
