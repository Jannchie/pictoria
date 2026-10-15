/**
 * 标注采样 —— 形状承自已退役的 Python 侧 `db/repositories/annotation_queues.py` 里不涉及 CRUD
 * 的那一半（约 700 行）。
 *
 * 采样完全跑在 pictoria 自己拥有的数据上：旧的人工评分、SigLIP2 向量、已经收集到的
 * 标注事件。所以整个标注闭环是自洽的，下游消费者只**读**事件。
 *
 * 下面每个常量的取值都是在真实库上测出来的，不是拍脑袋的默认值 —— 改之前先读注释。
 *
 * 文件分三层：纯图算法在 pair-graph.ts（不碰 sqlite，单测不用建库），每一条 SQL 在
 * sampling-queries.ts，这里只剩**策略** —— 可调常量和 Sampler 怎么把它们拼成一批。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { placeholders } from '../sql.js'
import { cosine, knn, unitVectors } from './vectors.js'
import { scorerValuesFor } from './scores.js'
import { SILVA } from '../scorers.js'
import type { Format } from '../formats.js'
import { edgeKey } from './variant-edges.js'
import {
  connectedBlocks,
  cycleEdges,
  interleaveWithBridges,
  MIN_CYCLE_MEMBERS,
  PAIR_MEMBERS,
  PairGraph,
} from './pair-graph.js'
import type { Block } from './pair-graph.js'
import { flipPair, nSmallest, reservoir, shuffle } from './sampling-random.js'
import {
  anchoredPool,
  comparisonEdges,
  drawCandidates,
  existingPostIds,
  judgedSilvaRows,
  pairwiseEligibleScores,
  partnerInWindow,
  randomPairwiseEligible,
  rankedListwiseRows,
  repeatCutoff,
  repeatPairPool,
  silvaEligibleAmong,
  silvaInRange,
  windowSeeds,
  withEmbedding,
} from './sampling-queries.js'
import type { AnchoredMember, IdScoreRow } from './sampling-queries.js'

// ─── similar 策略的可调参数 ─────────────────────────────────────────
//
// 24 = floor(SIMILAR_KNN_K / 2)，也就是一个邻域被榨干。similar 严格不相交配对，所以
// 24 是拓扑上限 —— 再高只会逼出另一次 KNN。旧值 8 把每个邻域三分之二丢在地上，一个
// 20 对的批次要 3 次 KNN 扫描（21.4 万行库上实测约 3.5 s），而 1 次就够。
const SIMILAR_PAIRS_PER_CLUSTER = 24
const SIMILAR_KNN_K = 48
/** 丢掉近重复：近乎相同的一对，结论在看之前就定了。 */
const SIMILAR_MIN_DISTANCE = 0.04
/** |score_a - score_b| <= band → 同档或相邻档。 */
const SIMILAR_SCORE_BAND = 1

/**
 * close 策略里 SILVA head 的 |calibrated_score_a - calibrated_score_b| 上限。
 *
 * <= 0.10 只留下模型自己都分不开的对（那一带方向准确率约 0.51–0.64）—— 正是绝对分
 * 标签教不会的那些边界对。约 36% 的随机对落在这个范围内。
 */
const CLOSE_PAIR_MAX_SILVA_DIFF = 0.10

/**
 * 超过这个余弦，两张图就是同一张图，结论是必然的平局。
 *
 * 在 3001 条真实 `overall` 判决上测出的平局率：
 *
 *   >= 0.96      93.7%   ← 没有信息量，看之前答案就定了
 *   0.94–0.96    70.6%
 *   0.90–0.94    39.5%
 *   <  0.90      ~22%    （基线）
 *
 * SIMILAR_MIN_DISTANCE **盖不住**这个：那个过滤跑在 KNN 结果上，量的是离**种子**的
 * 距离 —— 而 similar 和 close 都是让成员**互相**配对，从不和种子配。两个离种子都很远
 * 的成员，彼此仍可能是转载。
 *
 * 取 0.94 而不是 0.96：0.94–0.96 这一带 70% 是平局，丢掉只花约 5% 的预算，换回来的是
 * 真能分出胜负的比较。
 */
const MAX_PAIR_COSINE = 0.94

/**
 * 每张图应该参与多少次比较。
 *
 * 偏好模型是从**链**里推出全局序的（a>b, b>c ⇒ a>c），所以只被判过一次的图只贡献一条
 * 孤立边，构不成链。在最早 2726 条 `overall` 标注上测得：5260 张图，96.5% 恰好只比过
 * 一次，训练信号"略微正向但不显著"。3 是既能连通、又扛得住一次噪声判决的实际下限；
 * 代价是 N 次比较从覆盖 2N 张图降到约 2N/3 张 —— 而这正是让这些比较**可排序**的那笔交易。
 */
const CLOSE_PAIR_DEGREE = 3

/**
 * 一次 listwise 出场，给每个成员记多少度。
 *
 * **不是 n−1。** 一组 n 张的全序展开成 C(n,2) 条边，但那不是 C(n,2) 次独立观测 ——
 * 全序由 n 个潜变量的一个排列生成。Plackett-Luce 下（每张图抽一次 Gumbel 噪声效用后
 * 排序），参数相等时每个成员拿到的 Fisher 信息是 (1/n)·Σ_{k=2..n}(1−1/k)，而一次
 * 势均力敌的 pairwise 给每方 0.25。折算成 pairwise 当量就是 (4/n)(n − H_n)：
 * n=4 → 1.92，n=6 → 2.37，n=8 → 2.64。**在 4..8 之间都约等于 2**，所以这里是常数
 * 而不是 size 的函数 —— 精度远不值那份复杂度。
 *
 * 按 n−1 记的后果是实测过的：一次 6 张排序 +5 度直接跨过 CLOSE_PAIR_DEGREE，成员当场
 * 永久退役，再不会被重访。2026-09-06 的库里因此堆着 1952 张度数 >= 5 的图，它们的 5 条
 * 边**全部来自同一次排序** —— 同一个瞬间、同一个上下文。而 CLOSE_PAIR_DEGREE = 3 是在
 * 成对时代按「三条独立边」校准的，这里给它喂的是一次观测。
 *
 * 记 2 之后，n=4 的组要出场两次才退役（2+2 >= 3），席位经济也正好闭合：每组 4 席里
 * CLOSE_REVISIT_MEMBERS = 2 席重访、2 席新图，新图每张欠一次再出场 —— 需求 2、供给 2。
 */
const LISTWISE_APPEARANCE_DEGREE = 2

/**
 * 一个 silva 窗口里取几个成员，以及这个窗口提供多少候选供挑选。
 *
 * 窗口是 close 采样的单位，它取代了原来的 KNN 邻域。邻域这个单位错在两处：它是**一个
 * 主题** —— 同角色、同系列、同画师 —— 于是 20 个问题里只出现 21 张不同的图，89.9% 的
 * 相邻问题在复用图片；而且实测它产出的对余弦中位数 0.86（随机对是 0.69），那里平局率
 * 28.2% 而不是 15.1%：看起来像，恰恰是评判者叫不准的地方。
 *
 * 窗口把这件事倒过来。成员资格只由 silva 分决定 —— 窗口内每一对天然在带内，不需要排序
 * 也不需要脊 —— 然后成员被挑成窗口所能给出的**最不像**的一组（见 diverseSubset）。这也
 * 正是被训练的 head 需要的：它学的是 θ = wᵀφ，信息矩阵由差 φ_a - φ_b 构成，而一个邻域
 * 里的差只张成特征空间的一个低维切片，w 在别处全无约束。
 *
 * 6 个成员是因为它们被连成一个环（见 windowBlock）：6 成员 6 边，每张图度数 2，一个块
 * 一个环。候选给 32 个，让最远点搜索有铺开的余地，而 32×1152 的点积仍在微秒量级。
 *
 * KNN 随邻域一起消失了 —— 窗口是一次带索引的范围扫描而不是 vec0 全表暴力扫，于是 20 对
 * 的补充从约 4 s 掉到毫秒。
 */
