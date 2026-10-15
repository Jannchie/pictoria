/**
 * 采样用的纯图算法 —— 连通分量、环边、块的拆分与轮转发牌、以及一轮采样的边簿记 PairGraph。
 *
 * 这里的东西**不碰 sqlite**：输入是边表和 id，输出也是。从 sampling.ts 拆出来，是为了让
 * 这些不变量（前缀连通、块内广度优先、一对只问一次）能在不建临时库的单元测试里直接钉住，
 * 而策略与取数留在 sampling.ts / sampling-queries.ts。
 */
import { edgeKey } from './variant-edges.js'

// 这两个不是可调参数而是算术 —— sampling.ts 里的常量每一条都是测量值，这两条是结构事实。一次比较要两张图；
// 最小的环要三张。两个成员的块因此是一次比较而不是一个环：把它闭合等于把同一个问题问两遍。
export const PAIR_MEMBERS = 2
export const MIN_CYCLE_MEMBERS = 3

/** 一条判决算不上横扫。 */
const CALIBRATION_MIN_DECISIVE = 2

/** 已经连在一起的边，加上其它块用来搭桥的 `(post_id, score)`。 */
export type Block = [Array<[number, number]>, [number, number]]

/** 无向边表的连通分量：`root -> members`。 */
export function components(edges: Iterable<[number, number]>): Map<number, Set<number>> {
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
export function* cycleEdges(members: number[]): Generator<[number, number]> {
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
export function breadthFirst(edges: Array<[number, number]>): Array<[number, number]> {
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
export function connectedBlocks(edges: Array<[number, number]>, score: number): Block[] {
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

/**
 * 一轮采样的边簿记：什么已经问过，以及每张图被用了几次。
 *
 * 它存在是为了让配对那几趟和搭桥那一趟共享同一个"已花费"的概念，而不是各自拎着 `out` /
 * `emitted` / `degrees` / `cap` 这些散参数。
 */
export class PairGraph {
  readonly degrees = new Map<number, number>()
  readonly emitted = new Set<string>()
  /** 每张图的决定性战绩，用来找出评分还无界的那些。 */
  readonly wins = new Map<number, number>()
  readonly losses = new Map<number, number>()
  constructor(readonly degree: number) {}

  /**
   * `emitted` 的最大连通分量的成员 —— 值得生长的那部分图，因为排序只能在一个分量内部推出来。
   * 调用方在历史载入后、`claim` 之前取一次快照：它描述的是已经收集到的东西，而那正是下一批
   * 要挂靠的对象。
   */
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

  /** 此刻度数已达上限的图片 —— 一份快照，之后的 `claim` 不会改它。 */
  saturated(): Set<number> {
    const out = new Set<number>()
    for (const [pid, d] of this.degrees) {
      if (d >= this.degree)
        out.add(pid)
    }
    return out
  }

  bump(pid: number): void {
    this.degrees.set(pid, this.degreeOf(pid) + 1)
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
export function interleaveWithBridges(blocks: Block[], graph: PairGraph, count: number): Array<[number, number]> {
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
