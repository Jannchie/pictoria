/**
 * 标注采样 —— 对应 Python 侧 `db/repositories/annotation_queues.py` 里不涉及 CRUD
 * 的那一半（约 700 行）。
 *
 * 采样完全跑在 pictoria 自己拥有的数据上：旧的人工评分、SigLIP2 向量、已经收集到的
 * 标注事件。所以整个标注闭环是自洽的，下游消费者只**读**事件。
 *
 * 下面每个常量的取值都是在真实库上测出来的，不是拍脑袋的默认值 —— 改之前先读注释。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { AESTHETIC_SCORES_TABLE, SILVA } from '../scorers.js'
import { cosine, existingVectors, knn, unitVectors } from './vectors.js'

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

// 这两个不是可调参数而是算术 —— 上面每一条都是测量值，这两条是结构事实。一次比较要两张图；
// 最小的环要三张。两个成员的块因此是一次比较而不是一个环：把它闭合等于把同一个问题问两遍。
const PAIR_MEMBERS = 2
const MIN_CYCLE_MEMBERS = 3

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
/** 一条判决算不上横扫。 */
const CALIBRATION_MIN_DECISIVE = 2

/** 已经连在一起的边，加上其它块用来搭桥的 `(post_id, score)`。 */
export type Block = [Array<[number, number]>, [number, number]]

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

/** 无向边表的连通分量：`root -> members`。 */
function components(edges: Iterable<[number, number]>): Map<number, Set<number>> {
  const parent = new Map<number, number>()

  function find(x: number): number {
    if (!parent.has(x))
      parent.set(x, x)
    let cur = x
    while (parent.get(cur)! !== cur) {
      // 路径减半，与 Python 侧 `parent[x] = parent[parent[x]]` 逐步等价
      const grand = parent.get(parent.get(cur)!)!
      parent.set(cur, grand)
      cur = grand
    }
    return cur
  }

  for (const [a, b] of edges) parent.set(find(a), find(b))
  const groups = new Map<number, Set<number>>()
  for (const pid of [...parent.keys()]) {
    const root = find(pid)
    let g = groups.get(root)
    if (!g) {
      g = new Set()
      groups.set(root, g)
    }
    g.add(pid)
  }
  return groups
}

/**
 * 首尾相接的相邻对 —— m 个成员，m 条边。
 *
 * 是环而不是原来那条路径。两者都能连通这个块，但同样的边数下路径把两端留在度数 1 且不含
 * 环，而这个让每个成员度数 2 并闭合一个圈。多那一条边图的就是冗余：圈是矛盾判决唯一能显形
 * 为矛盾的地方，而在已有历史里只有 4.2% 的边落在任何圈上。
 *
 * 成员不需要排序。它们来自同一个 silva 窗口，所以其中**每一对**天然在带内 —— 这正是顺序
 * 可以被腾出来干别的的原因（见 diverseSubset）。
 */
function* cycleEdges(members: number[]): Generator<[number, number]> {
  if (members.length < PAIR_MEMBERS)
    return
  if (members.length === PAIR_MEMBERS) {
    yield [members[0]!, members[1]!]
    return
  }
  for (const [i, a] of members.entries())
    yield [a, members[(i + 1) % members.length]!]
}

/** 把一个连通边表重排，使每条边都碰到前面某条边用过的图片。 */
function breadthFirst(edges: Array<[number, number]>): Array<[number, number]> {
  const remaining = [...edges]
  const ordered = [remaining.shift()!]
  const seen = new Set<number>(ordered[0]!)
  while (remaining.length) {
    let idx = remaining.findIndex(e => seen.has(e[0]) || seen.has(e[1]))
    if (idx < 0)
      idx = 0
    const [nxt] = remaining.splice(idx, 1) as [[number, number]]
    ordered.push(nxt)
    seen.add(nxt[0])
    seen.add(nxt[1])
  }
  return ordered
}

