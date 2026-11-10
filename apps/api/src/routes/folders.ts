/**
 * `/v2/folders` —— 目录树的读取与删除。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRoute, z } from '@hono/zod-openapi'
import { addAgg, emptyAgg, listIdsInFolder, SCORERS, type AestheticScorer, type AestheticScorerKey, type FolderScoreAgg } from '@pictoria/db'
import { newRoutes, openapiCatchAll } from '../env.js'
import { isInside, pictoriaDir, realPathOrResolved, targetDir, thumbnailPathFor } from '../paths.js'
import { deletePostFiles } from '../post-files.js'
import { OK, errors, fail } from '../openapi.js'
import { Result } from '../schemas.js'

/** 每个打分器一个 `<key>Avg` 字段（`silvaAvg`、`silvaLunaAvg`），由 `SCORERS` 生成。 */
type ScorerAvgFields = { [K in AestheticScorerKey as `${K}Avg`]: number | null }

function avgField<K extends AestheticScorerKey>(spec: { readonly key: K }): `${K}Avg` {
  return `${spec.key}Avg`
}

function emptyAvgs(): ScorerAvgFields {
  return Object.fromEntries(SCORERS.map(s => [avgField(s), null])) as ScorerAvgFields
}

interface DirectorySummary extends ScorerAvgFields {
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

const scorerAvgSchemas = Object.fromEntries(
  SCORERS.map(s => [avgField(s), z.number().nullable()]),
) as { [K in AestheticScorer['key'] as `${K}Avg`]: z.ZodNullable<z.ZodNumber> }

const DirectorySummarySchema: z.ZodType<DirectorySummary> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    fileCount: z.int(),
    postCount: z.int(),
    ...scorerAvgSchemas,
    scoreAvg: z.number().nullable(),
    ratingAvg: z.number().nullable(),
    scoredRatio: z.number().nullable(),
    children: z.array(DirectorySummarySchema),
  }),
).openapi('DirectorySummary')

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
    void this.current(base).catch((err: unknown) => console.warn(`[folders] 预热目录树失败：${String(err)}`))
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
        console.warn(`[folders] 目录监视出错，退回全量校验：${String(err)}`)
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
      console.warn(`[folders] 目录监视启动失败，每次请求全量校验：${String(err)}`)
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
      .catch((err: unknown) => console.warn(`[folders] 后台全量校验失败：${String(err)}`))
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
    // 根节点的 name 是空串 —— Python 侧 relative_to(target_dir).name 对根就是 ''，
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

/**
 * "这个路径得是个存在的目录"：不存在 → 404，存在但不是目录 → 400。GET 和 DELETE
 * 共用。少了它们，一个没挂上或被挪走的库根会让 `readdirSync` 抛 ENOENT 冒成 500。
 *
 * 一次 `statSync` 而不是 `existsSync` + `statSync`：后者是两次系统调用，而且
 * "先问在不在、再问是什么"本来就有竞态。`label` 是给用户看的那半边路径。
 *
 * ⚠️ `throwIfNoEntry: false` 只吞 ENOENT。EINVAL（Windows 上路径里带 `<>"|` 这类
 * 非法字符）、ENOTDIR（POSIX 上路径穿过一个文件）、EACCES 照样抛 —— 而被换掉的
 * `existsSync` 对这些一律返回 false。stat 不出来就是"没有这个目录"，所以任何
 * 失败都归到 404，别让它们冒成上面说的那种裸 500。
 */
function requireDirectory(abs: string, label: string) {
  let st: fs.Stats | undefined
  try {
    st = fs.statSync(abs, { throwIfNoEntry: false })
  }
  catch {
    st = undefined
  }
  if (!st)
    return fail(404, 'DirectoryNotFoundError', `Directory not found: ${label}`)
  if (!st.isDirectory())
    return fail(400, 'PathNotADirectoryError', `Not a directory: ${label}`)
  return null
}

export const foldersRoutes = newRoutes()

foldersRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/folders',
    operationId: 'v2GetFolders',
    summary: 'GetFolders',
    responses: {
      200: { description: OK, content: { 'application/json': { schema: DirectorySummarySchema } } },
      ...errors(400, 404),
    },
  }),
  async (c) => {
    const base = targetDir()
    const bad = requireDirectory(base, base)
    if (bad)
      return bad

    // 遍历是异步的（逐目录让出）；聚合走读线程并按数据版本缓存（`read-cache.ts`），
    // 真库 1.4 s 的 GROUP BY 不再占事件循环，也不必每次都算。
    const { body, etag } = await c.var.folderTree.render(base, () => c.var.reads.folderScoreAggregates())
    if (c.req.header('if-none-match') === etag)
      return c.body(null, 304, { etag }) as never
    return c.body(body, 200, { 'content-type': 'application/json', etag }) as never
  },
)

