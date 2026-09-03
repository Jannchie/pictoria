/**
 * `/v2/folders` —— 目录树的读取与删除。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { addAgg, emptyAgg, folderScoreAggregates, listIdsInFolder, type FolderScoreAgg } from '@pictoria/db'
import { getDb } from '../db.js'
import { isInside, pictoriaDir, targetDir, thumbnailsDir } from '../paths.js'
import { deletePostFiles } from '../post-files.js'
import { OK, RESP_400, domainError, httpError, zodErrorHook } from '../openapi.js'
import { Result } from '../schemas.js'

interface DirectorySummary {
  name: string
  path: string
  file_count: number
  post_count: number
  silva_avg: number | null
  silva_luna_avg: number | null
  score_avg: number | null
  rating_avg: number | null
  scored_ratio: number | null
  children: DirectorySummary[]
}

/**
 * walk 跳过的目录名。按**名字**比，任意深度都跳 —— 逐字对齐 Litestar 的
 * `entry.name == ignore_dirs.name`。从 pictoriaDir() 取而不是写死字面量，这样
 * `.pictoria` 改名时只有 paths.ts 一处要动。
 */
const IGNORED_DIR_NAME = path.basename(pictoriaDir())

const DirectorySummarySchema: z.ZodType<DirectorySummary> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    file_count: z.int(),
    post_count: z.int().default(0).optional(),
    silva_avg: z.number().nullable().optional(),
    silva_luna_avg: z.number().nullable().optional(),
    score_avg: z.number().nullable().optional(),
    rating_avg: z.number().nullable().optional(),
    scored_ratio: z.number().nullable().optional(),
    children: z.array(DirectorySummarySchema).optional(),
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

/**
 * 目录绝对路径 → 上一次看到的内容。跨请求复用，整棵树走完才整体替换。
 *
 * 形状照抄 `sync.ts` 的 `ScanCache`（同一个库、同一个理由），但**不共用同一份**：
 * 两个遍历器的过滤规则不一样 —— sync 跳过顶层所有 `.` 开头的项、以及任意位置的
 * `*.part`（下载器的在途临时文件，不能登记成 post），而这里只跳过名叫 `.pictoria`
 * 的目录，其余一律计数。共用一份的表现是一边读到另一边过滤后的结果，`file_count`
 * 静默变小，没有任何报错。存的东西也不同：sync 要三元组去和 `posts` 对账，这里只要
 * 一个计数。
 *
 * 缓存只按 mtime 判新旧，自己发现不了"这个目录没了"；而"本轮走到过的目录"恰好就是
 * "本轮该留的缓存"，所以走完整体替换，没走到的天然不在新表里（同 `scanLibrary`）。
 */
let dirCache = new Map<string, DirCacheEntry>()

/**
 * 递归统计目录下的文件数，跳过 `.pictoria`。
 *
 * ⚠️ **异步**，而且必须是。同步版本（`fs.readdirSync` 递归）在真实库上要走 732 个
 * 目录、229,205 个 dirent，全程没有一个让出点 —— 实测 walk 本身 133 ms，紧接着的
 * `folderScoreAggregates` 首次冷页缓存要 3,760 ms，加起来是启动后第一次点开侧边栏
 * 目录树时约 3.9 秒的事件循环冻结，而 `mutations.ts` 在每次删 post / 删目录 /
 * URL 导入之后都会 invalidate 这个 query。`await` 让每个目录之间都有让出点，理由和
 * `sync.ts` 的 `scanLibrary` 逐字相同。
 *
 * 带 mtime 缓存：目录 mtime 没变就直接复用上次的直接子文件数和子目录名（省掉那次
 * readdir），但**仍然递归**进子目录 —— NTFS / ext4 上父目录的 mtime 只反映直接子项，
 * 深层的改动不会冒泡。
 *
 * ⚠️ 聚合那一半（`folderScoreAggregates`）有意留着不动：拆成两趟（posts 单表
 * GROUP BY 63 ms + 从 `post_aesthetic_scores` 侧 join 340 ms = 403 ms）实测比现在的
 * 203 ms 更慢，那 3.76 s 是冷页缓存的磁盘 I/O，不是查询形状的问题。
 */