const CLOSE_BLOCK_MEMBERS = 6
const CLOSE_WINDOW_CANDIDATES = 32

/**
 * 一个块的成员里，有几个抽自**已经在比较图里**的图片而不是抽自整个库。
 *
 * 6 取 2，于是一个块是穿过两个已有节点、四个新节点的环。两半都吃重，而且互相拉扯：每个
 * 种子都是一张能多拿两条边的图，度数 1 时正好落到 CLOSE_PAIR_DEGREE —— 但它同时是这一批
 * 不再首次覆盖的一张图。取 2 时，20 对的补充仍能覆盖约 8–10 张新图，同时把环闭合在已有的
 * 图上；而实测的一次真实补充完全没做到这点：19 张图里 13 张全新，20 条边里只有 5 条连接
 * 两张已判过的图，还全是碰巧而非设计。
 */
const CLOSE_REVISIT_MEMBERS = 2

/**
 * 每**批**抽多少个窗口中心（见 windowSeeds）—— 这和一个窗口给多少候选是两件事。产出中心
 * 的那次抽取无论 LIMIT 多少都是全扫，所以它按"够整批窗口用"来定，而不是按"喂饱一个窗口"。
 */
const CLOSE_SEED_DRAW = 32

/**
 * listwise 组在基带里凑不齐人时，允许把 silva 窗口放宽到多少。
 *
 * 上限取 0.15 而不是 0.20，理由和 CALIBRATION_GAP 是同一条实测：0.15–0.25 的分差模型
 * 已经判对 75%，再宽就不是边界对、只是在买模型早就知道的东西。基带 0.10 之外多出的
 * 这 0.05 只是给小形态的尾部窗口一条活路（例如 comic 在 silva 0.90 附近只有 74 张有
 * 绝对分的图），illust 在任何中心都有几千张候选，走不到这一级。
 */
const LISTWISE_BAND_RELAXED = 0.15

/**
 * 一个 listwise 组最少几张图。
 *
 * 比 MIN_CYCLE_MEMBERS(3) 高一张，因为这里买的是**锚对**而不是环边：4 张全序给 6 个
 * 两端都有绝对分的成对约束，3 张只给 3 个 —— 那还不如把这个种子让给下一个窗口。
 */
const LISTWISE_MIN_GROUP = 4

/**
 * 窗口中心只从**这个星级以上**的图里抽。
 *
 * 2026-09-07 实测：把 head 和「你自己重评一次」放在同一个 val 划分、同一个二分类任务上
 * 对打，差距全部在高分档 ——
 *
 *     任务      head val AUC   人预测人 AUC   还剩的空间
 *     2 vs 3      0.8901         0.8806        -0.009   <- 已经到顶
 *     3 vs 4      0.8186         0.9309        +0.112
 *     4 vs 5      0.8023         0.9705        +0.168
 *
 * 也就是说 2-vs-3 那一档模型早就和你一样准了（贴着标注噪声的天花板），而 4-vs-5 你自己
 * 判两次几乎不犯错（0.9705）、模型却只有 0.8023。在此之前窗口中心是从整个有锚池随机抽的，
 * 于是组的分数分布跟随全库 —— 而全库有 38542 张 3 星、只有 9306 张 5 星，绝大多数标注工时
 * 就花在了那条已经到顶的档上。
 *
 * 取 4 而不是 5：窗口按 silva 分收成员、不按星级，所以中心定在 4 星区时组内会自然混入
 * silva 分相近的 3 星和 5 星图 —— 3-vs-4 和 4-vs-5 两条边界都能买到。定在 5 星则池子只剩
 * 9306 张，窗口内凑不齐同形态的 4 张。
 *
 * 只约束**种子**，不约束成员：成员跨档正是要买的东西。
 */
const LISTWISE_SEED_MIN_STARS = 4

/**
 * 重复测量：每批里有多大比例是**故意重问的老对**。
 *
 * 这是整套标注唯一的噪声标尺。到 2026-08-20，5339 个不同的对里只有 3 个被问过两次，
 * 于是「标注者自己判两次会不会一致」无从估计 —— 而没有这个数，就无法判断模型到底
 * 是还没学会，还是已经顶到标签噪声的天花板。close 采样恰恰把 64% 的标签堆在
 * |Δsilva| < 0.05 的区间，那里人与模型的一致率只有 50~53%，最需要知道天花板在哪。
 *
 * 5% 是拿标注工时买测量精度：按每批 20 条算，平均每批一条；再标 5000 条能攒到约
 * 250 个重复对，一致率的标准误约 3%，足够把「模型还差多少」和「标签本来就吵」分开。
 * 它是**税**不是附加 —— 占掉批次里的一个名额，所以 5% 就是 5% 的工时。
 */
const REPEAT_SHARE = 0.05

// 重问之前至少要隔多久（REPEAT_MIN_AGE_DAYS）和「够格充当第一次」的判据（REPEAT_PRIOR）
// 都是 SQL 的一部分，在 sampling-queries.ts。

/**
 * `n` 个槽位里有多少个该让给重复测量。
 *
 * 伯努利逐槽抽，不是 `Math.round(n * share)` —— 后者在 limit=20、share=0.05 下恒等于 1，
 * 每批不多不少正好一条，有节奏可循。
 */
export function repeatSlots(n: number, share = REPEAT_SHARE): number {
  let k = 0
  for (let i = 0; i < n; i++) if (Math.random() < share) k++
  return k
}

// PAIR_MEMBERS / MIN_CYCLE_MEMBERS（结构事实，不是可调参数）在 pair-graph.ts。

/**
 * 重新抽出来当桥头堡的已判图片，让这一批挂到**已经建好**的比较图上，而不是另起一座孤岛。
 *
 * 这是让流式标注能累加的关键。UI 一次补 20 对，约等于 1 个 KNN 邻域，所以没有锚点时每次
 * 补充都是一个独立连通分量：2026-08-06 收集的 198 次比较回来正好是 10 个分量、一次补充
 * 一个，最大的那个只占 19.7% 的图片。度数解决不了这个 —— 它管的是邻域内部的连通，对邻域
 * 与邻域之间只字未提。取 2 个而不是 1 个，是因为桥可以被跳过，而一条被跳过的边不该让整批
 * 脱钩。
 */
const CLOSE_ANCHORS = 2
/**
 * 随机抽取前从主分量里预选的锚点候选数。有上界是因为它会变成绑定变量列表，也因为这个短
 * 名单按度数排序：过了两百来个，多出来的全是比已入选者比过更多次的图片，那恰好和锚点该有
 * 的样子相反。
 */
const ANCHOR_CANDIDATES = 200

