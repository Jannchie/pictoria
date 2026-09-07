/**
 * 近重复分组的数据侧 —— 对应 Python 的 `services/dedup.py` 里除矩阵乘之外的一切。
 *
 * 检测完全由 SigLIP 2 驱动：余弦距离在 `threshold` 以内的两个 post 被当成同一张图
 * （覆盖不同分辨率 / 编码，以及近似差分）。分组是**非破坏性**的：成员的行原封不动，
 * 只是多一个 `canonical_post_id` 指针（所以 Danbooru 去重不会重新下载）。
 *
 * 「近似」是**连通**关系而不是等价关系：差分集天然成链（原图 → 换表情 →
 * 换表情 + 对白），首尾两张可以离得比阈值远。所以分组取的是相似图上的**连通分量**
 * （`assignFromEdges` 的 union-find），组内一个代表、其余成员指向它 —— 存储上组
 * 依然只有一层（canonical 的指针恒为 NULL，成员直接指向它，永远不成指针链），
 * 但组的**成员资格**是传递的。
 *
 * 只有一条代码路径：**全量重建**（`exportVectorMatrix` → worker 矩阵乘 →
 * `assignFromEdges` → `replaceAllGroups`）。逐个 vec0 KNN 在 17 万行的表上约 1 秒
 * 一条，17 万条不可行（实测约 48 小时），所以只能一次性把全部向量喂给一次分块
 * `X @ X.T`。新图不走增量挂载，而是在 embedding backfill 排空后触发一次重建
 * （见 `apps/api/src/index.ts` 的 `onDrained`）—— 重建是确定性的，增量不是。
 *
 * 重建重算一切，所以用户的手动决定（拆组 / 钉封面）不能只写在
 * `posts.canonical_post_id` 上，否则活不过下一次排空。它们存在
 * `post_group_overrides`（migration 0018），由这里的 `excluded` / `pinned` 消费。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { closeSync, openSync, writeSync } from 'node:fs'
import { SIGLIP2_TABLE } from './vectors.js'

/**
 * 导出全库向量到一个裸 float32 文件，返回与文件行序平行的 post id。
 *
 * 为什么要落地成文件而不是随 payload 走：22.3 万条 × 1152 维 = 1.0 GB，base64
 * 之后 1.3 GB，一行 JSON 装不下。文件不是数据库，所以 §D1（worker 只算不碰库）
 * 依然成立 —— worker 拿到的仍然只是它算不出来的那部分输入。
 *
 * **id 升序**：canonical 现在由 `assignFromEdges` 显式按最小 id 选，不再依赖行序，
 * 但行序仍然要稳定 —— 同一个库两次导出必须给出同一份矩阵，否则 worker 回传的对、
 * 以及等强度边的合并顺序都会跟着抖，重建就不再是可复现的。
 *
 * 逐行写而不是先在内存里拼一个大 Buffer —— 1 GB 的 Buffer 会顶到 Node 的堆上限，
 * 而 better-sqlite3 的 iterate 本来就是流式的。
 */
export function exportVectorMatrix(
  sqlite: BetterSqlite3.Database,
  filePath: string,
): { ids: number[], count: number, dim: number } {
  const ids: number[] = []
  let dim = 0
  const fd = openSync(filePath, 'w')
  try {
    // join posts：vec0 不参与 FK 级联，孤儿向量（post 已删、向量还在）会跟着进矩阵。
    // 后果不是多算几行而已 —— `assignFromEdges` 取组内最小 id 当 canonical，孤儿一旦
    // 当上 canonical，`replaceAllGroups` 的 UPDATE 就会撞 `REFERENCES posts(id)`，
    // 整个重建事务回滚。join 的代价实测 +3.4%（9.34 s → 9.66 s，22.3 万行 / 1.03 GB）：
    // 只多一次 rowid 点查，而这一步本来就是分钟级重建里的一小段。
    //
    // join 只挡得住**此刻**的孤儿。导出到落库之间隔着几分钟的 GPU 计算，期间被删的
    // post 照样在快照里 —— 那一半由 `replaceAllGroups` 在自己的事务里按存活 id 过滤。
    const rows = sqlite
      .prepare<[], { post_id: number, embedding: Buffer }>(
        `SELECT v.post_id, v.embedding FROM ${SIGLIP2_TABLE} v `
        + `JOIN posts p ON p.id = v.post_id ORDER BY v.post_id ASC`,
      )
      .iterate()
    for (const row of rows) {
      const blob = row.embedding
      const width = blob.length / 4
      // 宽度不一致的行会让 worker 那边的 reshape 静默错位 —— 与其算出一堆噪声，
      // 不如在这里就停下（同 `codec.py` 里检查宽度而不是推断宽度的理由）。
      if (dim === 0)
        dim = width
      else if (width !== dim)
        throw new Error(`post ${row.post_id} 的向量是 ${width} 维，与前面的 ${dim} 维不一致`)
      writeSync(fd, blob)
      ids.push(Number(row.post_id))
    }
  }
  finally {
    closeSync(fd)
  }
  return { ids, count: ids.length, dim }
}