async function walk(
  absDir: string,
  base: string,
  next: Map<string, DirCacheEntry>,
): Promise<DirectorySummary> {
  const rel = path.relative(base, absDir).split(path.sep).join('/')
  const summary: DirectorySummary = {
    // 根节点的 name 是空串 —— Python 侧 relative_to(target_dir).name 对根就是 ''，
    // 不是目录名。前端靠这个区分根节点。
    name: rel === '' ? '' : path.basename(absDir),
    path: rel === '' ? '.' : rel,
    file_count: 0,
    post_count: 0,
    silva_avg: null,
    silva_luna_avg: null,
    score_avg: null,
    rating_avg: null,
    scored_ratio: null,
    children: [],
  }

  // stat 失败在这里不报：下面的 readdir 会撞上同一个 errno 并抛出去，冒成 500 ——
  // 和改成异步之前的行为一致（根目录那一层由 `requireDirectory` 挡在前面）。拿不到
  // mtime 只意味着这一轮不复用、也不写缓存。
  let mtimeNs: bigint | undefined
  try {
    mtimeNs = (await fs.promises.stat(absDir, { bigint: true })).mtimeNs
  }
  catch {
    mtimeNs = undefined
  }

  const cached = mtimeNs === undefined ? undefined : dirCache.get(absDir)
  let entry: DirCacheEntry | undefined = cached?.mtimeNs === mtimeNs ? cached : undefined
  if (!entry) {
    let fileCount = 0
    const subdirs: string[] = []
    for (const dirent of await fs.promises.readdir(absDir, { withFileTypes: true })) {
      if (dirent.name === IGNORED_DIR_NAME)
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

  summary.file_count = entry.fileCount
  for (const name of entry.subdirs) {
    const child = await walk(path.join(absDir, name), base, next)
    summary.children.push(child)
    summary.file_count += child.file_count
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

  node.post_count = total.posts
  node.silva_avg = total.silvaN ? total.silvaTotal / total.silvaN : null
  node.silva_luna_avg = total.silvaLunaN ? total.silvaLunaTotal / total.silvaLunaN : null
  node.score_avg = total.scored ? total.scoreTotal / total.scored : null
  node.rating_avg = total.posts ? total.ratingTotal / total.posts : null
  node.scored_ratio = total.posts ? total.scored / total.posts : null
  return total
}

/**
 * "这个路径得是个存在的目录" —— 两条错误照抄 Python 侧（`exists()` → 404、
 * `is_dir()` → 400），GET 和 DELETE 共用。
 *
 * 少了它们，一个没挂上或被挪走的库根会让 `readdirSync` 抛 ENOENT 冒成 500，响应体
 * 既不是 `{detail, error}` 也不是 `{status_code, detail}` —— 前端两种都不认。
 *
 * 一次 `statSync` 而不是 `existsSync` + `statSync`：后者是两次系统调用，而且
 * "先问在不在、再问是什么"本来就有竞态。`label` 是给用户看的那半边路径。
 *
 * ⚠️ `throwIfNoEntry: false` 只吞 ENOENT。EINVAL（Windows 上路径里带 `<>"|` 这类
 * 非法字符）、ENOTDIR（POSIX 上路径穿过一个文件）、EACCES 照样抛 —— 而被换掉的
 * `existsSync` 对这些一律返回 false。stat 不出来就是"没有这个目录"，所以任何
 * 失败都归到 404，别让它们冒成上面说的那种裸 500。
 */
function requireDirectory(abs: string, label: string): Response | null {
  let st: fs.Stats | undefined
  try {
    st = fs.statSync(abs, { throwIfNoEntry: false })
  }
  catch {
    st = undefined
  }
  if (!st)
    return domainError(`Directory not found: ${label}`, 'DirectoryNotFoundError', 404)
  if (!st.isDirectory())
    return domainError(`Not a directory: ${label}`, 'PathNotADirectoryError', 400)
  return null
}

export const foldersRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

foldersRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/folders',
    operationId: 'v2GetFolders',
    summary: 'GetFolders',
    responses: {
      200: { description: OK, content: { 'application/json': { schema: DirectorySummarySchema } } },
    },
  }),
  async (c) => {
    const base = targetDir()
    // `as never`：这两条错误不在 `responses` 里声明（baseline 的 GET /v2/folders 只有
    // 200，声明进去 `contract:diff` 就会报），但错误体照样要发出去。
    const bad = requireDirectory(base, base)
    if (bad)
      return bad as never

    // 先遍历（异步、逐目录让出）再聚合（better-sqlite3 是同步的，没有并行的余地）。
    // 两个并发请求各自建自己的 `next`，都是完整且经 mtime 校验过的树，谁后完成谁
    // 落盘，互相覆盖也不会留下半张表。
    const next = new Map<string, DirCacheEntry>()
    const summary = await walk(base, base, next)
    dirCache = next
    attachStats(summary, folderScoreAggregates(getDb().sqlite))
    return c.json(summary)
  },
)

