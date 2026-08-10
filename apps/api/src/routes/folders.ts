/**
 * `/v2/folders` —— 目录树的读取与删除。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { addAgg, deleteManyReturningPaths, emptyAgg, folderScoreAggregates, listIdsInFolder, type FolderScoreAgg } from '@pictoria/db'
import { getDb, repoRoot } from '../db.js'
import { OK, RESP_400, zodErrorHook } from '../openapi.js'
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

function targetDir(): string {
  return path.resolve(repoRoot(), process.env.PICTORIA_TARGET_DIR ?? 'server/illustration/images')
}

/** 递归统计目录下的文件数，跳过 `.pictoria`。 */
function walk(absDir: string, base: string): DirectorySummary {
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

  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === '.pictoria')
      continue
    if (entry.isDirectory()) {
      const child = walk(path.join(absDir, entry.name), base)
      summary.children.push(child)
      summary.file_count += child.file_count
    }
    else {
      summary.file_count += 1
    }
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

/** `server/exceptions.py` 里 `DomainError` 统一的响应形状。 */
function domainError(detail: string, error: string, status: 400 | 404) {
  return new Response(JSON.stringify({ detail, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
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
  (c) => {
    const base = targetDir()
    // Python 侧把磁盘遍历和 DB 聚合并行跑；这里 better-sqlite3 是同步的，遍历也
    // 是同步的，并行没有意义 —— 顺序执行，语义完全一样。
    const summary = walk(base, base)
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

foldersRoutes.delete('/v2/folders/:folder_path{.+}', (c) => {
  const folder = (c.req.param('folder_path') ?? '').replace(/^\/+|\/+$/g, '')
  const base = path.resolve(targetDir())
  const target = path.resolve(base, folder)
  const pictoria = path.resolve(base, '.pictoria')
  const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep)

  if (!folder || folder === '.' || folder === '@' || target === base || !inside(target, base) || inside(target, pictoria))
    return domainError(`Refusing to delete: '${folder}' is not a library folder.`, 'PathNotADirectoryError', 400)
  if (!fs.existsSync(target))
    return domainError(`Directory not found: ${folder}`, 'DirectoryNotFoundError', 404)
  if (!fs.statSync(target).isDirectory())
    return domainError(`Not a directory: ${folder}`, 'PathNotADirectoryError', 400)

  const { sqlite } = getDb()
  const ids = listIdsInFolder(sqlite, folder)
  const removed = deleteManyReturningPaths(sqlite, ids)
  for (const rel of removed) {
    fs.rmSync(path.resolve(base, rel), { force: true })
    fs.rmSync(path.resolve(base, '.pictoria/thumbnails', rel), { force: true })
  }

  // 缩略图是尽力而为；主树失败要抛出去，好让一个被锁住的文件显示成 500 而不是
  // 悄悄活下来。
  fs.rmSync(path.resolve(base, '.pictoria/thumbnails', folder), { recursive: true, force: true })
  fs.rmSync(target, { recursive: true })
  return c.json({ msg: `Deleted folder ${folder} (${ids.length} posts)` })
})
