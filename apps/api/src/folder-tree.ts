/**
 * `/v2/folders` 背后的目录树状态：遍历、mtime / 监视器缓存、分数聚合挂到树上。
 *
 * 从 `routes/folders.ts` 搬出来：`createApp`（`app.ts`）、`env.ts`、`index.ts` 都要
 * 拿这个类，它们不该反过来依赖一个路由文件。响应的 zod schema 仍在路由文件里；
 * 两边都要的类型（`DirectorySummary`）和字段名推导（`avgField`）归这里。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { addAgg, emptyAgg, SCORERS, type AestheticScorerKey, type FolderScoreAgg } from '@pictoria/db'
import { createLogger } from './log.js'
import { isInside, pictoriaDir } from './paths.js'
const log = createLogger('folders')

/** 每个打分器一个 `<key>Avg` 字段（如 `silvaAvg`），由 `SCORERS` 生成。 */
export type ScorerAvgFields = { [K in AestheticScorerKey as `${K}Avg`]: number | null }

export function avgField<K extends AestheticScorerKey>(spec: { readonly key: K }): `${K}Avg` {
  return `${spec.key}Avg`
}

function emptyAvgs(): ScorerAvgFields {
  return Object.fromEntries(SCORERS.map(s => [avgField(s), null])) as ScorerAvgFields
}

export interface DirectorySummary extends ScorerAvgFields {
  name: string
  path: string
  fileCount: number
  postCount: number
  scoreAvg: number | null
  ratingAvg: number | null
  scoredRatio: number | null
  children: DirectorySummary[]
}

/**
 * walk 跳过的目录名。按**名字**比，任意深度都跳。从 pictoriaDir() 取而不是写死
 * 字面量，这样 `.pictoria` 改名时只有 paths.ts 一处要动。
 *
 * 惰性求值而不是模块顶层常量：顶层调 `pictoriaDir()` 会在 import 时刻锁死
 * `PICTORIA_TARGET_DIR`（`paths.ts` 的 `once()`），测试就没法在 import 之后指向临时库。
 */
function ignoredDirName(): string {
  return path.basename(pictoriaDir())
}

/** 一个目录的缓存条目：mtime，加上目录 mtime 没变就不会变的那两样。 */
interface DirCacheEntry {
  mtimeNs: bigint
  /** 直接子文件数（已经排除 `.pictoria`）。 */
  fileCount: number
  /** 直接子目录名，readdir 顺序 —— `children` 的顺序就是它。 */
  subdirs: string[]
}

/** 不靠监视器时，多久做一次全量校验（stat 每个目录）。监视器漏事件的兜底。 */
const FULL_REVALIDATE_MS = 10 * 60_000

export interface FolderTreeOptions {
  /**
   * 用 `fs.watch`（递归）记下哪些目录变了，之后的请求只重读这些目录、其余直接信缓存。
   * 生产开（`index.ts`），测试默认关 —— 关着时每次请求都按 mtime 全量校验，与原来一致。
   */
  watch?: boolean
  /** 有监视器时的全量校验间隔（后台跑，不挡请求）。 */
  fullRevalidateMs?: number
}

/**
 * `/v2/folders` 的目录树状态：每个 app 一个（`createApp` 注入，`c.var.folderTree`）。
 *
 * 原来这是模块级的 `dirCache`，只按 mtime 判新旧 —— 但判新旧本身就要 stat 每个目录。
 * 真库 2.55 万个目录，顺序 `await stat` 一遍 7–8 s（冷的话再加 readdir，14.6 s），这才是
 * 目录树 8–10 s 的大头；聚合 SQL 1.4 s、JSON 4.6 MB 序列化 32 ms、gzip 46 ms 都是零头。
 *
 * 现在：
 * - 有监视器时，只重读被事件点名的目录（文件事件点名它的父目录，目录事件点名它自己和
 *   父目录）和缓存里没有的目录，其余目录不碰磁盘。监视器出错就退回全量校验。
 * - 全量校验时子目录并发走（真库冷走 14.6 s → 5.3 s；libuv 线程池是瓶颈）。
 * - 树没变、聚合也没变（读缓存按数据版本给出同一个对象）时，直接复用上次序列化好的
 *   响应体和 ETag；请求带 `If-None-Match` 且对得上就回 304。
 *
 * 缓存只按 mtime / 事件判新旧，自己发现不了"这个目录没了"；而"本轮走到过的目录"恰好就是
 * "本轮该留的缓存"，所以每轮边走边建新表、走完整体替换（同 `sync.ts` 的 `scanLibrary`）。
 *
 * 形状照抄 `sync.ts` 的 `ScanCache`（同一个库、同一个理由），但**不共用同一份**：
 * 两个遍历器的过滤规则不一样 —— sync 跳过顶层所有 `.` 开头的项、以及任意位置的
 * `*.part`，而这里只跳过名叫 `.pictoria` 的目录，其余一律计数。
 */
