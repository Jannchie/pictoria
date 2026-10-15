/**
 * 待办扫描水位线的存储 —— 「这个 id 以下已经确认没有待办了」，按**连接**、按**循环**存。
 *
 * 水位线是什么、按什么规则推进，见 `repositories/backfill.ts` 的 `scanFloor` 注释；这里
 * 只放存取。单独成一个模块是因为有两方要写它：扫描本身（`backfill.ts`，推进）和重新待办
 * 的信号（`repending.ts`，退回）—— 两者互相 import 会成环。
 */
import type BetterSqlite3 from 'better-sqlite3'
import type { BackfillWorker } from './workers.js'

const floors = new WeakMap<BetterSqlite3.Database, Map<BackfillWorker, number>>()

/** 这一轮该从哪个 id 开始扫。`force` 除了返回 0 还要把旧水位删掉，否则下一轮又被推回去。 */
export function readFloor(sqlite: BetterSqlite3.Database, key: BackfillWorker, force: boolean): number {
  if (force) {
    floors.get(sqlite)?.delete(key)
    return 0
  }
  return floors.get(sqlite)?.get(key) ?? 0
}

/** 记下这一轮证明出来的新水位。`floor` 由调用方按 `scanFloor` 那两条规则算好。 */
export function writeFloor(sqlite: BetterSqlite3.Database, key: BackfillWorker, floor: number): void {
  let per = floors.get(sqlite)
  if (!per) {
    per = new Map()
    floors.set(sqlite, per)
  }
  per.set(key, floor)
}

/**
 * 把水位线退回到 `id`（已经更低就不动）。`id` 以下的待办不变式不受影响：只有 `id`
 * 及以上的那段要重新判定，而下一次扫描正是从这里开始。还没有水位线（从没扫过）时
 * 本来就从 0 扫，什么都不用做。
 */
export function lowerFloor(sqlite: BetterSqlite3.Database, key: BackfillWorker, id: number): void {
  const per = floors.get(sqlite)
  const floor = per?.get(key)
  if (per && floor !== undefined && id < floor)
    per.set(key, id)
}

/** 清掉这条连接上全部水位线 —— 只给测试用。 */
export function resetFloors(sqlite: BetterSqlite3.Database): void {
  floors.delete(sqlite)
}
