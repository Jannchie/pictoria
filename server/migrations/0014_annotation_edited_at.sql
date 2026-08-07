-- 标注事件的"改判"标记。
--
-- 事件表原本是纯 append-only，改判只能靠再追加一条。但 pairwise 的导出是一条
-- 判断一行（scripts/export_annotations.py），没有 latest-wins 聚合，追加会让错
-- 的那条照样进训练集；单图评分虽然是 latest-wins，追加却会在"同一个人重测一致
-- 性"的统计里伪造一次分歧——而改判不是重测。所以改判走原地 UPDATE。
--
-- 代价是 elapsed_ms 对被改过的行不再成立：它记的是当初那一眼花了多久，而改判是
-- 事后回看列表点的。edited_at 就是为此存在——任何按耗时做的分析都能靠它把这些行
-- 排除掉，而不是把回看时间当成判断时间。NULL = 从未改过。
ALTER TABLE pairwise_annotations ADD COLUMN edited_at TEXT;
ALTER TABLE absolute_annotations ADD COLUMN edited_at TEXT;

-- 0011 的 annotation_timeline 视图作废。
--
-- 它是"把事件流合并成一条时间线"的第一版，只覆盖 absolute + pairwise 两种事件，
-- 也不带任何判定列（winner / value / flag）。历史侧栏需要三种事件和这些列，所以
-- 那条 UNION 现在活在 AnnotationRepo._TIMELINE_SQL 里；留着视图等于让同一个概念
-- 有两份定义，而只有一份有人读——加第四种事件类型时改到的多半是有人读的那份，
-- 视图继续返回过期形状，还没有任何东西会失败。
DROP VIEW IF EXISTS annotation_timeline;
