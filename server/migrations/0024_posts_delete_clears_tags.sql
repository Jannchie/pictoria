-- 删 posts 行之前先删它的 post_has_tag 行，让 tags.post_count 的计数触发器在 post 行还在时运行。
--
-- 0009 的 trg_post_has_tag_count_ad 带 WHEN 子句：只在被删关联行所属的 post 是 canonical
-- （canonical_post_id IS NULL）时才减计数。如果直接 DELETE FROM posts、让外键级联去删
-- post_has_tag，级联发生时 post 行已经没了，子查询读到 NULL，隐藏的组成员也被当成
-- canonical 多减了一次。2026-06-06 一个已删除的清理脚本这样删了 411 张图，真库里因此
-- 有 228 个 tag 的 post_count 偏少（最多偏 6）；`apps/api/src/scripts/recount-tags.ts`
-- 能修复存量。
--
-- `deleteManyReturningPaths` 早就先删关联行，所以对它是空操作（按主键前缀 post_id 查，
-- 删 0 行）；这个触发器只是让任何直接 DELETE FROM posts 的写法也算对。
CREATE TRIGGER trg_posts_bd_clear_tags
BEFORE DELETE ON posts
BEGIN
    DELETE FROM post_has_tag WHERE post_id = OLD.id;
END;