/**
 * 花在给一张图**定界**（而不是定位）上的比较，以及所用的分数偏移。
 *
 * 一张赢遍所有对手的图，其 Bradley-Terry 估计是无界的：似然随评分趋向无穷一直涨，因为数据
 * 只说过"高于它遇到的一切"。全输的那张镜像同理。在已收集的判决里，有 2 次以上决定性比较的
 * 图片中 65.7% 正处于这个状态 —— 36.0% 全胜、29.7% 全败 —— 这不是意外，而是
 * CLOSE_PAIR_MAX_SILVA_DIFF 的直接代价：一张图只会遇到模型给同样分数的对手，于是任何真的
 * 比它这一档更好的东西都会横扫它。
 *
 * 解法是让它和一张模型明确排在它**上方**（全败的则是下方）的图比一次。偏移量在同一批
 * 3248 条判决上测得：
 *
 *   gap          平局     模型判对
 *   0.00–0.05    29.2%     53.1%   ← 掷硬币，定不了界
 *   0.15–0.25    23.1%     75.4%   ← 够决定性能定界，又够不确定值得问
 *   0.40+         5.8%     95.9%   ← 结论已定
 */
const CALIBRATION_GAP: readonly [number, number] = [0.15, 0.25]
/** 有需求时占一批的比例。 */
const CALIBRATION_SHARE = 0.2

export class Sampler {
  constructor(private readonly sqlite: BetterSqlite3.Database) {}

  /** 为绝对标注抽候选 post id。 */
  samplePostIds({ count, strategy, dimensions }: { count: number, strategy: string, dimensions: string[] }): number[] {
    if (strategy !== 'stratified')
      return drawCandidates(this.sqlite, { extraWhere: '', extraParams: [], dimensions, n: count })

    // 在旧的人工评分 1..5 上均分，每档内随机；某档抽干了就用随机候选补齐。
    const perLevel = Math.max(1, Math.floor(count / 5))
    const picked: number[] = []
    for (let level = 1; level <= 5; level++) {
      picked.push(...drawCandidates(this.sqlite, { extraWhere: 'AND p.score = ?', extraParams: [level], dimensions, n: perLevel }))
      if (picked.length >= count)
        return picked.slice(0, count)
    }
    const fill = count - picked.length
    if (fill > 0) {
      // 什么都没抽到时整条 NOT IN 都要省掉：三值逻辑下 `id NOT IN (NULL)` 对每一行都是
      // NULL，于是在全未评分的库上悄悄排除了**所有东西**，补齐永远是空的。
      const notIn = picked.length ? `AND p.id NOT IN (${placeholders(picked.length)})` : ''
      picked.push(...drawCandidates(this.sqlite, { extraWhere: notIn, extraParams: [...picked], dimensions, n: fill }))
    }
    return picked
  }

  /**
   * 为成对标注抽不相交的对。
   *
   * `random`  —— 任意不相交的对（快，与模型无关的基线）。
   * `similar` —— 内容相似（SigLIP2 KNN）**且**旧分同档：可比，所以判决是公平的（同类比
   * 同类，而不是竖构图对横构图）；分数接近，所以它有信息量（5 对 1 的判决结论已定，白费
   * 一个标签）。档位挂钩的是**人**的旧分而不是模型输出，于是收集到的数据仍与模型无关。
   * `close`   —— 同样内容相似，但按 SILVA 模型的分差配对而不是人工档位：**刻意**让采样
   * 感知模型，把标签集中在 head 分不开的边界对上（那是绝对分标签教不了的唯一信号）。用
   * close 收训练燃料，把 random/similar 留给与模型无关的留出评估。
   *
   * `dimension` 选定 close 所依托的比较历史：它绝不重问那里判过的对，并且把这一批挂到那张
   * 图上而不是另起孤岛。
   */
  samplePairs({ count, strategy = 'random', dimension = 'overall' }: { count: number, strategy?: string, dimension?: string }): Array<[number, number]> {
    // 重复测量是这一批的第四个通道，和 CALIBRATION_SHARE 一样是从 count 里**扣**而不是
    // 加在上面 —— REPEAT_SHARE 是工时税，5% 就该是 5% 的工时。抽不满（新库还没有够老的
    // 对）就把名额还给正常采样，免得批次凭空变小。
    //
    // 放在这里而不是放在路由里，是因为「一批 pairwise 该长什么样」本来就只由这个方法
    // 定义；提到路由去的话，走同一个 samplePairs 的 generate-pairwise 会静默地永远拿不到
    // 重复测量，而且这个缺失在代码里看不出来。
    const repeats = this.sampleRepeats({ count: repeatSlots(count), dimension })
    const fresh = this.samplePairsOrdered({ count: count - repeats.length, strategy, dimension })
    // 正常采样的**相对次序**原样保留：它是吃重的（interleaveWithBridges 保证每个前缀都
    // 连通）。重复对插在随机位置 —— 固定在头尾会让它有节奏可循，标注者一旦察觉「这条是
    // 考我的」，量到的就不是自然判断了。插入不破坏前缀连通性：重问的边两端本来就在图里。
    const out = fresh.map(pair => flipPair(pair))
    for (const pair of repeats)
      out.splice(Math.floor(Math.random() * (out.length + 1)), 0, flipPair(pair))
    return out
  }

  /**
   * 采样器自己的顺序 —— 对内的先后带着策略的痕迹（similar 是旧分低的在前），所以只有
   * samplePairs 经 flipPair 处理过的结果才能端给标注者。理由见 flipPair。
   */
  private samplePairsOrdered({ count, strategy = 'random', dimension = 'overall' }: { count: number, strategy?: string, dimension?: string }): Array<[number, number]> {
    if (strategy === 'similar')
      return this.samplePairsSimilar(count)
    if (strategy === 'close')
      return this.samplePairsClose(count, dimension)

    const ids = withEmbedding(this.sqlite, randomPairwiseEligible(this.sqlite, count * 4)).slice(0, count * 2)
    const out: Array<[number, number]> = []
    for (let i = 0; i + 1 < ids.length; i += 2) out.push([ids[i]!, ids[i + 1]!])
    return out
  }

  /**
   * 故意重问的老对 —— 唯一能量到标注噪声的通道。
   *
   * 取的是**均匀**样本，不是专挑平局的。均匀抽会按语料里的真实占比自动多抽到难对
   * （64% 的标签落在 |Δsilva| < 0.05，23% 是平局），于是既得到一个无偏的总体一致率，
   * 又攒够了平局样本供事后分层 —— 两条判决都在库里，按第一次的 winner 分组即可。
   * 反过来先按平局挑，总体那个数就废了，而它才是「天花板在哪」的答案。
   *
   * 三个筛选条件各有各的必要性：`HAVING COUNT(*) = 1` 保证一对最多只重问一次（否则
   * 均匀抽会反复咬住同一对）；`winner != 'skip'` 是因为跳过的对没有判决可比；
   * 时间下界见 REPEAT_MIN_AGE_DAYS。
   *
   * 返回归一化的 `[lo, hi]`；左右由 samplePairs 统一经 flipPair 决定，于是第二次的呈现
   * 顺序与第一次无关 —— 量到的才是判断本身稳不稳，而不是位置记忆。
   */
  sampleRepeats({ count, dimension = 'overall' }: { count: number, dimension?: string }): Array<[number, number]> {
    if (count <= 0)
      return []
    return repeatPairPool(this.sqlite, dimension, count)
  }

