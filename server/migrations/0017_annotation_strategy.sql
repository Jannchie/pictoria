-- 标注的采样来源（provenance）。
--
-- 采样策略决定了一条比较**能不能**用作评估。samplePairs 的注释早就写明分工：
-- close 刻意让采样感知模型，把标签集中在 head 分不开的边界上，是训练燃料；
-- random / similar 与模型无关，是留给留出评估的。但 strategy 从来没有落到行上，
-- 于是到 2026-08-20 积累的 5430 条 overall 比较里，没有任何一条能被认定为
-- 「模型无关」—— 留出评估集在收集的那一刻就丢了，事后再也分不出来。
--
-- 存量行保持 NULL：那是诚实的「来源未知」，不能假装成任何一种。分析时按
-- strategy IS NOT NULL 划线即可。
ALTER TABLE pairwise_annotations ADD COLUMN strategy TEXT;

-- 队列模式的 strategy 是队列自己的属性（一个队列由一次 generate-pairwise 建成，
-- 全部 item 同一策略），所以记在队列上，提交时由前端带回到事件行。
ALTER TABLE annotation_queues ADD COLUMN strategy TEXT;
