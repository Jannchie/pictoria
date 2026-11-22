/**
 * 待办扫描水位线的存储 —— 「这个 id 以下已经确认没有待办了」，按**连接**、按**循环**存。
 *
 * 水位线是什么、按什么规则推进，见 `repositories/backfill.ts` 的 `scanFloor` 注释；这里
 * 只放存取。单独成一个模块是因为有两方要写它：扫描本身（`backfill.ts`，推进）和重新待办
 * 的信号（`repending.ts`，退回）—— 两者互相 import 会成环。
 */
import type BetterSqlite3 from 'better-sqlite3'
import type { BackfillWorker } from './workers.js'

/**
 * 一条循环的水位线。`windowed`：上一次扫描只扫空了一个窗口、没碰到表尾（见
 * `repositories/backfill.ts` 的 `SCAN_WINDOW_ROWS`）—— 水位线落在窗口上界，但它之上还没判定过。
 */
interface Floor { floor: number, windowed: boolean }

const floors = new WeakMap<BetterSqlite3.Database, Map<BackfillWorker, Floor>>()

/** 这一轮该从哪个 id 开始扫。 */
export function readFloor(sqlite: BetterSqlite3.Database, key: BackfillWorker): number {
  return floors.get(sqlite)?.get(key)?.floor ?? 0
}

/** 记下这一轮证明出来的新水位。`floor` 由调用方按 `scanFloor` 那几条规则算好。 */
export function writeFloor(sqlite: BetterSqlite3.Database, key: BackfillWorker, floor: number, { windowed = false } = {}): void {
  let per = floors.get(sqlite)
  if (!per) {
    per = new Map()
    floors.set(sqlite, per)
  }
  per.set(key, { floor, windowed })
}

/**
 * 上一次扫描是否只扫空了一个窗口、表尾还没碰到。是的话"这一轮没有待办"**不**代表扫空了，
 * 调用方（`apps/api/src/scheduler.ts` 的 `runBatch`）应让出事件循环后立刻再扫。
 */
export function scanIncomplete(sqlite: BetterSqlite3.Database, key: BackfillWorker): boolean {
  return floors.get(sqlite)?.get(key)?.windowed ?? false
}

/**
 * 把水位线退回到 `id`（已经更低就不动）。`id` 以下的待办不变式不受影响：只有 `id`
 * 及以上的那段要重新判定，而下一次扫描正是从这里开始。还没有水位线（从没扫过）时
 * 本来就从 0 扫，什么都不用做。
 */
export function lowerFloor(sqlite: BetterSqlite3.Database, key: BackfillWorker, id: number): void {
  const entry = floors.get(sqlite)?.get(key)
  if (entry && id < entry.floor)
    entry.floor = id
}

/**
 * 把这条连接上**所有**循环的水位线清零。
 *
 * 生产路径不走这里 —— 那边是 `notifyRepending` 当场退水位。这个函数是给测试用的：水位线是**连接级**状态，而测试套件共用一条
 * 连接、每个用例之间只 `DELETE FROM` 清表，清不掉水位线。不在 `beforeEach` 里调它
 * 的话，前一个用例把水位推到 `MAX(id)+1` 会让后一个用例插进去的低 id 行整批看不见 ——
 * 表现是一堆"待办查询返回空"的失败，而查询本身没有任何问题。
 */
export function resetFloors(sqlite: BetterSqlite3.Database): void {
  floors.delete(sqlite)
}