  /**
   * 重排一批够老的老组：成员原样、顺序重新打乱，用来量**你自己判两次有多一致**。
   *
   * 这是 listwise 侧唯一的噪声标尺，和 sampleRepeats 买的是同一样东西，只是单位从
   * 「一对」换成「一组」。没有它，边界组上模型的 0.60 就无从判断 —— 究竟是模型还没
   * 学会，还是那些对本来就是掷硬币，两种情况下该做的事正好相反。
   *
   * 三条入选条件：
   *
   * **只排过一次**。排过两次的组已经是一个重复测量了，第三次买到的是第三个样本而不是
   * 第一个标尺，而池子还没大到可以这么花。
   *
   * **每一次都够老**（不只是最近那次）—— 判据落在成员集合上而不是行上，所以先在 TS 里
   * 按排序后的 id 列表归组再筛。SQL 里直接 `created_at <= cutoff` 会漏掉「上周排过、
   * 昨天又排过一次」的组，把冷却期悄悄绕过去。
   *
   * **成员一个不缺**。少一张就不是同一组了，两次的成对集合对不上，一致率无从算起。
   *
   * 返回前打乱成员，和 sampleGroups 同一条理由 —— 而且这里更要紧：呈现顺序若和上次
   * 相同，量到的就是「还记不记得上次的样子」。
   *
   * 批内还要**互不相交**。老组之间天然共享成员（重访席位就是干这个的），实测一次
   * limit=3 的重测批里有两组同时含 9754/9758。同一屏之后紧接着再看同一张图，第二次
   * 的判断就被第一次锚住了 —— 而这里量的恰恰是判断的独立重复。
   */
  sampleRepeatGroups({ count, dimension = 'overall' }: { count: number, dimension?: string }): number[][] {
    if (count <= 0)
      return []
    const rows = rankedListwiseRows(this.sqlite, dimension)
    const seen = new Map<string, { ids: number[], times: number, newest: string }>()
    for (const r of rows) {
      const ids = JSON.parse(r.post_ids) as number[]
      const key = [...ids].sort((a, b) => a - b).join(',')
      const e = seen.get(key)
      if (e) {
        e.times++
        if (r.created_at > e.newest)
          e.newest = r.created_at
      }
      else { seen.set(key, { ids, times: 1, newest: r.created_at }) }
    }
    const cutoff = repeatCutoff(this.sqlite)
    const aged = [...seen.values()].filter(g => g.times === 1 && g.newest <= cutoff)
    if (aged.length === 0)
      return []
    const ids = [...new Set(aged.flatMap(g => g.ids))]
    const alive = existingPostIds(this.sqlite, ids)
    const pool = shuffle(aged.filter(g => g.ids.every(pid => alive.has(pid))).map(g => g.ids))
    const picked: number[][] = []
    const taken = new Set<number>()
    for (const ids of pool) {
      if (picked.length >= count)
        break
      if (ids.some(pid => taken.has(pid)))
        continue
      for (const pid of ids) taken.add(pid)
      picked.push(shuffle(ids))
    }
    return picked
  }

  /**
   * listwise 组：每组 `size` 张**同形态**、有人工绝对分、silva 分落在同一窗口、视觉上
   * 铺开的图。
   *
   * 一组 n 张的全序展开成 C(n,2) 条成对约束，而窗口约束（任意两成员 silva 分差 <=
   * CLOSE_PAIR_MAX_SILVA_DIFF）保证这些约束几乎全落在 head 分不开的边界上 —— 与 close
   * 成对采样同一逻辑，只是把"环"换成"整组排序"。
   *
   * 但那 C(n,2) 条边**不是** C(n,2) 次独立观测：全序由 n 个潜变量的一个排列生成，
   * Plackett-Luce 下整组的 Fisher 信息是 Σ_{k=2..n}(1−1/k)，折成势均力敌的 pairwise
   * 是 4 张 3.8 对、6 张 7.1 对、8 张 10.6 对 —— 不是 6 / 15 / 28。下游正是这么吃的
   * （silva 侧 `fit_latent.py --rankings` 走 `plackett_luce_nll`，不拆成独立成对）。
   *
   * **默认 4 张**，因为成本随 C(n,2) 走而信息只随 n − H_n 走。2026-09-06 实测每组中位
   * 耗时 10.6 / 25.9 / 51.9 s（n = 62 / 195 / 62 组），换算成每边 1.77 / 1.72 / 1.85 s
   * —— 三个点几乎重合在同一条正比于边数的直线上；于是每 PL 对当量 4 张 2.77 s 便宜过
   * 6 张 3.64 s 和 8 张 4.91 s。
   *
   * 4 张同时让度数记账最诚实：judgedGraph 给每个成员记 n−1 = 3 度，而有效当量是
   * (4/n)(n − H_n) = 1.92，虚高 1.56 倍；6 张是 5 度对 2.37（2.11 倍），8 张 7 对
   * 2.64（2.68 倍）。于是 CLOSE_PAIR_DEGREE = 3 大致回到「两次出场才退役」，接近它在
   * 成对时代被校准时的本意 —— 一次 6 张排序 +5 度直接跨过阈值、成员再不被重访，正是
   * 那条校准在 listwise 上失效的地方。
   *
   * 两条 close 没有的约束，理由分别在标注者和下游身上：
   *
   * **同形态**（见 formats.ts）。跨形态对占历史判决的 16%，胜率 0.49、平局 0.24 —— 窗口
   * 已经把质量配平了，剩下的是掷硬币；而标注者对着"立绘 vs 漫画哪个更好"确实开不了口。
   * 形态之间的相对位置由人工绝对分锚住（comic 均值 2.71 vs illust 3.24），不必再买一次。
   *
   * **全员有绝对分**（ANCHORED_ELIGIBLE）。没有绝对分的成员在 silva 的联合拟合里是个被
   * 丢弃的自由参数，对训练目标的贡献严格为零。2026-09-04 实测：138 组里两端都有锚的成对
   * 约束只占 29%，每组平均 3.07 张有分成员。做硬过滤而不是配额，正是因为剩下那些席位买
   * 到的不是"弱信号"而是"没有信号"。
   *
   * 凑不齐人时的退化顺序：放宽窗口到 LISTWISE_BAND_RELAXED -> 缩到 LISTWISE_MIN_GROUP
   * 张 -> 换种子。**不放宽形态、不放进无分图** —— 那两条正是这个采样器存在的全部理由。
   *
   * 其余复用同一套窗口机器：种子按有锚池的实际分布抽（于是组的形态占比跟随库的形态占比，
   * 这是中性默认；要给小形态加权是另一个常量的事），窗口内先塞 1~2 张已判但比较不足的
   * 同形态图（把这组缝进已有比较图），其余用最远点铺开（转载/近重复被 MAX_PAIR_COSINE
   * 硬停挡住）。
   *
   * 成员在返回前打乱：呈现顺序必须与任何有意义的量（分数、度数、抽样次序）无关，否则
   * 顺序效应与真实偏好在导出的数据里不可分。
   */
  sampleGroups(
    { count, size = 4, dimension = 'overall', repeatShare = REPEAT_SHARE, seedMinStars = LISTWISE_SEED_MIN_STARS }:
    { count: number, size?: number, dimension?: string, repeatShare?: number, seedMinStars?: number },
  ): number[][] {
    // 重测席位加在**上面**而不是额外发一组 —— 和 samplePairs 同一条：REPEAT_SHARE 是
    // 工时税，5% 就该是 5% 的工时。抽不满（新库还没有够老的组）时静默退化成全新组。
    const repeats = this.sampleRepeatGroups({ count: repeatSlots(count, repeatShare), dimension })
    count -= repeats.length
    const graph = this.judgedGraph(dimension)
    const anchored = anchoredPool(this.sqlite)
    const revisit = this.revisitPool(graph, dimension)
    // 与 samplePairsClose 同一个「已花费」概念：这一批已经拿走的图，**加上**纵观全部历史
    // 已经达到度数的图。漏掉后半截的话，窗口候选这条路径就永远不让任何人退役 —— 重访席位
    // 那条路径修好了也没用，同一张图照样能作为普通成员被反复抽中。
    const spent = graph.saturated()
    // 重测组的成员也算已花费：它们多半早已饱和（一次 listwise 就 +n−1 度），但"多半"
    // 不是保证，而同一批里让一张图既进重测组又进新组，两边都不干净。
    for (const g of repeats) for (const pid of g) spent.add(pid)
    const minGroup = Math.min(LISTWISE_MIN_GROUP, size)
    const groups: number[][] = []
    // 种子直接抽自有锚池，不再走 windowSeeds：那是一次全库 ORDER BY RANDOM()，而这里
    // 池子已经在内存里，且种子必须自带形态和绝对分。
    // 先按星级筛出够格的种子再抽样，而不是抽完再跳过：高分池只占有锚池的一半左右，
    // 后者会让 CLOSE_SEED_DRAW 里一半的名额落空，count 大时凑不满一批。
    const seedable = function* (): Generator<number> {
      for (const [pid, m] of anchored)
        if (m.stars >= seedMinStars)
          yield pid
    }
    for (const seedId of reservoir(seedable(), Math.max(CLOSE_SEED_DRAW, count * 2))) {
      if (groups.length >= count)
        break
      if (spent.has(seedId))
        continue
      const { silva: centre, format } = anchored.get(seedId)!
      const admit = (pid: number): boolean => anchored.get(pid)?.format === format
      let members: number[] = []
      for (const band of [CLOSE_PAIR_MAX_SILVA_DIFF, LISTWISE_BAND_RELAXED]) {
        const seeds = Sampler.revisitSeeds(revisit, graph, centre, spent, CLOSE_REVISIT_MEMBERS, admit, band)
        members = this.diverseSubset(Sampler.windowMembers(anchored, centre, band, format, spent), size, seeds)
        if (members.length >= size)
          break
      }
      if (members.length < minGroup)
        continue // 4 张以下不如把这个种子让给下一个窗口
      for (const pid of members) spent.add(pid)
      groups.push(shuffle(members))
    }
    // 混进去再打乱：重测组若总排在批次开头，它就自报家门了。
    return shuffle([...repeats, ...groups])
  }

