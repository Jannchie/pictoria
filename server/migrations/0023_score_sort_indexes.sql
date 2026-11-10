-- 分数排序的驱动索引。
--
-- `ORDER BY <scorer>_score` 的列在 LEFT JOIN 的右表上，planner 不能从右表驱动，原来
-- 只能把全库 post join 一遍再 TEMP B-TREE 排序。`queries/post-search.ts` 的
-- `buildScoreSortPlan` 改成从分数表沿 (score, post_id) 的序取候选再 JOIN posts 过滤，
-- 它需要下面两条索引（覆盖：post_id 在索引里，不回表）。
--
-- 真库一致快照（37.5 万 posts）首页 100 条：
--     silva_score desc        198 ms → 1.6 ms
--     silva_luna_score desc   400 ms → 1.6 ms
--     waifu_score desc         53 ms → 1.8 ms
--     silva_score desc offset 304990（深页）  3483 ms → 578 ms
--
-- 建索引约 1.5 s（一次性）。`ix_post_aesthetic_scores_scorer` 成了新索引的前缀，
-- 但别的查询计划可能引用它，这里不删。
CREATE INDEX IF NOT EXISTS ix_post_aesthetic_scores_scorer_score
    ON post_aesthetic_scores(scorer, score, post_id);

-- post_waifu_scores 的 post_id 就是 rowid，单列索引里自带它。
CREATE INDEX IF NOT EXISTS ix_post_waifu_scores_score
    ON post_waifu_scores(score);

-- 新索引的统计信息（不设 analysis_limit，理由见 0022）。
ANALYZE post_aesthetic_scores;
ANALYZE post_waifu_scores;
