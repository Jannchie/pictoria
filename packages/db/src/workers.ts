/**
 * backfill worker 的**身份** —— 名字和黑名单桶名的唯一定义处。
 *
 * 一个 worker 在三个地方要被叫出名字：调度循环（`apps/api/src/scheduler.ts`，也是
 * `/v2/queues/status` 里的 `key`）、待办扫描的水位线（`repositories/backfill.ts` 的
 * `scanFloor`）、失败黑名单 `post_process_failures.worker` 列。原来这三处各有一套拼法
 * （`silva` / `silva:silva` / `aesthetic:silva`），黑名单键还分散在 `@pictoria/contracts`
 * 的四个常量和一个 `aestheticWorkerKey()` 里 —— 加一个 worker 要记得同时改三份。
 *
 * 现在 `BackfillWorker` 就是名字本身，前两处直接用它；只有黑名单键因为**已经落在库里**
 * 不能改值，由 `failureKey()` 从名字推出来。
 */
import type { AestheticScorerName } from './scorers.js'
import { SCORERS } from './scorers.js'

/** 一条 backfill 循环的名字。silva 家族每个打分器一条，名字就是 scorer 名。 */
export type BackfillWorker = 'basics' | 'waifu' | 'tagger' | 'embedding' | AestheticScorerName

/**
 * 全部 backfill worker，**按启动顺序**（`index.ts` 照这个顺序起循环；`/v2/queues/status`
 * 的字段说明和启动日志也从这里取）。basics 排在最前：其余 worker 的输入（尺寸、
 * 缩略图）都由它产出。
 */
export const BACKFILL_WORKERS: readonly BackfillWorker[] = [
  'basics',
  ...SCORERS.map(s => s.name),
  'waifu',
  'tagger',
  'embedding',
]

/**
 * `post_process_failures.worker` 列里这个 worker 的桶名。
 *
 * ⚠️ 这些值已经写在真实库里了，**只能加不能改**：改一个字，那个 worker 的整个黑名单
 * 就静默失效（被拉黑的坏图全部回到待办，每一轮白解码一次）。embedding 带表名后缀、
 * silva 家族带 `aesthetic:` 前缀，都是 Python 时代留下的拼法。
 */
export function failureKey(worker: BackfillWorker): string {
  switch (worker) {
    case 'basics':
    case 'waifu':
    case 'tagger':
      return worker
    case 'embedding':
      return 'embedding:siglip2'
    default:
      return `aesthetic:${worker}`
  }
}
