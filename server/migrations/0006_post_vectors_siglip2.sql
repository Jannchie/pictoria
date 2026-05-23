-- post_vectors_siglip2: SigLIP 2 图片 embedding，1152 维，cosine。
--
-- 与旧 post_vectors（CLIP ViT-L/14, FLOAT[768]）并行存在，用于检索 backend
-- 从 CLIP 迁移到 SigLIP 2 的零停机过渡：backfill 期间旧表继续服务检索，
-- 待新表填满后由 shared.search_embedding_backend 切换。两张表都是 vec0
-- 虚拟表，post_id 作为 rowid，不参与 FK cascade（删除 post 时需在
-- PostRepo.delete_many 中显式清理，与旧表一致）。
CREATE VIRTUAL TABLE post_vectors_siglip2 USING vec0(
    post_id INTEGER PRIMARY KEY,
    embedding FLOAT[1152] distance_metric=cosine
);
