-- 差分归组的证据表：一对 post 之间"是不是同一张画"的原始度量，以及用户的裁决。
--
-- 为什么需要它，而不是像现在这样直接从相似度算出分组：
--
-- 1) 判定要两级。SigLIP 2 是图文对齐训出来的，回答的是"是不是同一个**主题**"。
--    差分图要问的是"是不是同一张**画**"，这两个问题在 0.01（相似度 0.99）以内
--    重合，再往外就分家了：只换表情、加了对白框、打了局部马赛克的差分落在 0.02–0.06
--    这一带，而"同画师同角色的另一张画"也落在这里。所以 0.01–0.06 这段灰带不能
--    直接判同，要交给 LPIPS 逐对仲裁（见 packages/contracts 的 lpipsVerifyTask）。
--    仲裁是逐对的、几十毫秒一次，全库不可能每次重建重算一遍 —— 于是要缓存。
--
-- 2) 缓存就是增量。重建仍然是全量的一条路径（dedup.ts 头注解释了为什么），但
--    仲裁只发生在**这张表里还没有的对**上。新导入一批图之后，下一次重建的仲裁量
--    是新出现的那些对，而不是全部。
--
-- 3) 存度量而不是存判定。lpips_dist 记的是距离本身，"小于多少算同一张"是 TS 侧的
--    阈值（LPIPS_SAME_THRESHOLD）。这样把 0.45 调成 0.40 不需要重算任何一对 ——
--    而重算一遍是几十分钟。同理 siglip_dist 也存下来：它是排序强度（union-find 按
--    边强度降序合并），也是人工抽查时"这一对当初为什么会进灰带"的答案。
--
-- 4) 用户裁决和自动结果放在同一行，靠 user_verdict 是否为空区分。自动写入永远带
--    `WHERE user_verdict IS NULL`，所以一次重建不会覆盖任何人的决定 —— 这和
--    0018 的 post_group_overrides 是同一条原则的两半：那张表管"这个 post 不要进组"，
--    这张表管"这两个 post 是/不是同一张"。
--
-- (post_a, post_b) 恒有 post_a < post_b：一对只有一行，方向没有意义。CHECK 而不是
-- 靠调用方自觉 —— 写反了的后果是同一对存两行，然后两行给出不同的判定。
--
-- WITHOUT ROWID：主键就是这张表的全部内容之一，查询也全部按主键前缀走
-- （按 post_a 找它的所有边，或按整个主键查一对）。省掉 rowid 表那一层间接。
CREATE TABLE IF NOT EXISTS post_variant_edges (
    post_a INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    post_b INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    -- 召回时的 SigLIP 2 余弦距离。fp16 算出来的，带约 1e-3 误差：它是证据和排序键，
    -- 不是可复现的键值。
    siglip_dist REAL,
    -- LPIPS 感知距离。NULL 表示这一对还没被仲裁过（灰带里新出现的对）。
    lpips_dist REAL,
    -- 用户的裁决，NULL 表示这一行完全是自动算出来的。
    user_verdict TEXT CHECK(user_verdict IN ('same','different')),
    computed_at TEXT,
    decided_at TEXT,
    PRIMARY KEY (post_a, post_b),
    CHECK (post_a < post_b)
) WITHOUT ROWID;

-- 主键覆盖了"按 post_a 找边"，另一半要自己的索引：详情面板要的是"这个 post 参与的
-- 所有边"，而它可能在任意一侧。
CREATE INDEX IF NOT EXISTS ix_variant_edges_b ON post_variant_edges(post_b);