/**
 * 把一个窗口的边拆成真正连在一起的若干块。
 *
 * 通常只有一块，而且这是构造保证而非运气：环掉任何一条边仍是路径，且 cycleEdges 按链序
 * 产出，于是截断出的前缀也是连通的。这里防的是那两条覆盖不到的情况 —— 窗口的**两**条边
 * 从 PairGraph.claim 回来时已被问过，把环切成了几段弧。
 *
 * 这罕见但并非不可能：它需要从 21.4 万张的库里抽到的两个成员此前比较过，而且恰好落在抽取
 * 给它们的相邻位置上。罕见到合成 fixture 永远碰不到，又常见到在有几千张已判图片的真实库上
 * 会发生。给搭桥那一趟只交一个断环的代表，意味着只有含代表的那段弧并入了图，另一段悄悄成了
 * 孤岛 —— 悄悄地，因为批次大小看着还是对的。逐段弧搭桥才让"一批是连通的"从意图变成事实。
 *
 * `score` 是窗口中心，各块共享：所有成员都在离它半个带以内，比 interleaveWithBridges 里
 * 那次排序能用到的粒度更细。
 *
 * 块内的边按广度优先重排，代表是**第一条**边的一个端点。这两件事让 interleaveWithBridges
 * 能在块之间轮转而不破坏连通性：搭到某块上的桥落在这块第一条边也碰到的那张图上，而这块后面
 * 每条边都碰到已经发出过的图。
 */
function connectedBlocks(edges: Array<[number, number]>, score: number): Block[] {
  const rootOf = new Map<number, number>()
  for (const [root, members] of components(edges))
    for (const pid of members) rootOf.set(pid, root)
  const byRoot = new Map<number, Array<[number, number]>>()
  for (const edge of edges) {
    const root = rootOf.get(edge[0])!
    const list = byRoot.get(root)
    if (list)
      list.push(edge)
    else byRoot.set(root, [edge])
  }
  const blocks: Block[] = []
  for (const chunk of byRoot.values()) {
    const ordered = breadthFirst(chunk)
    blocks.push([ordered, [ordered[0]![0], score]])
  }
  return blocks
}

/** 无序对的键 —— Python 侧 `frozenset((a, b))` 的等价物。 */
function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/** 取 `n` 个 key 最小的元素，平局保持原顺序（≡ Python `heapq.nsmallest`）。 */
function nSmallest<T>(n: number, items: T[], key: (x: T) => number): T[] {
  return items
    .map((item, i) => ({ item, i, k: key(item) }))
    .sort((x, y) => x.k - y.k || x.i - y.i)
    .slice(0, n)
    .map(x => x.item)
}

/**
 * 一轮采样的边簿记：什么已经问过，以及每张图被用了几次。
 *
 * 它存在是为了让配对那几趟和搭桥那一趟共享同一个"已花费"的概念，而不是各自拎着 `out` /
 * `emitted` / `degrees` / `cap` 这些散参数。`saturated` 是增量维护的，不是每个种子从
 * `degrees` 重算一遍。
 */
export class PairGraph {
  readonly degrees = new Map<number, number>()
  readonly emitted = new Set<string>()
  readonly saturated = new Set<number>()
  /** 每张图的决定性战绩，用来找出评分还无界的那些。 */
  readonly wins = new Map<number, number>()
  readonly losses = new Map<number, number>()
  /**
   * `emitted` 从历史载入后的最大连通分量 —— 也就是值得生长的那部分图，因为排序只能在
   * 一个分量内部推出来。**故意不被** `claim` 更新：它描述的是已经收集到的东西，而那正是
   * 下一批要挂靠的对象。
   */
  component = new Set<number>()

  constructor(readonly degree: number) {}

  /** `emitted` 的最大连通分量的成员。 */
  mainComponent(): Set<number> {
    const edges = [...this.emitted].map((key) => {
      const [a, b] = key.split(':')
      return [Number(a), Number(b)] as [number, number]
    })
    let best = new Set<number>()
    for (const members of components(edges).values())
      if (members.size > best.size)
        best = members
    return best
  }

  degreeOf(pid: number): number {
    return this.degrees.get(pid) ?? 0
  }

  spent(pid: number): boolean {
    return this.degreeOf(pid) >= this.degree
  }

  /** 度数 +1，够了就进 `saturated`。 */
  bump(pid: number): void {
    this.degrees.set(pid, this.degreeOf(pid) + 1)
    if (this.spent(pid))
      this.saturated.add(pid)
  }