export class FolderTree {
  private dirCache = new Map<string, DirCacheEntry>()
  private readonly watchEnabled: boolean
  private readonly fullRevalidateMs: number
  private watcher: fs.FSWatcher | null = null
  private watchedRoot: string | null = null
  /** 监视器点名过、还没重读的目录（绝对路径）。 */
  private dirty = new Set<string>()
  /** 上一次全量校验完成的时刻；0 = 还没有一棵可信的树（必须全量走）。 */
  private lastFull = 0
  private building: Promise<{ tree: DirectorySummary, changed: boolean }> | null = null
  private backgroundFull: Promise<unknown> | null = null
  private tree: DirectorySummary | null = null
  private response: { tree: DirectorySummary, aggregates: unknown, body: string, etag: string } | null = null

  constructor({ watch = false, fullRevalidateMs = FULL_REVALIDATE_MS }: FolderTreeOptions = {}) {
    this.watchEnabled = watch
    this.fullRevalidateMs = fullRevalidateMs
  }

  /** 启动后先在后台走一遍，第一次点开侧边栏时就不必等冷遍历。 */
  warm(base: string): void {
    void this.current(base).catch((err: unknown) => log.warn(`预热目录树失败：${String(err)}`))
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }

  private ensureWatcher(base: string): void {
    if (!this.watchEnabled || (this.watcher && this.watchedRoot === base))
      return
    this.close()
    try {
      const pictoria = pictoriaDir()
      const watcher = fs.watch(base, { recursive: true }, (_event, filename) => {
        if (!filename)
          return
        const abs = path.resolve(base, filename.toString())
        if (isInside(abs, pictoria))
          return
        this.dirty.add(abs)
        this.dirty.add(path.dirname(abs))
      })
      // 监视器坏了（缓冲区溢出、目录被删）：关掉，下一次请求全量校验并重新挂上。
      watcher.on('error', (err) => {
        log.warn(`目录监视出错，退回全量校验：${String(err)}`)
        if (this.watcher === watcher)
          this.close()
        this.lastFull = 0
      })
      this.watcher = watcher
      this.watchedRoot = base
      // 挂上之前发生的变化监视器看不到：下一次必须全量。
      this.lastFull = 0
    }
    catch (err) {
      log.warn(`目录监视启动失败，每次请求全量校验：${String(err)}`)
    }
  }

  /** 当前的树（不含分数统计）。并发请求共用同一次遍历。 */
  private async current(base: string): Promise<{ tree: DirectorySummary, changed: boolean }> {
    this.ensureWatcher(base)
    while (this.building) {
      try {
        await this.building
      }
      catch {}
    }
    const trusted = this.watcher !== null && this.lastFull > 0
    if (trusted && this.dirty.size === 0 && this.tree) {
      this.maybeRevalidate(base)
      return { tree: this.tree, changed: false }
    }
    const run = this.walkAll(base, trusted ? 'incremental' : 'full')
    this.building = run
    try {
      return await run
    }
    finally {
      this.building = null
      this.maybeRevalidate(base)
    }
  }

  /** 有监视器时，全量校验过期了就在后台补一次（单飞），不挡当前请求。 */
  private maybeRevalidate(base: string): void {
    if (this.watcher === null || this.backgroundFull || Date.now() - this.lastFull < this.fullRevalidateMs)
      return
    this.backgroundFull = (async () => {
      while (this.building) {
        try {
          await this.building
        }
        catch {}
      }
      const run = this.walkAll(base, 'full')
      this.building = run
      try {
        await run
      }
      finally {
        this.building = null
      }
    })()
      .catch((err: unknown) => log.warn(`后台全量校验失败：${String(err)}`))
      .finally(() => {
        this.backgroundFull = null
      })
  }

  private async walkAll(base: string, mode: 'full' | 'incremental'): Promise<{ tree: DirectorySummary, changed: boolean }> {
    // 先摘下点名表再走：走的期间进来的事件留给下一次。
    const dirty = this.dirty
    this.dirty = new Set()
    const next = new Map<string, DirCacheEntry>()
    const startedAt = Date.now()
    try {
      const tree = await walk(base, base, next, this.dirCache, mode === 'full' ? null : dirty)
      this.dirCache = next
      this.tree = tree
      if (mode === 'full')
        this.lastFull = startedAt
      return { tree, changed: true }
    }
    catch (err) {
      // 没走完：点名的目录还给下一次。
      for (const d of dirty) this.dirty.add(d)
      throw err
    }
  }

