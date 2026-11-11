-- 快速打分页的参照图：每一档固定几张"这就是 N 分"的典型图，常驻在屏幕边上。
--
-- 为什么要有：2026-11-11 的 222 张随机盲重打，同档率只有 48%，而且 40 分钟的一轮里
-- "这次减上次"的平均差从 +0.18 漂到 −0.30 —— 打分时人是在和上一张比，标准跟着刚看过
-- 的图走。固定的参照让每一张都和同一组锚点比。
--
-- 为什么落表而不是每次现算：参照图的全部价值在于**不变**。按规则现算的话，模型分一回填、
-- 某张图一改分，锚点就悄悄换人，等于标准又漂了一次。落表之后只有在某张锚点失效
-- （图被删、被并入别的组、分数不再是这一档）时才补一张新的，其余原地不动。
--
-- 选图规则在 packages/db/src/repositories/grading.ts（`gradingAnchors`）。
-- post_id 不加外键：失效的行由读取时的校验清理，而不是靠级联。

CREATE TABLE grading_anchors (
    grade    INTEGER NOT NULL,
    position INTEGER NOT NULL,
    post_id  INTEGER NOT NULL,
    PRIMARY KEY (grade, position)
);