/**
 * 删一个库目录：它的 post（DB + 文件 + 缩略图）以及整棵目录树。
 *
 * 拒绝库根、拒绝解析后落在库外的、拒绝 `.pictoria`。DB 行走
 * `deleteManyReturningPaths`，于是外键级联、手工的 vec0 级联都照常；行删完再把原图树
 * 和缩略图树整棵从磁盘上删掉（不逐文件 unlink）。磁盘那一步部分失败也不要紧 ——
 * 下一次 sync 会把幸存下来的重新导入，两种情况下都不会留下孤儿 DB 行。
 *
 * 目录名里有斜杠，所以经 `openapiCatchAll`（`env.ts`）挂载。
 */
const deleteFolderRoute = createRoute({
  method: 'delete',
  path: '/v2/folders/{folder_path}',
  tags: ['Commands', 'Folder'],
  operationId: 'v2DeleteFolder',
  summary: 'DeleteFolder',
  description: 'Delete a library folder: its posts (DB + files + thumbnails) and the dir tree.\n\nRefuses the library root and anything resolving outside the library\n(or into ``.pictoria``). DB rows go through ``deleteManyReturningPaths`` so\nthe FK cascade and the manual vec0 cascade apply; the folder and its\nthumbnail tree are then removed from disk recursively. If the disk removal partially fails, the next sync re-imports\nwhatever survived — no orphaned DB rows either way.',
  request: {
    params: z.object({
      folder_path: z.string().openapi({ param: { name: 'folder_path', in: 'path', required: true } }),
    }),
  },
  responses: {
    200: { description: OK, content: { 'application/json': { schema: Result } } },
    ...errors(400, 404),
  },
})

/** 可删的库目录：不是库根、在库内、不在 `.pictoria` 里。三个参数须同一层（字符串或真实路径）。 */
function isDeletableDir(target: string, base: string, pictoria: string): boolean {
  return target !== base && isInside(target, base) && !isInside(target, pictoria)
}

openapiCatchAll(foldersRoutes, deleteFolderRoute, async (c) => {
  const folder = c.req.valid('param').folder_path.replace(/^\/+|\/+$/g, '')
  const base = targetDir()
  const target = path.resolve(base, folder)

  // `:` 在 Windows 上是 ADS 语法（`.pictoria::$INDEX_ALLOCATION` 指向 `.pictoria` 本身），
  // 合法的库内目录名里不会出现它。
  if (!folder || folder === '.' || folder === '@' || folder.includes(':') || !isDeletableDir(target, base, pictoriaDir()))
    return fail(400, 'PathNotADirectoryError', `Refusing to delete: '${folder}' is not a library folder.`)
  const bad = requireDirectory(target, folder)
  if (bad)
    return bad
  // 字符串层面的判断挡不住文件系统自己的别名（大小写、8.3 短名、末尾点号、junction）：
  // 解析成真实路径再判一次。
  if (!isDeletableDir(realPathOrResolved(target), realPathOrResolved(base), realPathOrResolved(pictoriaDir())))
    return fail(400, 'PathNotADirectoryError', `Refusing to delete: '${folder}' is not a library folder.`)

  const sqlite = c.var.db
  const ids = listIdsInFolder(sqlite, folder)
  // 几万个 post 的目录：分块删、块间让出事件循环（见 `post-files.ts`）。只删行 ——
  // 原图和缩略图随下面两棵树的递归 rm 一起走，不逐个删两遍。先删行再删盘。
  await deletePostFiles(sqlite, ids, { unlink: false })

  // 缩略图是尽力而为；主树失败要抛出去，好让一个被锁住的文件显示成 500 而不是
  // 悄悄活下来。异步：剩下的树（非图片文件、空目录）也可能很大。
  await fs.promises.rm(thumbnailPathFor(folder), { recursive: true, force: true })
  await fs.promises.rm(target, { recursive: true })
  return c.json({ msg: `Deleted folder ${folder} (${ids.length} posts)` }, 200)
})