  /**
   * `pid` 从没输过返回 `+1`，从没赢过返回 `-1`，否则 `0`。
   *
   * 符号就是它下一个对手该在的方向。只有在这张图拿到 CALIBRATION_MIN_DECISIVE 条决定性
   * 判决之后才有意义 —— 一次胜利说明不了横扫。平局两边都不算：平局同时从两侧给评分定了界，
   * 而那恰恰是这些图片缺的东西。
   */
  unbounded(pid: number): number {
    const wins = this.wins.get(pid) ?? 0
    const losses = this.losses.get(pid) ?? 0
    if (wins + losses < CALIBRATION_MIN_DECISIVE)
      return 0
    if (!losses)
      return 1
    return wins ? 0 : -1
  }

  /** 记下这次比较；自配对或已经问过则返回 `null`。 */
  claim(a: number, b: number): [number, number] | null {
    const key = edgeKey(a, b)
    if (a === b || this.emitted.has(key))
      return null
    this.emitted.add(key)
    this.bump(a)
    this.bump(b)
    return [a, b]
  }
}

/**
 * 候选必须有 embedding（训练时要 join 它）、不能是被隐藏的近重复、不能在任何一个被请求的
 * 维度上已经标注过，也不能待在一个未完成的队列项里。
 *
 * 性能：embedding 检查是 vec0 虚表查询，**不是**便宜的 B-tree 探测 —— 放进 WHERE 会让
 * SQLite 每行 posts 都跑一次（约 10 万次查询，几十秒）。所以采样分两段：先只用普通表谓词
 * 抽一批超量的随机候选，再对这一小批做 vec0 过滤。
 */
const CANDIDATE_WHERE
  = 'p.canonical_post_id IS NULL '
    + 'AND NOT EXISTS (SELECT 1 FROM absolute_queue_items i WHERE i.post_id = p.id AND i.done = 0) '
    + 'AND NOT EXISTS (SELECT 1 FROM absolute_annotations a WHERE a.post_id = p.id AND a.dimension IN ({dims}))'

/** 成对资格：canonical（没有被隐藏的近重复）且不在未完成的成对队列项里。两个策略共享。 */
const PAIRWISE_ELIGIBLE
  = 'p.canonical_post_id IS NULL AND NOT EXISTS (SELECT 1 FROM pairwise_queue_items i WHERE (i.post_a = p.id OR i.post_b = p.id) AND i.done = 0)'

/**
 * 仍值得比较的图片的 `(id, silva 分)`。close 的四条采样查询都是这条语句加个尾巴 —— 一个
 * 分数区间、一个 id 列表 —— 和它们自己的 LIMIT，所以 join 和资格子句在这里写一次，而不是把
 * scorer 名字硬编码四遍。两半都不绑定参数，这正是每个调用方都能直接追加自己的参数而不用记
 * 偏移量的原因。
 */
const SILVA_ELIGIBLE
  = `SELECT p.id, s.score FROM posts p `
    + `JOIN ${AESTHETIC_SCORES_TABLE} s ON s.post_id = p.id AND s.scorer = '${SILVA.name}' `
    + `WHERE ${PAIRWISE_ELIGIBLE}`

interface IdScoreRow { id: number, score: number }

export class Sampler {
  constructor(private readonly sqlite: BetterSqlite3.Database) {}

  /**
   * 只保留有 SigLIP2 embedding 的 id，保持抽取顺序。
   *
   * 一次集合查询而不是每个 id 探一次：一次约 1.5 ms，逐个探的写法在
   * `generate-pairwise count=200` 里光是配对开始前就花掉 1.2 s。
   */
  private withEmbedding(ids: number[]): number[] {
    const embedded = existingVectors(this.sqlite, ids)
    return ids.filter(pid => embedded.has(pid))
  }

