-- pairwise_annotations 的两条读路径都在全表扫（EXPLAIN QUERY PLAN: SCAN）：
--
--   AnnotationRepo.list_pairwise_for_post: WHERE post_a = ? OR post_b = ?
--   AnnotationRepo.count_pairwise:         WHERE dimension = ? GROUP BY winner
--
-- 已有的 idx_pairwise_annotations_posts 是 (post_a, post_b, dimension)：post_b
-- 单独查用不上前导列，dimension 同理。表现在只有几千行（扫一次 0.2~0.5ms），
-- 所以看不出来；但 list_pairwise_for_post 挂在图片详情面板上（每次切图一次全
-- 表扫），count_pairwise 是标注页顶栏的累计计数，两者都随标注量线性劣化。
--
-- close 采样新增的 _judged_graph / _draw_anchors 会整表读这两列来重建已判图，
-- 而且是在按键路径上（refill），更需要这两个索引兜底。
CREATE INDEX idx_pairwise_annotations_post_b ON pairwise_annotations (post_b);
CREATE INDEX idx_pairwise_annotations_dimension ON pairwise_annotations (dimension);
