-- 删除旧的 post_vectors（CLIP ViT-L/14, FLOAT[768]）检索向量表。
--
-- 检索 backend 已全面切换到 SigLIP 2（post_vectors_siglip2, FLOAT[1152]）：
-- CLIP 检索编码器与回填 worker 均已移除，此表不再被写入或查询，仅剩历史
-- 数据。DROP 一并清理 vec0 的 shadow tables。新表由 always-on 的 SigLIP 2
-- backfill worker 持续填充（详见 processors.run_siglip_embedding_worker）。
DROP TABLE IF EXISTS post_vectors;