  /**
   * 有锚池里落在 `[centre ± band/2]`、同形态、这一批还没花掉的成员，打乱后取
   * CLOSE_WINDOW_CANDIDATES 个。
   *
   * 语义和 windowCandidates 那条 SQL 一致（范围 + 排除 + 随机截断），只是数据已经在内存里。
   * 先打乱再截断，让 diverseSubset 的起点是随机的 —— 它的第一个成员就是候选数组的头一个。
   */
  private static windowMembers(
    anchored: Map<number, AnchoredMember>,
    centre: number,
    band: number,
    format: Format,
    exclude: Set<number>,
  ): number[] {
    const half = band / 2
    function* inside(): Generator<number> {
      for (const [pid, m] of anchored)
        if (m.format === format && Math.abs(m.silva - centre) <= half && !exclude.has(pid))
          yield pid
    }
    return reservoir(inside(), CLOSE_WINDOW_CANDIDATES)
  }

  // ─── similar：内容相似 + 旧分档位 ─────────────────────────────────
  //
  // 一次覆盖全库的 vec0 KNN 约 1.5 s（暴力扫，没有 ANN 索引），所以负担不起一对一次 KNN。
  // 改成每次 KNN 拉出一个种子的邻域，再从里面收割若干不相交的对：PAIRS_PER_CLUSTER 在批次
  // 延迟（约 1.5 s × ceil(count / PPC)）和一批里多少对共享同一个视觉邻域之间做取舍。

  private samplePairsSimilar(count: number): Array<[number, number]> {
    const clusters = Math.max(1, Math.ceil(count / SIMILAR_PAIRS_PER_CLUSTER))
    // 种子超量抽：一个种子可能已经被前一个簇当邻居消费掉，或者所在区域根本没有同档的搭档。
    const seeds = randomPairwiseEligible(this.sqlite, clusters * 4)

    const used = new Set<number>()
    const pairs: Array<[number, number]> = []
    for (const seed of seeds) {
      if (pairs.length >= count)
        break
      if (used.has(seed))
        continue
      // pairByScoreBand 容得下只有种子一个成员的簇（返回 []），所以这里不需要成员数守卫。
      const members = this.similarCluster(seed, used) // similar 保持严格不相交
      const cap = Math.min(SIMILAR_PAIRS_PER_CLUSTER, count - pairs.length)
      pairs.push(...this.pairByScoreBand(members, used, cap))
      used.add(seed) // 已作为中心被消费 —— 不再重抽也不再参与配对
    }
    return pairs.slice(0, count)
  }

  /**
   * 种子 KNN 邻域内合格 post 的 `(id, score)`。
   *
   * 含种子自己；丢掉近重复（近乎相同的一对是必然的平局）、`exclude` 里的 id，以及成对资格
   * 不过的 id。种子没有 embedding 时返回 `[]`。
   *
   * `exclude` 是各策略各自认定的"已花费"：similar 传已配过对的 id（严格不相交），close 只传
   * 已达到 CLOSE_PAIR_DEGREE 的 id，于是一张图可以跨邻域复现并把它们缝成一张比较图。
   */
  private similarCluster(seed: number, exclude: Set<number>): IdScoreRow[] {
    const rows = knn(this.sqlite, seed, SIMILAR_KNN_K)
    if (!rows.length)
      return []
    const memberIds = [seed]
    for (const [pid, dist] of rows)
      if (pid !== seed && dist >= SIMILAR_MIN_DISTANCE && !exclude.has(pid))
        memberIds.push(pid)
    return pairwiseEligibleScores(this.sqlite, memberIds)
  }

