/**
 * `/v2/folders` —— 目录树的读取与删除。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRoute, z } from '@hono/zod-openapi'
import { listIdsInFolder, SCORERS, type AestheticScorer } from '@pictoria/db'
import { newRoutes, openapiCatchAll } from '../env.js'
import { avgField, type DirectorySummary } from '../folder-tree.js'
import { isInside, pictoriaDir, realPathOrResolved, targetDir, thumbnailPathFor } from '../paths.js'
import { deletePostFiles } from '../post-files.js'
import { OK, errors, fail } from '../openapi.js'
import { Result } from '../schemas.js'

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