/** 一条"这两张图像"的边。`a` / `b` 是 post id，`strength` 越大越像。 */
export interface VariantEdge {
  a: number
  b: number
  strength: number
}

export interface AssignOptions {
  /** 用户拆出来的 post（`post_group_overrides.kind='standalone'`）：不进任何组。 */
  excluded?: ReadonlySet<number>
  /** 用户钉的封面（`kind='canonical'`）：优先于"组内最小 id"当代表。 */
  pinned?: ReadonlySet<number>
  /**
   * 单个组的成员上限。**默认不限制**，这个字段是诊断用的旋钮，不是保护。
   *
   * 见 `assignFromEdges` 里为什么默认不设上限。
   */
  maxGroupSize?: number
}

/**
 * 默认不限制组的大小。
 *
 * 这里一度有个 40 的上限，理由是"防传递闭包被一条错边串起两坨"。它不成立，而且
 * 造成了实际伤害，两条都值得记下来，免得有人再加回去：
 *
 * 1. **它防不住它要防的东西。** 撞上限时被跳过的是排序最靠后的那条边，不是最可疑的
 *    那条 —— 切断的位置是任意的。而且如果真有一条错边把两坨连起来了，上限也阻止不了
 *    那次错误合并，它只是让错误停在第 N 张：错误照发生，规模被截断，同时正确的合并
 *    也被同样截断。
 * 2. **它主动切开了正确的结果。** 40 那版把一套 43 张的差分集劈成 39 + 4 两组，而
 *    两组之间有 83 条 lpips ≤ 0.25 的边。闸门挡住的不是一条可疑的边，是一整片证据。
 *
 * 放开到底实测过（23.5 万张的库，全量 LPIPS 仲裁后的边集）：无上限时最大的组是
 * 121 张，且 400 与无上限的结果逐位相同 —— "串成一大坨"在有仲裁把关的边集上没有发生。
 *
 * 真要防串味，判据也不是组的大小，而是两坨之间**连接有多单薄**：83 条边不是串，
 * 1 条边才是。等真的出现了巨型组，做的应该是那个，不是把这个上限加回来。
 */
const DEFAULT_MAX_GROUP_SIZE = Number.POSITIVE_INFINITY

/**
 * 相似边 → `(member_id, canonical_id)` 的完整分配。
 *
 * **union-find（路径压缩 + 按秩合并），取连通分量**。它替掉的星形贪心是这样的：
 * id 升序扫，未被认领者当种子收编邻居，被认领者永不再当种子 —— 于是 A 认领 B 之后，
 * 只和 B 像、不和 A 像的 C 永远进不来。差分集天然是链（原图 → 换表情 →
 * 换表情 + 对白），那是一层与信号完全无关的漏检：向量算对了，分配把它扔了。
 *
 * 边按 `strength` **降序**处理（Kruskal 式），因为唯一会被丢掉的边是撞上大小闸的
 * 那条，那就该让最像的一批先落袋。等强度时按 (min id, max id) 兜底排序 —— 输入
 * 顺序一变结果就变的话，"重建是确定性的"这句话就不成立了。
 *
 * `maxGroupSize` 是这里唯一的"反连通"闸：连通分量对一条错边零容忍，一条 0.011 的
 * 弱边就能把两坨各 30 张的图串成一个 60 张的组，而组内成员在列表里是**隐藏**的
 * —— 错误的代价是几十张图凭空消失。合并前先看两边大小之和，超了就**跳过这条边**
 * （不是拒绝整个组）继续下一条：结果是两个组各自完整，而不是一个巨无霸。
 *
 * 纯函数：不碰库，于是这段逻辑的正确性可以脱离 GPU 单独钉住。
 */
