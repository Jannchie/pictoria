-- Recently 视图的复合索引,外加一次孤儿向量清理。
--
-- 1) (canonical_post_id, last_accessed_at)
--
-- Recently 视图发的是 `WHERE canonical_post_id IS NULL ORDER BY last_accessed_at DESC`。
-- 0003 建的单列 `ix_posts_last_accessed_at` 用不上:计划器要么用它排序然后逐行回表
-- 过滤,要么用 `ix_posts_canonical` 过滤然后 TEMP B-TREE 排序 —— 实测它选了后者。
-- 复合索引让过滤和排序落在同一棵树上,而且 `id` 作为 rowid 天然在叶子里,整个查询
-- 变成覆盖扫描。
--
-- 在生产库的一致快照上实测(223,063 posts):
--     建索引前  63.9 ms   SEARCH p USING INDEX ix_posts_canonical + USE TEMP B-TREE FOR ORDER BY
--     建索引后   0.4 ms   SEARCH p USING COVERING INDEX ix_posts_canonical_last_accessed
--     (建索引本身 370 ms,一次性)
-- 冷缓存下建索引前约 254 ms,所以真实收益在 150–600 倍之间。
--
-- 单列的 ix_posts_last_accessed_at 保留:`order_by=last_accessed_at` 且不带
-- only_canonical 的请求仍然走它。

CREATE INDEX IF NOT EXISTS ix_posts_canonical_last_accessed
    ON posts(canonical_post_id, last_accessed_at);

-- 2) 清掉 post 已经不存在的向量行
--
-- `post_vectors_siglip2` 是 vec0 虚表,不参与 FK 级联,所以删 post 时要显式删它
-- （`deleteManyReturningPaths` 就是这么做的）。但 embedding 回填有一个竞态:待办
-- 查询选中一个 post → 提交任务 → worker 算几秒到几分钟 → 这期间 sync 发现文件没了
-- 把 post 删掉 → 结果回来,`upsertVectors` 照写不误。写进去的就是一条孤儿。
--
-- 实测生产库上有 67 条这样的行(id 集中在 2187172–2187209,即最近导入的一段)。
-- 两个后果:
--
--   * `exportVectorMatrix` 直接从 vec0 全表导出,孤儿会进入 dedup 矩阵。
--     `assignFromPairs` 取组内最小 id 当 canonical,一旦某个孤儿成了 canonical 而
--     成员是真实 post,`replaceAllGroups` 的 `UPDATE posts SET canonical_post_id = <孤儿>`
--     会撞 `REFERENCES posts(id)` 外键 —— 整个重建事务回滚。
--   * `listEmbeddingPending` 想用 count 对比做快路径门控时,两边永远差这 67,门控
--     永不命中。
--
-- 根因在 `upsertVectors`(现已只为仍然存在的 post 写入)和 `exportVectorMatrix`
-- (现已 join posts),这里清的是存量。

DELETE FROM post_vectors_siglip2
WHERE post_id IN (
    SELECT v.post_id FROM post_vectors_siglip2 v
    WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = v.post_id)
);
