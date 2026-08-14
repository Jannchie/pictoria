/**
 * cairnq 客户端句柄。
 *
 * **`tasks.sqlite` 是独立文件，不和图库共用**（§4.3）。SQLite 一次只允许一个写者，
 * 而 cairnq 的租约续约和心跳是高频小写 —— 正好是那种会挡在图库正常写前面、让它
 * 排队的流量。分文件之后两者各写各的。
 *
 * ## key 与 conflict 的用法（cairnq ≥ 0.7）
 *
 * 0.7 起 reuse 是状态感知的：`'reuse'` 只复用**还在跑**的任务，终态一律重新提交
 * （失败的 key 不再永久 500，成功的不再返还陈旧结果）；`'reuse-succeeded'` 额外把
 * succeeded 当缓存复用 —— 只给**输入完整编码在 key 里**的任务用（文本 embedding 的
 * key 就是 prompt；backfill 批次 key 列出全部成员 id，见 `scheduler.ts` 的
 * `batchKey`），对后者它是超时恢复：算完但 `call` 已超时返回的批次，下一轮直接
 * 捡回结果而不是重算。复用决策在 store 侧原子完成，无 check-then-submit 竞态。
 * 0.6 时代这些语义要靠本文件的 `callKeyed` 手工绕（getByKey + 进程内合流），
 * 反馈给上游后在 0.7 落地，绕行已删（`docs/cairnq-feedback.md` §1-2）。
 *
 * 不需要幂等的路径就**别传 key**（`routes/images.ts` 的缩略图、`dedup.ts` 的矩阵
 * 都是这么做的，各自的注释有原因）。
 */
import { CairnQ } from 'cairnq'
import { tasksDbPath } from './paths.js'

/**
 * 终态任务保留 24 小时。
 *
 * cairnq 不自动删行（文档原话：不配 retention 就是永远累积），而这个队列扛的全是
 * 大 payload —— silva 每任务约 384 KB × 2 个 scorer、每批 embedding 的结果、每个
 * 搜索 prompt。24 小时足够事后翻失败任务的错误信息。内置 sweeper 先睡满一个
 * interval（默认 1h）再扫，天不会在启动高峰期扫（上游有意如此）。
 */
const RETENTION_MS = 24 * 3_600_000

let handle: CairnQ | null = null

export async function getTasks(): Promise<CairnQ> {
  if (!handle) {
    // retention 随句柄启停：谁打开队列谁维护它。挂在 index.ts 的调度开关下不行：
    // PICTORIA_SCHEDULER=0 的进程照样通过交互端点往 tasks.sqlite 塞大 payload。
    handle = CairnQ.sqlite(tasksDbPath(), { retention: { olderThanMs: RETENTION_MS } })
    await handle.connect()
  }
  return handle
}

export async function closeTasks(): Promise<void> {
  await handle?.close()
  handle = null
}