export function assignFromEdges(
  edges: readonly VariantEdge[],
  options: AssignOptions = {},
): Array<[number, number]> {
  const excluded = options.excluded
  const pinned = options.pinned
  const maxGroupSize = options.maxGroupSize ?? DEFAULT_MAX_GROUP_SIZE

  const parent = new Map<number, number>()
  // 按大小合并（union by size）—— `size` 本来就要维护（maxGroupSize 要读它），
  // 再挂一个 rank 是第二份要同步的状态，而两者的均摊复杂度相同。
  const size = new Map<number, number>()

  const find = (x: number): number => {
    if (!parent.has(x)) {
      parent.set(x, x)
      size.set(x, 1)
      return x
    }
    let root = x
    while (parent.get(root)! !== root) root = parent.get(root)!
    // 路径压缩写成循环而不是递归：分量可以很深，而这条路径上每个节点都要改写。
    let cur = x
    while (cur !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }

  const usable = edges.filter(e =>
    e.a !== e.b && !excluded?.has(e.a) && !excluded?.has(e.b))
  usable.sort((x, y) =>
    y.strength - x.strength
    || Math.min(x.a, x.b) - Math.min(y.a, y.b)
    || Math.max(x.a, x.b) - Math.max(y.a, y.b))

  for (const edge of usable) {
    const ra = find(edge.a)
    const rb = find(edge.b)
    if (ra === rb)
      continue
    const merged = size.get(ra)! + size.get(rb)!
    if (merged > maxGroupSize)
      continue
    const [big, small] = size.get(ra)! >= size.get(rb)! ? [ra, rb] : [rb, ra]
    parent.set(small, big)
    size.set(big, merged)
  }

  const groups = new Map<number, number[]>()
  for (const node of parent.keys()) {
    const root = find(node)
    const bucket = groups.get(root)
    if (bucket)
      bucket.push(node)
    else groups.set(root, [node])
  }

  const out: Array<[number, number]> = []
  for (const members of groups.values()) {
    // 落单的（边全被闸掉了）不成组 —— 它自己就是 canonical，不需要指针。
    if (members.length < 2)
      continue
    // 用户钉过封面就用它；钉了多个（跨组的两个 pin 被并到了一起）取最小 id，
    // 和无 pin 时同一条规则，免得结果取决于成员的遍历顺序。
    const pins = pinned ? members.filter(m => pinned.has(m)) : []
    const canonical = Math.min(...(pins.length ? pins : members))
    for (const member of members) {
      if (member !== canonical)
        out.push([member, canonical])
    }
  }
  return out
}

/**
 * 一次事务内换掉全部分组指针。
 *
 * `assignments` 是完整的新分组；没列进来的 post 就是（或恢复成）canonical。
 * 清空 + 重设必须在**同一个事务**里：分开做的话，从清空到写完之间（一次 GPU
 * 计算加上两万多条 UPDATE，分钟级）每个成员都会在列表里冒出来。
 *
 * ⚠️ `assignments` 基于的是**几分钟前**的快照（`exportVectorMatrix` → GPU 计算），
 * 期间 sync 或用户删掉的 post 可能还挂在里面。member 已删无所谓 —— UPDATE 匹配
 * 0 行是空操作；canonical 已删则会撞 `REFERENCES posts(id)`，让整个事务回滚、
 * 几分钟的 GPU 白算。所以在**事务内**逐个探测 canonical 的存活再过滤：distinct
 * canonical 只有组数那么多（几千），逐个 rowid 点查是毫秒级，比在写事务里物化
 * 全表 22 万个 id 便宜得多；而这层过滤和 UPDATE 同处一个事务，中间不可能再有
 * 删除挤进来。
 *
 * ⚠️ 同一个窗口里用户可能刚拆过一个组。`assignFromEdges` 拿到的 `excluded` 是
 * 计算**开始前**读的，几十秒之后就不再是最新的意图了，于是刚拆开的图会被这一轮
 * 原样合回去 —— 用户看到的是"我点了拆开，几十秒后它自己合上了"。所以在事务内
 * **再读一次** `post_group_overrides`，把 standalone 的成员过滤掉：和上面那层
 * "事务内探测存活"是同一个模式，把窗口从几十秒关到毫秒。
 *
 * 只过滤 member 一侧。standalone 的 post 出现在 canonical 位说明它是在窗口里刚被
 * 拆出来的：它自己的指针仍然是 NULL（照样独立可见，用户要的就是这个），而把它当
 * 代表的那些成员如果一并丢掉，反而是让一组重复图重新散回列表。
 *
 * UPDATE 照常触发 canonical 分组触发器，`tags.post_count` 仍然只数可见的
 * canonical post。
 */
export function replaceAllGroups(
  sqlite: BetterSqlite3.Database,
  assignments: Array<[number, number]>,
): void {
  const clear = sqlite.prepare(
    'UPDATE posts SET canonical_post_id = NULL WHERE canonical_post_id IS NOT NULL',
  )
  const set = sqlite.prepare(
    'UPDATE posts SET canonical_post_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  )
  const exists = sqlite.prepare('SELECT 1 FROM posts WHERE id = ?')
  const standaloneRows = sqlite.prepare<[], { post_id: number }>(
    `SELECT post_id FROM post_group_overrides WHERE kind = 'standalone'`,
  )
  sqlite.transaction(() => {
    const canonicals = new Set(assignments.map(([, c]) => c))
    const live = new Set<number>()
    for (const c of canonicals) {
      if (exists.get(c) !== undefined)
        live.add(c)
    }
    const standalone = new Set(standaloneRows.all().map(r => r.post_id))
    clear.run()
    for (const [member, canonical] of assignments) {
      if (live.has(canonical) && !standalone.has(member))
        set.run(canonical, member)
    }
  })()
}
