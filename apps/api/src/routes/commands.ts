/**
 * `/v2/cmd/*` —— 命令式端点：它们不是资源的 CRUD，而是"去做一件事"。
 *
 * 这一组是迁移里最后动的，因为每一个背后都拴着一段 Python 计算。走到这里的前提是
 * cairnq 已经把计算和落库分开（§D1）：端点只负责挑活、提交、把结果写回，具体算什么
 * 在 Python worker 那边。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { DEDUP_THRESHOLD, isRebuilding, rebuildGroups } from '../dedup.js'
import { getDb } from '../db.js'
import { RESP_400, zodErrorHook } from '../openapi.js'
import { Result } from '../schemas.js'
import { getTasks } from '../tasks.js'

export const commandsRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

commandsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/cmd/group-duplicates',
    operationId: 'v2GroupDuplicates',
    summary: 'GroupDuplicates',
    description: 'Rebuild near-duplicate groups (posts.canonical_post_id) from SigLIP2 similarity.',
    request: {
      query: z.object({
        threshold: z.coerce.number().nullable().optional()
          .openapi({ param: { name: 'threshold', in: 'query', required: false }, type: ['number', 'null'] }),
      }),
    },
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: Result } } },
      ...RESP_400,
    },
  }),
  async (c) => {
    const { threshold } = c.req.valid('query')
    // ⚠️ 必须在忙检查**之前** await。检查和启动之间夹一个 await，两个几乎同时到达
    // 的请求就会双双通过检查，然后排成两次全量重算 —— 一次分钟级的 GPU 白烧。
    // 先把这个 await 做掉，检查和启动就都落在同一个同步片段里。
    const tasks = await getTasks()

    // 忙就报忙，不排队（和 Python 侧 `rebuild_lock.locked()` 同款判断）。
    if (isRebuilding())
      return c.json({ msg: 'Near-duplicate grouping already running' }, 201)

    const opts = threshold == null ? {} : { threshold }
    // fire-and-forget：请求立刻返回，结果打进日志。失败在这里吞掉并记下 ——
    // 没有人在等这个 promise，未处理的 rejection 会让整个进程退出。
    void rebuildGroups(getDb().sqlite, tasks, opts)
      .catch((err: unknown) => console.warn(`[dedup] 重建失败：${String(err)}`))

    const thr = threshold ?? DEDUP_THRESHOLD
    return c.json({ msg: `Near-duplicate grouping started (threshold=${thr}).` }, 201)
  },
)