  /**
   * 贪心地把簇成员配成不相交的同档/相邻档对。
   *
   * 有分的成员（旧分 >= 1）按分排序，和分数上最近的邻居配 —— 排序后相邻就是可能的最小间隔；
   * 只有当连这个间隔都超出档宽时才拒绝这一对（并把较低的那个搁浅），于是一张分数上孤立的图
   * 永远不会被硬塞进一个 5 对 1 的必然结论。没分的成员（score 0 = 从未评过）共享一个桶，
   * 自由配对：它们的质量未知，所以任何同内容的配对都是公平且有信息量的比较。`used` 边配边改，
   * 让整批保持不相交。
   *
   * 比 MAX_PAIR_COSINE 更近的对会被丢掉，理由和 close 里一样：KNN 过滤只量到种子的距离，
   * 所以它的两个邻居仍可能互为副本，而那个判决在你看之前就是平局。
   */
  private pairByScoreBand(members: IdScoreRow[], used: Set<number>, cap: number): Array<[number, number]> {
    const unit = unitVectors(this.sqlite, members.map(m => m.id))
    const tooAlike = (a: number, b: number): boolean => {
      const ua = unit.get(a)
      const ub = unit.get(b)
      return ua !== undefined && ub !== undefined && cosine(ua, ub) >= MAX_PAIR_COSINE
    }

    const out: Array<[number, number]> = []
    const scored = members
      .filter(m => m.score && !used.has(m.id))
      .sort((x, y) => x.score - y.score)
    let i = 0
    while (i + 1 < scored.length && out.length < cap) {
      const a = scored[i]!
      const b = scored[i + 1]!
      if (Math.abs(a.score - b.score) <= SIMILAR_SCORE_BAND && !tooAlike(a.id, b.id)) {
        out.push([a.id, b.id])
        used.add(a.id)
        used.add(b.id)
        i += 2
      }
      else {
        i += 1 // `a` 在更高分那边没有能用的搭档
      }
    }
    const unscored = members.filter(m => !m.score && !used.has(m.id)).map(m => m.id)
    for (let j = 0; j + 1 < unscored.length; j += 2) {
      if (out.length >= cap)
        break
      const a = unscored[j]!
      const b = unscored[j + 1]!
      if (tooAlike(a, b))
        continue
      out.push([a, b])
      used.add(a)
      used.add(b)
    }
    return out
  }

  // ─── close：内容相似 + SILVA 模型分档 ────────────────────────────

  /** `post_id -> SILVA calibrated_score`（没有分的 id 会被丢掉）。 */
  private loadSilvaScores(ids: number[]): Map<number, number> {
    return scorerValuesFor(this.sqlite, ids, SILVA.name)
  }

  /**
   * 按 SigLIP2 余弦算，候选里视觉上最铺得开的 `target` 个。
   *
   * `seeds` 是这个块必须包含的成员 —— 它们无条件占位，贪心搜索在它们**周围**填满其余，于是
   * 它是从已有的东西向外铺开，而不是从头来过。这正是重访池（revisitSeeds）能拿到环里一个确定
   * 席位、而不是在 96 个候选里抽彩票的原因。没有 seeds 时，它就是原来那个朴素的最远点搜索。
   *
   * 一个 silva 窗口已经说了它的成员一样好；它对成员长得像不像只字未提，放着不管，从 21.4 万张
   * 库里抽出的窗口会交回那个分数区间里碰巧有的任何东西。选出铺得开的子集，才让差 φ_a - φ_b
   * 张开特征空间而不是塌进一个视觉口袋的方向上 —— 而这些差恰恰是用这些比较训练的 head 的
   * 可辨识性所在。
   *
   * 它还能换回判决。在已有历史上，余弦 0.85–0.94（旧 KNN 采样器待的地方，中位 0.86）的平局率
   * 是 28.2%，而 0.65 以下是 15.1%：像，正是评判者叫不准的地方，所以铺开不是装饰。
   *
   * 用贪心最远点而不是余弦上限：固定阈值要么让稀疏窗口搁浅（没有子集过得了线，那段分数区间
   * 就完全采不到东西），要么在稠密窗口里全部放行。Max-min 无论窗口里有什么，总能返回它所能
   * 给出的最好铺开。MAX_PAIR_COSINE 仍作为硬停：一个已入选成员的转载是必然的平局，不管还剩
   * 多少空位。
   */
  private diverseSubset(candidates: number[], target: number, seeds: readonly number[] = []): number[] {
    const unit = unitVectors(this.sqlite, [...seeds, ...candidates])
    const picked = seeds.filter(pid => unit.has(pid)).slice(0, target)
    const inPicked = new Set(picked)
    const pool = candidates.filter(pid => unit.has(pid) && !inPicked.has(pid))
    if (!picked.length) {
      if (!pool.length)
        return []
      picked.push(pool.shift()!) // 候选是打乱着来的，所以起点已经是随机的
    }
    const worst = new Map<number, number>()
    for (const pid of pool) {
      let m = Number.NEGATIVE_INFINITY
      for (const q of picked) m = Math.max(m, cosine(unit.get(pid)!, unit.get(q)!))
      worst.set(pid, m)
    }
    while (picked.length < target && worst.size) {
      let nxt = -1
      let best = Number.POSITIVE_INFINITY
      for (const [pid, w] of worst)
        if (w < best) {
          best = w
          nxt = pid
        }
      if (best >= MAX_PAIR_COSINE)
        break // 剩下的全是已入选者的副本
      picked.push(nxt)
      worst.delete(nxt)
      for (const [pid, prev] of worst)
        worst.set(pid, Math.max(prev, cosine(unit.get(pid)!, unit.get(nxt)!)))
    }
    return picked
  }

  /**
   * silva 分落在离 `centre` 半个带以内的合格图片。
   *
   * 两侧各半个带，于是窗口里任何两个成员最多差一整个 CLOSE_PAIR_MAX_SILVA_DIFF，每一对天然
   * 在带内 —— 不用排序、不用脊、不用逐边查档。
   *
   * 过量取回后在 JS 里过滤 `exclude` 而不是写进 SQL：排除集是这批已花费的图片加上所有已达
   * 度数的图片，在已有历史上超过一千个 id —— 那么大的绑定变量列表，在 LIMIT 只有目标三倍且
   * 不要钱的时候，值得避开。
   */
  private windowCandidates(centre: number, exclude: Set<number>): number[] {
    const half = CLOSE_PAIR_MAX_SILVA_DIFF / 2
    return silvaInRange(this.sqlite, centre - half, centre + half, CLOSE_WINDOW_CANDIDATES * 3)
      .filter(pid => !exclude.has(pid))
      .slice(0, CLOSE_WINDOW_CANDIDATES)
  }

  /**
   * 还想要边的已判图片的 `post_id -> silva 分`。
   *
   * 整批一条查询拿到整个池子，之后每个窗口的切片就是在内存里扫几千个浮点数（见 revisitSeeds）
   * —— 窗口是一个分数区间，没有哪个索引能比这更快地回答"已判过 AND 落在这个区间里"。
   */
  private revisitPool(graph: PairGraph, dimension: string): Map<number, number> {
    const out = new Map<number, number>()
    for (const row of judgedSilvaRows(this.sqlite, dimension))
      if (!graph.spent(row.id))
        out.set(row.id, row.score)
    return out
  }

