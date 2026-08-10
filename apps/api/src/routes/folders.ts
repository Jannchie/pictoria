/**
 * `/v2/folders` —— 只搬了读端点。
 *
 * `DELETE /v2/folders/{folder_path}` 会连带删磁盘文件、缩略图和 DB 行，仍然透传
 * 给 Litestar：破坏性写操作留到读路径全部稳定之后再搬（文档 §5 的"由读到写"）。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { addAgg, emptyAgg, folderScoreAggregates, type FolderScoreAgg } from '@pictoria/db'
import { getDb, repoRoot } from '../db.js'
import { OK, zodErrorHook } from '../openapi.js'

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
