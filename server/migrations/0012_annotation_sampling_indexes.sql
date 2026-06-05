-- 采样查询的 NOT EXISTS 按 post id 反查 queue items，需要索引支撑
-- （PK 是 (queue_id, position)，按 post_id 查会全表扫）。
CREATE INDEX idx_absolute_queue_items_post ON absolute_queue_items (post_id, done);
CREATE INDEX idx_pairwise_queue_items_post_a ON pairwise_queue_items (post_a, done);
CREATE INDEX idx_pairwise_queue_items_post_b ON pairwise_queue_items (post_b, done);