/**
 * 删一个库目录：它的 post（DB + 文件 + 缩略图）以及整棵目录树。
 *
 * 拒绝库根、拒绝解析后落在库外的、拒绝 `.pictoria`。DB 行走
 * `deleteManyReturningPaths`，于是外键级联、手工的 vec0 级联和逐文件 unlink 都照常；
 * 剩下的树（非图片文件、空目录）再从磁盘上删掉。磁盘那一步部分失败也不要紧 ——
 * 下一次 sync 会把幸存下来的重新导入，两种情况下都不会留下孤儿 DB 行。
 *
 * 路由用 `:folder_path{.+}` 而不是 `createRoute` 生成的 `:folder_path` —— 目录名
 * 里有斜杠，普通参数不吃斜杠（和 images 那两条同一个理由）。
 */
foldersRoutes.openAPIRegistry.registerPath({
  method: 'delete',
  path: '/v2/folders/{folder_path}',
  tags: ['Commands', 'Folder'],
  operationId: 'v2DeleteFolder',
  summary: 'DeleteFolder',
  description: 'Delete a library folder: its posts (DB + files + thumbnails) and the dir tree.\n\nRefuses the library root and anything resolving outside the library\n(or into ``.pictoria``). DB rows go through ``PostRepo.delete_many`` so\nthe FK cascade, the manual vec0 cascade and the per-file unlink all\napply; the remaining tree (non-image files, empty dirs) is then removed\nfrom disk. If the disk removal partially fails, the next sync re-imports\nwhatever survived — no orphaned DB rows either way.',
  request: {
    params: z.object({
      folder_path: z.string().openapi({ param: { name: 'folder_path', in: 'path', required: true } }),
    }),
  },
  responses: {
    200: { description: OK, content: { 'application/json': { schema: Result } } },
    ...RESP_400,
  },
})

/**
 * `DELETE /v2/folders/` —— 空目录名。
 *
 * Litestar 的路由是 `{folder_path:path}`，`path` 参数至少要一个字符，所以带斜杠但
 * 后面什么都没有的请求根本匹配不上；`/v2/folders` 上只有 GET，于是它答 405。
 * Hono 默认会给 404（这个**路径**没有任何路由），所以这一条要手工补上，否则
 * 同一个请求两边一个 404 一个 405。
 *
 * `/v2/folders/.` 走的也是这里：fetch 客户端在发出前就把 `/.` 归一成了 `/`。
 */
foldersRoutes.delete('/v2/folders/', () => httpError(405, 'Method Not Allowed', { allow: 'GET, OPTIONS' }))

foldersRoutes.delete('/v2/folders/:folder_path{.+}', (c) => {
  const folder = (c.req.param('folder_path') ?? '').replace(/^\/+|\/+$/g, '')
  const base = targetDir()
  const target = path.resolve(base, folder)

  if (!folder || folder === '.' || folder === '@' || target === base || !isInside(target, base) || isInside(target, pictoriaDir()))
    return domainError(`Refusing to delete: '${folder}' is not a library folder.`, 'PathNotADirectoryError', 400)
  const bad = requireDirectory(target, folder)
  if (bad)
    return bad

  const { sqlite } = getDb()
  const ids = listIdsInFolder(sqlite, folder)
  deletePostFiles(sqlite, ids)

  // 缩略图是尽力而为；主树失败要抛出去，好让一个被锁住的文件显示成 500 而不是
  // 悄悄活下来。
  fs.rmSync(path.resolve(thumbnailsDir(), folder), { recursive: true, force: true })
  fs.rmSync(target, { recursive: true })
  return c.json({ msg: `Deleted folder ${folder} (${ids.length} posts)` })
})
