/** `/v2/queues/status` —— 后台队列的完成情况、速度与剩余时间，给侧栏的同步状态区。 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { CPU_QUEUE, GPU_QUEUE, INTERACTIVE_QUEUE, IO_QUEUE } from '@pictoria/contracts'
import { OK, zodErrorHook } from '../openapi.js'
import { schedulerStatus } from '../queue-status.js'
import { peekTasks } from '../tasks.js'

const LoopStatus = z
  .object({
    key: z.string().openapi({ description: '循环名：`basics` / `silva` / `silva_luna` / `waifu` / `tagger` / `embedding`。' }),
    queue: z.string(),
    state: z.enum(['idle', 'working', 'error']),
    remaining: z.int().nullable().openapi({ description: '还剩多少条；`null` = 还没数出来（第一遍计数在后台进行中）。两次精确计数之间是估计值。' }),
    processed: z.int().openapi({ description: '进程启动以来落库的条数。' }),
    failed: z.int().openapi({ description: '进程启动以来被拉黑的条数。' }),
    sessionDone: z.int().openapi({ description: '这一段忙碌期已完成的条数（进度条的分子）。' }),
    ratePerSecond: z.number().nullable(),
    etaSeconds: z.int().nullable(),
    batchStartedAt: z.int().nullable().openapi({ description: 'epoch ms' }),
    lastBatchAt: z.int().nullable().openapi({ description: 'epoch ms' }),
    lastError: z.string().nullable(),
  })
  .openapi('QueueLoopStatus')

const QueueDepth = z
  .object({
    name: z.string(),
    queued: z.int(),
    running: z.int(),
  })
  .openapi('QueueDepth')

const QueuesStatus = z
  .object({
    scheduler: z.object({
      running: z.boolean(),
      error: z.string().nullable().openapi({ description: '调度器启动失败时的错误；正常为 `null`。' }),
    }),
    loops: z.array(LoopStatus),
    queues: z.array(QueueDepth).openapi({ description: 'cairnq 各队列此刻排队 / 运行中的任务数；任务库还没连上时为空。' }),
  })
  .openapi('QueuesStatus')

/** 显示顺序：批处理的 GPU 队列、交互式 GPU 队列、IO、CPU。 */
const QUEUE_NAMES = [GPU_QUEUE, INTERACTIVE_QUEUE, IO_QUEUE, CPU_QUEUE] as const

export const queuesRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

queuesRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/queues/status',
    operationId: 'v2GetQueuesStatus',
    summary: 'GetQueuesStatus',
    description: 'Per-backfill progress (remaining, rate, ETA) plus queued/running counts of each cairnq queue.',
    responses: {
      200: { description: OK, content: { 'application/json': { schema: QueuesStatus } } },
    },
  }),
  async (c) => {
    const { running, error, loops } = schedulerStatus()
    const tasks = peekTasks()
    // 按队列问，不问整张表：不带参数的 `stats()` 要把 retention 留着的全部终态行
    // （succeeded 1 小时、failed 24 小时）聚合一遍，而带队列名的走 (queue, status) 索引前缀。
    const queues = tasks
      ? await Promise.all(QUEUE_NAMES.map(async (name) => {
          const byStatus = (await tasks.stats(name))[name]
          return { name, queued: byStatus?.queued ?? 0, running: byStatus?.running ?? 0 }
        }))
      : []
    return c.json({ scheduler: { running, error }, loops, queues }, 200)
  },
)
