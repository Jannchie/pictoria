-- 用户对近重复分组的手动决定。
--
-- 分组只有一条代码路径：全量重建（见 packages/db/src/repositories/dedup.ts）。
-- 重建清空**全部** canonical 指针再按边重算，所以在这张表出现之前，用户的每一次
-- 手动干预都活不过下一次重建 —— embedding 回填排空就会触发一次（apps/api 的
-- onDrained），也就是说「拆开」和「设为封面」的寿命是几分钟。用户拆开的组会被
-- 原样合回去，钉的封面会被组内最小 id 顶掉，而且没有任何提示。
--
-- 这里存的不是分组结果（那仍然由重建独占 posts.canonical_post_id），而是**重建
-- 必须让路的约束**：
--   * standalone —— 用户把它从组里拆了出来，重建不再把它并进任何组。
--   * canonical  —— 用户钉的组封面，重建选代表时优先于「组内最小 id」。
--
-- 一个 post 只有一条 override（PRIMARY KEY），两种 kind 互斥：拆出来的东西不可能
-- 同时是某个组的封面。改主意就是覆盖同一行（UPSERT），不留历史 —— 这是当前意图，
-- 不是审计日志。
--
-- ON DELETE CASCADE：post 没了，关于它的意图也就没有意义了。
CREATE TABLE IF NOT EXISTS post_group_overrides (
    post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('standalone','canonical')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