  /**
   * 分数落在这个窗口里、比较次数最少的 `n` 张已判图片。
   *
   * 这是让一批**加厚**图而不是只延伸图的东西。锚点已经把这批挂到主分量上，但每个锚点只贡献
   * 一条桥，再无其它，所以在此之前一个块里的已判图片只有 21.4 万随机抽取碰巧撞上的那些 ——
   * 实测一次真实补充，19 张图里 13 张全新，环闭合在从未比较过的图片之间。环是已有历史最缺的
   * 冗余（只有 4.2% 的边落在环上），而一个环穿**过**已有的图时，远比在它旁边闭合值钱。
   *
   * 比较少的优先，于是度数 1 的图片优先于度数 2 的：两条环边把前者带到恰好 CLOSE_PAIR_DEGREE，
   * 而不是越过它。
   *
   * 同度数之间必须**随机**取，不能让 nSmallest 的稳定平局序说了算 —— 那个序来自 pool 的
   * Map 插入序，也就是一条没有 ORDER BY 的 SQL 的扫描序，每次调用都一样。历史上库里有 5015
   * 张度数 1 的图，而 2026-08-20 的 44 个组里反复被征召的始终是同样那几张：它们只是恰好排在
   * 扫描序的前面。先洗牌再取，同度数的候选才是等概率的（drawAnchors 早就是这个路子：先按度数
   * 取一大片候选，再 ORDER BY RANDOM）。
   *
   * `admit` 和 `band` 是给 listwise 用的，两个都有默认值，所以 windowBlock 那条调用式
   * 和行为都不变。重访席位必须和普通席位守同一条规矩：CLOSE_REVISIT_MEMBERS 是一组 6
   * 张里的 2 张，不收它的话"同形态、有绝对分"就只是名义上的，三分之一的席位照样漏。
   */
  private static revisitSeeds(
    pool: Map<number, number>,
    graph: PairGraph,
    centre: number,
    exclude: Set<number>,
    n: number,
    admit: (pid: number) => boolean = () => true,
    band = CLOSE_PAIR_MAX_SILVA_DIFF,
  ): number[] {
    const half = band / 2
    const inside: number[] = []
    for (const [pid, score] of pool)
      if (Math.abs(score - centre) <= half && !exclude.has(pid) && admit(pid))
        inside.push(pid)
    return nSmallest(n, shuffle(inside), pid => graph.degreeOf(pid))
  }

  /**
   * 一个块：某个 silva 窗口里视觉上最分散的成员，连成一个环。
   *
   * 块的一部分抽自已经在比较图里的图片（revisitSeeds），其余抽自整个库，于是这个环把比较不足
   * 的老图片和新图片缝在一起。
   *
   * 返回的是 Block —— 边加上其它块搭桥用的 `(代表, 分数)` —— 经由 connectedBlocks，因为一次
   * claim 可能对几个月前就问过的一对返回 `null`，那会把环切成几段弧。每段弧都得单独搭桥，
   * 否则只有含代表的那段并进了图。
   */
  private windowBlock(graph: PairGraph, centre: number, revisit: Map<number, number>, exclude: Set<number>, cap: number): Block[] {
    // m 个成员的环带 m 条边 —— 除了 m = 2，那是单独一次比较。所以 cap 为 1 时恰好要两个成员，
    // 再大就至少要三个：要 `cap` 个成员会在 cap = 2 时交回一个两成员的块，把一半预算花在无用功上。
    const target = cap <= 1 ? PAIR_MEMBERS : Math.min(CLOSE_BLOCK_MEMBERS, Math.max(MIN_CYCLE_MEMBERS, cap))
    const seeds = Sampler.revisitSeeds(revisit, graph, centre, exclude, Math.min(CLOSE_REVISIT_MEMBERS, target - 1))
    const members = this.diverseSubset(this.windowCandidates(centre, exclude), target, seeds)
    if (members.length < PAIR_MEMBERS)
      return []
    for (const pid of members) exclude.add(pid)
    const edges: Array<[number, number]> = []
    for (const [a, b] of cycleEdges(members)) {
      const edge = graph.claim(a, b)
      if (edge)
        edges.push(edge)
    }
    const capped = edges.slice(0, cap)
    return capped.length ? connectedBlocks(capped, centre) : []
  }

  /**
   * 已经建好的比较图，作为这一批的起始状态。
   *
   * 采样必须跨调用有状态，否则流式标注根本累加不起来：UI 一次要 20 对，所以每次调用都从空图
   * 开始的话，每次补充都有自己的连通分量和自己的度数预算 —— 2026-08-06 实测，10 次补充正好
   * 10 个分量。
   *
   * 把它读回来让四件事同时成立：一对永远不会被问两次（跨会话跨月份也是）、已经比过
   * CLOSE_PAIR_DEGREE 次的图片不再消耗预算、中间那些图片可以给 drawAnchors 当桥头堡，以及
   * 胜负记录就在那里供 calibrationBlocks 找出仍然无界的评分。
   *
   * `skip` 判决算问过但不算比过 —— 你跳过这一对是有原因的，所以它不该再回来，但它没有产生
   * 任何排序信息，不该占掉任何一方的度数配额。
   *
   * **listwise 的排序在这里展开成对**。一组 n 张的全序就是 C(n,2) 条边（迁移 0016 写的
   * "排序结果在训练侧分解为对"，采样侧同理），事件行本身留在 listwise_annotations 里不动 ——
   * 那是两张按形态分开的 append-only 事件表，展开只发生在读侧。
   *
   * 不展开的代价是实测过的：到 2026-08-20，44 个已排的组里 post 8884 出现了 11 次、8848
   * 出现 10 次，两者同组 9 次；它们在这张图里的度数却始终是 1，因为排序没有产生任何
   * pairwise 行。于是 revisitSeeds 每次都把这两张当"比较不足"重新征召，谁都排不空。展开之后
   * 一次 6 张的排序就让每个成员 +5，直接越过 CLOSE_PAIR_DEGREE，它们才会正常退役。
   */
  private judgedGraph(dimension: string): PairGraph {
    const graph = new PairGraph(CLOSE_PAIR_DEGREE)
    for (const { a, b, winner, source } of comparisonEdges(this.sqlite, dimension)) {
      // 重复测量会让同一条边出现多行。度数量的是「跟多少张不同的图比过」，不是「产生过
      // 多少行」—— 同一对量三次仍然只是一次比较，不该把双方推向饱和。
      const key = edgeKey(a, b)
      const fresh = !graph.emitted.has(key)
      graph.emitted.add(key)
      if (winner === 'skip' || !fresh)
        continue
      if (winner === 'a' || winner === 'b') {
        const [won, lost] = winner === 'a' ? [a, b] : [b, a]
        graph.wins.set(won, (graph.wins.get(won) ?? 0) + 1)
        graph.losses.set(lost, (graph.losses.get(lost) ?? 0) + 1)
      }
      // listwise 的度数不在这里记 —— 逐边记就是 n−1，见 LISTWISE_APPEARANCE_DEGREE。
      // 边本身仍然要走完上面：emitted 决定不重问，wins/losses 决定谁的分还无界。
      if (source === 'listwise')
        continue
      graph.bump(a)
      graph.bump(b)
    }
    // listwise 按**出场**记：一次出场每个成员 +LISTWISE_APPEARANCE_DEGREE，与组多大无关。
    // 同一成员集合被重测过两次就是两次出场，各记一次 —— 那确实是两次独立观测。
    for (const { post_ids: postIds } of rankedListwiseRows(this.sqlite, dimension)) {
      for (const pid of JSON.parse(postIds) as number[])
        for (let i = 0; i < LISTWISE_APPEARANCE_DEGREE; i++) graph.bump(pid)
    }
    return graph
  }