  /**
   * 整个响应：树 + 聚合 → JSON。树没变且聚合是同一个对象（读缓存命中）时复用上次的
   * 响应体，`etag` 也不变。
   */
  async render(base: string, aggregates: () => Promise<Map<string, FolderScoreAgg>>): Promise<{ body: string, etag: string }> {
    const { tree } = await this.current(base)
    const aggs = await aggregates()
    const prev = this.response
    if (prev && prev.tree === tree && prev.aggregates === aggs)
      return prev
    attachStats(tree, aggs)
    const body = JSON.stringify(tree)
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`
    this.response = { tree, aggregates: aggs, body, etag }
    return this.response
  }
}

/**
 * 递归统计目录下的文件数，跳过 `.pictoria`。
 *
 * ⚠️ **异步**，而且必须是：真库 2.55 万个目录，同步走一遍就是秒级的事件循环冻结。
 *
 * `dirty` 为 null（全量）：每个目录都 stat，mtime 没变就复用上次的直接子文件数和子目录名
 * （省掉 readdir），但**仍然递归** —— NTFS / ext4 上父目录的 mtime 只反映直接子项。
 * `dirty` 非空（增量，监视器在跑）：只有被点名的和缓存里没有的目录才碰磁盘，其余直接
 * 信缓存。子目录并发走，`children` 按 readdir 顺序收。
 */
async function walk(
  absDir: string,
  base: string,
  next: Map<string, DirCacheEntry>,
  prev: Map<string, DirCacheEntry>,
  dirty: Set<string> | null,
): Promise<DirectorySummary> {
  const rel = path.relative(base, absDir).split(path.sep).join('/')
  const summary: DirectorySummary = {
    // 根节点的 name 是空串 —— 已退役的 Python 版里 relative_to(target_dir).name 对根就是 ''，
    // 不是目录名。前端靠这个区分根节点。
    name: rel === '' ? '' : path.basename(absDir),
    path: rel === '' ? '.' : rel,
    fileCount: 0,
    postCount: 0,
    ...emptyAvgs(),
    scoreAvg: null,
    ratingAvg: null,
    scoredRatio: null,
    children: [],
  }

  const cached = prev.get(absDir)
  let entry: DirCacheEntry | undefined = dirty !== null && cached && !dirty.has(absDir) ? cached : undefined
  if (!entry) {
    // stat 失败在这里不报：下面的 readdir 会撞上同一个 errno 并抛出去，冒成 500 ——
    // 根目录那一层由 `requireDirectory` 挡在前面。拿不到 mtime 只意味着这一轮不复用、
    // 也不写缓存。
    let mtimeNs: bigint | undefined
    try {
      mtimeNs = (await fs.promises.stat(absDir, { bigint: true })).mtimeNs
    }
    catch {
      mtimeNs = undefined
    }
    if (mtimeNs !== undefined && cached?.mtimeNs === mtimeNs && dirty === null) {
      entry = cached
    }
    else {
      let fileCount = 0
      const subdirs: string[] = []
      const ignored = ignoredDirName()
      for (const dirent of await fs.promises.readdir(absDir, { withFileTypes: true })) {
        if (dirent.name === ignored)
          continue
        if (dirent.isDirectory())
          subdirs.push(dirent.name)
        else
          fileCount += 1
      }
      entry = { mtimeNs: mtimeNs ?? 0n, fileCount, subdirs }
    }
    if (mtimeNs !== undefined)
      next.set(absDir, entry)
  }
  else {
    next.set(absDir, entry)
  }

  summary.fileCount = entry.fileCount
  const children = await Promise.all(entry.subdirs.map(name => walk(path.join(absDir, name), base, next, prev, dirty)))
  for (const child of children) {
    summary.children.push(child)
    summary.fileCount += child.fileCount
  }
  return summary
}

/**
 * 就地把递归后的分数均值写到整棵子树上，并返回该子树的汇总供父节点继续累加。
 *
 * `file_path` 和树上的 `path` 精确对应（根是 `'.'` ↔ 根 post 的 `file_path='.'`）。
 */
function attachStats(
  node: DirectorySummary,
  aggregates: Map<string, FolderScoreAgg>,
): FolderScoreAgg {
  const total = emptyAgg()
  const direct = aggregates.get(node.path)
  if (direct)
    addAgg(total, direct)
  for (const child of node.children) addAgg(total, attachStats(child, aggregates))

  node.postCount = total.posts
  for (const spec of SCORERS) {
    const { total: sum, n } = total.scorers[spec.name]
    node[avgField(spec)] = n ? sum / n : null
  }
  node.scoreAvg = total.scored ? total.scoreTotal / total.scored : null
  node.ratingAvg = total.posts ? total.ratingTotal / total.posts : null
  node.scoredRatio = total.posts ? total.scored / total.posts : null
  return total
}