  /**
   * 第一段：在普通谓词上随机抽候选；第二段：vec0 过滤。
   *
   * 超量 2 倍 —— 库里 embedding 覆盖率接近全量，一次放大的抽取就够了（不做补抽循环，YAGNI）。
   */
  private draw(
    { extraWhere, extraParams, dimensions, n }:
    { extraWhere: string, extraParams: unknown[], dimensions: string[], n: number },
  ): number[] {
    const where = CANDIDATE_WHERE.replace('{dims}', placeholders(dimensions.length))
    const rows = this.sqlite
      .prepare<unknown[], { id: number }>(
        `SELECT p.id FROM posts p WHERE ${where} ${extraWhere} ORDER BY RANDOM() LIMIT ?`,
      )
      .all(...dimensions, ...extraParams, n * 2)
    return this.withEmbedding(rows.map(r => r.id)).slice(0, n)
  }

  /** 为绝对标注抽候选 post id。 */
  samplePostIds({ count, strategy, dimensions }: { count: number, strategy: string, dimensions: string[] }): number[] {
    if (strategy !== 'stratified')
      return this.draw({ extraWhere: '', extraParams: [], dimensions, n: count })

    // 在旧的人工评分 1..5 上均分，每档内随机；某档抽干了就用随机候选补齐。
    const perLevel = Math.max(1, Math.floor(count / 5))
    const picked: number[] = []
    for (let level = 1; level <= 5; level++) {
      picked.push(...this.draw({ extraWhere: 'AND p.score = ?', extraParams: [level], dimensions, n: perLevel }))
      if (picked.length >= count)
        return picked.slice(0, count)
    }
    const fill = count - picked.length
    if (fill > 0) {
      // 什么都没抽到时整条 NOT IN 都要省掉：三值逻辑下 `id NOT IN (NULL)` 对每一行都是
      // NULL，于是在全未评分的库上悄悄排除了**所有东西**，补齐永远是空的。
      const notIn = picked.length ? `AND p.id NOT IN (${placeholders(picked.length)})` : ''
      picked.push(...this.draw({ extraWhere: notIn, extraParams: [...picked], dimensions, n: fill }))
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
    if (strategy === 'similar')
      return this.samplePairsSimilar(count)
    if (strategy === 'close')
      return this.samplePairsClose(count, dimension)

    const rows = this.sqlite
      .prepare<[number], { id: number }>(
        `SELECT p.id FROM posts p WHERE ${PAIRWISE_ELIGIBLE} ORDER BY RANDOM() LIMIT ?`,
      )
      .all(count * 4)
    const ids = this.withEmbedding(rows.map(r => r.id)).slice(0, count * 2)
    const out: Array<[number, number]> = []
    for (let i = 0; i + 1 < ids.length; i += 2) out.push([ids[i]!, ids[i + 1]!])
    return out
  }

  // ─── similar：内容相似 + 旧分档位 ─────────────────────────────────
  //
  // 一次覆盖全库的 vec0 KNN 约 1.5 s（暴力扫，没有 ANN 索引），所以负担不起一对一次 KNN。
  // 改成每次 KNN 拉出一个种子的邻域，再从里面收割若干不相交的对：PAIRS_PER_CLUSTER 在批次
  // 延迟（约 1.5 s × ceil(count / PPC)）和一批里多少对共享同一个视觉邻域之间做取舍。

  private samplePairsSimilar(count: number): Array<[number, number]> {
    const clusters = Math.max(1, Math.ceil(count / SIMILAR_PAIRS_PER_CLUSTER))
    // 种子超量抽：一个种子可能已经被前一个簇当邻居消费掉，或者所在区域根本没有同档的搭档。
    const seeds = this.sqlite
      .prepare<[number], { id: number }>(
        `SELECT p.id FROM posts p WHERE ${PAIRWISE_ELIGIBLE} ORDER BY RANDOM() LIMIT ?`,
      )
      .all(clusters * 4)
      .map(r => r.id)

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
    return this.sqlite
      .prepare<unknown[], IdScoreRow>(
        `SELECT p.id, p.score FROM posts p WHERE p.id IN (${placeholders(memberIds.length)}) AND ${PAIRWISE_ELIGIBLE}`,
      )
      .all(...memberIds)
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
    const out = new Map<number, number>()
    if (!ids.length)
      return out
    for (const row of this.sqlite
      .prepare<unknown[], { post_id: number, score: number }>(
        `SELECT post_id, score FROM ${AESTHETIC_SCORES_TABLE} WHERE scorer = ? AND post_id IN (${placeholders(ids.length)})`,
      )
      .all(SILVA.name, ...ids))
      out.set(row.post_id, row.score)
    return out
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
   * 仍值得比较的随机图片的 `(post_id, silva 分)`。它们的分数就是这一批窗口所围绕的中心。
   *
   * 抽自图片本身而不是在 [0, 1] 上均匀抽，于是窗口落在库**实际所在**的地方，而不是分数轴
   * 所在的地方。
   *
   * 每**批**抽一次，不是每个窗口抽一次。`ORDER BY RANDOM()` 无法提前停止：无论返回 1 行还是
   * 32 行，它都要扫遍所有 silva 行并在临时 B 树里排完，在 21.4 万的库上实测约 280 ms。按窗口
   * 算这曾是采样器里最贵的一件事，而且什么也没买到 —— 一次抽取用同样的价钱服务整批的每一个
   * 窗口。
   *
   * 没有任何东西让两个中心保持距离，也不需要：重叠的窗口不会重复花掉同一张图，因为
   * windowCandidates 会过滤这一批的已花费集合。调用方跳过已花费的种子，只是为了让中心来自
   * 一张这批还能用的图，不是为了把区间分开。
   */
  private windowSeeds(n: number): IdScoreRow[] {
    return this.sqlite
      .prepare<[number], IdScoreRow>(`${SILVA_ELIGIBLE} ORDER BY RANDOM() LIMIT ?`)
      .all(n)
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
    return this.sqlite
      .prepare<[number, number, number], IdScoreRow>(
        `${SILVA_ELIGIBLE} AND s.score BETWEEN ? AND ? ORDER BY RANDOM() LIMIT ?`,
      )
      .all(centre - half, centre + half, CLOSE_WINDOW_CANDIDATES * 3)
      .map(r => r.id)
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
    for (const row of this.sqlite
      .prepare<[string, string], IdScoreRow>(
        `${SILVA_ELIGIBLE} AND p.id IN (`
        + ` SELECT post_a FROM pairwise_annotations WHERE dimension = ?`
        + ` UNION SELECT post_b FROM pairwise_annotations WHERE dimension = ?)`,
      )
      .all(dimension, dimension))
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
   */
  private static revisitSeeds(
    pool: Map<number, number>,
    graph: PairGraph,
    centre: number,
    exclude: Set<number>,
    n: number,
  ): number[] {
    const half = CLOSE_PAIR_MAX_SILVA_DIFF / 2
    const inside: number[] = []
    for (const [pid, score] of pool)
      if (Math.abs(score - centre) <= half && !exclude.has(pid))
        inside.push(pid)
    return nSmallest(n, inside, pid => graph.degreeOf(pid))
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
   */
  private judgedGraph(dimension: string): PairGraph {
    const graph = new PairGraph(CLOSE_PAIR_DEGREE)
    for (const row of this.sqlite
      .prepare<[string], { post_a: number, post_b: number, winner: string }>(
        'SELECT post_a, post_b, winner FROM pairwise_annotations WHERE dimension = ?',
      )
      .all(dimension)) {
      const { post_a: a, post_b: b, winner } = row
      graph.emitted.add(edgeKey(a, b))
      if (winner === 'skip')
        continue
      if (winner === 'a' || winner === 'b') {
        const [won, lost] = winner === 'a' ? [a, b] : [b, a]
        graph.wins.set(won, (graph.wins.get(won) ?? 0) + 1)
        graph.losses.set(lost, (graph.losses.get(lost) ?? 0) + 1)
      }
      graph.bump(a)
      graph.bump(b)
    }
    graph.component = graph.mainComponent()
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
  private drawAnchors(graph: PairGraph, n: number): IdScoreRow[] {
    const pool = [...graph.component].filter(pid => !graph.spent(pid))
    if (!pool.length)
      return []
    const candidates = nSmallest(ANCHOR_CANDIDATES, pool, pid => graph.degreeOf(pid))
    return this.sqlite
      .prepare<unknown[], IdScoreRow>(
        `${SILVA_ELIGIBLE} AND p.id IN (${placeholders(candidates.length)}) ORDER BY RANDOM() LIMIT ?`,
      )
      .all(...candidates, n)
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
  private calibrationBlocks(graph: PairGraph, budget: number): Block[] {
    const needy: Array<[number, number]> = []
    for (const pid of graph.component) {
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
      const partner = this.partnerInWindow(window)
      if (partner === null)
        continue
      const edge = graph.claim(pid, partner)
      if (edge)
        blocks.push([[edge], [pid, base]])
    }
    return blocks
  }

  /** SILVA 分落在 `window` 里的一张合格图片，没有则 `null`。 */
  private partnerInWindow(window: [number, number]): number | null {
    const row = this.sqlite
      .prepare<[number, number], IdScoreRow>(
        `${SILVA_ELIGIBLE} AND s.score BETWEEN ? AND ? ORDER BY RANDOM() LIMIT 1`,
      )
      .get(...window)
    return row ? Number(row.id) : null
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
    // 锚点自己不带边；它们存在只是为了让桥落在一张已经在图里的图片上。interleaveWithBridges
    // 里的排序会把每个锚点放在分数上离它最近的块旁边。
    const blocks: Block[] = this.drawAnchors(graph, CLOSE_ANCHORS).map(a => [[], [a.id, a.score]] as Block)
    blocks.push(...this.calibrationBlocks(graph, Math.max(1, Math.round(count * CALIBRATION_SHARE))))
    // **这一批**的已花费：一个窗口不能再提供前一个窗口拿走的图片，也不能把预算花在一张纵观
    // 全部历史已经达到度数的图片上。
    const spent = new Set(graph.saturated)
    const revisit = this.revisitPool(graph, dimension)
    const seeds = this.windowSeeds(CLOSE_SEED_DRAW)
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

    return Sampler.interleaveWithBridges(blocks, graph, count)
  }

  /**
   * 按 SILVA 顺序把块**轮转**发牌，每个块搭桥到上一个。
   *
   * 来自已有图的锚点是一个自己没有边的块 —— 它不贡献任何要标注的东西，只提供一个让相邻块搭
   * 上来的位置，而这正是一批加入历史的方式。
   *
   * 用轮转而不是一块一块发，是因为一个块就是一个 KNN 邻域，把一个发空再开下一个正是标注让人
   * 觉得卡住的原因：在真实库上实测，连续 20 个问题里只出现 **21 张不同的图**，89.9% 的相邻
   * 问题复用了上一个问题里的图。每个块轮流发一条边，则每个问题都换主题。
   *
   * 这个顺序保住两个性质：
   *
   * * **每个前缀都是连通的。** 队列按位置顺序服务，标注者想停就停，所以追加在末尾的桥恰恰是
   *   永远走不到的那些边 —— 半途而废的一轮会变成一个块一座孤岛。它在轮转下仍成立，是因为一个
   *   块的桥恰在这个块第一条边之前发出，而两者都碰到它的代表（见 connectedBlocks）。
   * * **桥连接最像的那些邻域。** 先按分数排序，意味着每条桥跨的都是可得的最小间隔，于是它仍是
   *   评判者能做出的比较，而不是一条任意的交叉链接。
   *
   * 桥不是预算里的固定份额：连接 k 个块需要 k - 1 条边，一条都不能少。悄悄丢掉它们的上限会
   * 返回一个和连通结果无法区分的断开轮次。
   */
  private static interleaveWithBridges(blocks: Block[], graph: PairGraph, count: number): Array<[number, number]> {
    blocks.sort((x, y) => x[1][1] - y[1][1])
    const out: Array<[number, number]> = []
    const rounds = blocks.reduce((m, [edges]) => Math.max(m, edges.length), 0)
    for (let roundNo = 0; roundNo < rounds; roundNo++) {
      for (const [i, [edges, [rep]]] of blocks.entries()) {
        if (roundNo === 0 && i) {
          const bridge = graph.claim(blocks[i - 1]![1][0], rep)
          if (bridge)
            out.push(bridge)
        }
        if (roundNo < edges.length)
          out.push(edges[roundNo]!)
      }
    }
    return out.slice(0, count)
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