  /**
   * **主分量**里可供搭桥的图片的 `(post_id, silva 分)`。
   *
   * "已经判过"这个条件不够强。2026-06 的历史是 5184 张图 2488 个分量，所以从已判集合里均匀
   * 抽出的锚点几乎总是某条孤立老边的成员：于是每次补充都挂到不同的孤岛上，分量数随每一批
   * 攀升（实测：十次补充 2 → 15，最大分量从 90.9% 掉到 9.8%）。改成在最大分量内部下锚，才让
   * 每一批都在延伸同一张图 —— 这是唯一能以全局排序收尾的版本。
   *
   * 优先取那个分量里比较次数最少的成员 —— 它们才是还需要边的，于是一次抽取既连通了这一批又
   * 加厚了图。候选切片有上界，因为它会变成绑定变量列表。
   */
  private drawAnchors(graph: PairGraph, component: Set<number>, n: number): IdScoreRow[] {
    const pool = [...component].filter(pid => !graph.spent(pid))
    if (!pool.length)
      return []
    const candidates = nSmallest(ANCHOR_CANDIDATES, pool, pid => graph.degreeOf(pid))
    return silvaEligibleAmong(this.sqlite, candidates, n)
  }

  /**
   * 给那些评分没有上界（或下界）的图片各一次比较。
   *
   * 一张赢遍了它所遇到的一切的图不是"最好的" —— 它是没被定位。它的 Bradley-Terry 似然没有
   * 最大值，而它自己那个 SILVA 带里的任何东西都修不了这一点，因为横扫正是那个带造成的。所以
   * 它的对手要**刻意**抽在带外，抽在它从没被击败过的那一侧：赢遍一切的去遇上模型明显给分更高
   * 的，输遍一切的去遇上明显更低的。0.15–0.25 的理由见 CALIBRATION_GAP。
   *
   * 这些边在结构上不花钱 —— 一个端点已经深在图里 —— 而且它们把这批拽出单一视觉口袋，因为搭档
   * 来自分数区间的另一部分而不是种子的邻域。
   */
  private calibrationBlocks(graph: PairGraph, component: Set<number>, budget: number): Block[] {
    const needy: Array<[number, number]> = []
    for (const pid of component) {
      if (graph.spent(pid))
        continue
      const direction = graph.unbounded(pid)
      if (direction)
        needy.push([pid, direction])
    }
    if (!needy.length)
      return []
    // 决定性判决最多的排前面：那些横扫最该被定界了
    const decisive = (pid: number) => (graph.wins.get(pid) ?? 0) + (graph.losses.get(pid) ?? 0)
    needy.sort((x, y) => decisive(y[0]) - decisive(x[0]))
    const scores = this.loadSilvaScores(needy.slice(0, budget * 4).map(([pid]) => pid))

    const [lo, hi] = CALIBRATION_GAP
    const blocks: Block[] = []
    for (const [pid, direction] of needy) {
      if (blocks.length >= budget)
        break
      const base = scores.get(pid)
      if (base === undefined)
        continue
      const window: [number, number] = direction > 0 ? [base + lo, base + hi] : [base - hi, base - lo]
      const partner = partnerInWindow(this.sqlite, window)
      if (partner === null)
        continue
      const edge = graph.claim(pid, partner)
      if (edge)
        blocks.push([[edge], [pid, base]])
    }
    return blocks
  }


  /**
   * SILVA head 打分接近、但被刻意抽得视觉上**不像**的那些对。
   *
   * 每个块是一个 silva 窗口（windowBlock）：成员之间天然在带内，按 SigLIP2 空间里的最大分散度
   * 挑选，再连成一个环。收集到的比较值不值钱由三个性质决定，每一个都在这里：
   *
   * * **在带内** —— 窗口宽 CLOSE_PAIR_MAX_SILVA_DIFF，所以每条边都是模型自己叫不准的比较；
   * * **视觉分散** —— 旧的 KNN 邻域把成员钉在余弦中位 0.86，那里 28.2% 的判决回来是"平局"，
   *   而且差 φ_a - φ_b 全指向同一个方向。窗口只按分数抽，于是成员可以在特征空间里被拉开；
   * * **能累加** —— 这一批从已经收集到的比较图开始（judgedGraph），下锚进去，块与块之间互相
   *   搭桥，于是每 15 次判决补充一次的流式会话是在不断延伸**同一张**图，而不是每次铺下一座
   *   新孤岛。
   */
  private samplePairsClose(count: number, dimension = 'overall'): Array<[number, number]> {
    const graph = this.judgedGraph(dimension)
    // 在任何 claim 之前取：锚点和定界都挂靠在**已经收集到的**主分量上（见 mainComponent）。
    const component = graph.mainComponent()
    // 锚点自己不带边；它们存在只是为了让桥落在一张已经在图里的图片上。interleaveWithBridges
    // 里的排序会把每个锚点放在分数上离它最近的块旁边。
    const blocks: Block[] = this.drawAnchors(graph, component, CLOSE_ANCHORS).map(a => [[], [a.id, a.score]] as Block)
    blocks.push(...this.calibrationBlocks(graph, component, Math.max(1, Math.round(count * CALIBRATION_SHARE))))
    // **这一批**的已花费：一个窗口不能再提供前一个窗口拿走的图片，也不能把预算花在一张纵观
    // 全部历史已经达到度数的图片上。
    const spent = graph.saturated()
    const revisit = this.revisitPool(graph, dimension)
    const seeds = windowSeeds(this.sqlite, CLOSE_SEED_DRAW)
    let seedIdx = 0

    // 桥要从 `count` 里出，不是加在它上面。k 个块需要 k - 1 条桥，而加上这个块就有
    // `blocks.length` 条 —— 所以要从块的 cap 里减掉那么多边。不预留的话，块正好填满预算，
    // 而末尾的截断把桥切掉，这是无声的：批次看着大小正确，回来却是断开的。用 `> 0` 而不是
    // `>= 0`：cap 为零仍要花掉一个窗口的查询，而且只可能返回空。
    for (;;) {
      const used = blocks.reduce((n, [edges]) => n + edges.length, 0)
      const cap = count - used - blocks.length
      if (cap <= 0)
        break
      let centre: number | null = null
      while (seedIdx < seeds.length) {
        const seed = seeds[seedIdx++]!
        if (!spent.has(seed.id)) {
          centre = seed.score
          break
        }
      }
      if (centre === null)
        break // 这一批把抽到的种子花光了
      const harvest = this.windowBlock(graph, centre, revisit, spent, cap)
      if (!harvest.length)
        break // 库里没有这一批还没花掉的窗口了
      blocks.push(...harvest)
    }

    return interleaveWithBridges(blocks, graph, count)
  }
}

/** 为绝对标注抽 post id。 */
export function samplePostIds(
  sqlite: BetterSqlite3.Database,
  opts: { count: number, strategy: string, dimensions: string[] },
): number[] {
  return new Sampler(sqlite).samplePostIds(opts)
}

/** 为成对标注抽不相交的对。 */
export function samplePairs(
  sqlite: BetterSqlite3.Database,
  opts: { count: number, strategy?: string, dimension?: string },
): Array<[number, number]> {
  return new Sampler(sqlite).samplePairs(opts)
}

/** 为 listwise 标注抽分数相近、视觉铺开的组。 */
export function sampleGroups(
  sqlite: BetterSqlite3.Database,
  opts: { count: number, size?: number, dimension?: string, repeatShare?: number, seedMinStars?: number },
): number[][] {
  return new Sampler(sqlite).sampleGroups(opts)
}
