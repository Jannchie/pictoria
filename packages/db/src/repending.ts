/**
 * 「老 post 重新变成待办」的通知 —— 由**写它的 repository 函数自己**发出。
 *
 * 待办扫描带水位线（`repositories/backfill.ts` 的 `scanFloor`）：每条循环记着一个
 * "这个 id 以下已经确认没有待办"的下界，只从那儿往后扫。新 post 天然在水位线之上，
 * 但有一类写操作会让 id 在水位线**以下**的老 post 重新变成待办：
 *
 * * 手工摘掉一张图最后一个 `is_auto = 1` 标签（删 tag 走 FK 级联也算）→ tagger；
 * * tagger 产出的标签全被手工标签遮住、又没有拉黑（单张重打标）→ tagger；
 * * 把 `sha256` / `arthash` / `dominant_color` 清回空值（旋转写回 `arthash = NULL`）→ basics；
 * * 清空 `post_process_failures` 黑名单、删掉某个 scorer 的分数行 → 对应的 worker。
 *
 * 水位线不会自己退回去，所以每一条这样的写都必须让对应的循环下一轮**强制重扫**。漏掉
 * 一条的表现是**完全静默的**：没有异常、没有日志，那张图就是永远不再被 backfill 碰。
 *
 * 原来这件事靠路由在写完之后记得调 `wakeAllBackfills()` —— 调用点散在四个路由文件里，
 * 而"这次写会不会制造待办"是 SQL 层的知识（哪一列、哪个条件），路由只能猜，于是要么
 * 漏、要么一律叫醒全部循环（一次 tagger 全扫在真实库上是 1.8 秒的同步阻塞）。现在写函数
 * 自己判断、自己喊，调度器（`apps/api/src/scheduler.ts`）订阅这个信号，只叫醒被点名的
 * 那几条循环。新加这类写点时，规则是：**在 repository 函数里**调 `notifyRepending`，
 * 并在 `repending.test.ts` 里给它补一条断言。
 *
 * 按**连接**登记（`WeakMap`），和水位线同一个理由：水位线本身就是按连接存的，一条连接
 * 上的写只可能让**那条连接**的水位线过期。测试、脚本开的别的连接不会误叫醒生产循环。
 *
 * 同步派发。监听器（循环的 `wake()`）只是立一个旗、resolve 一个 sleep，真正的重扫发生
 * 在之后的事件循环轮次里 —— 所以在事务**里面**喊也安全；事务回滚的话只是多扫一轮。
 */
import type { SqliteHandle } from './connection.js'
import type { BackfillWorker } from './workers.js'

export type RependingListener = (workers: readonly BackfillWorker[]) => void

const listeners = new WeakMap<SqliteHandle, Set<RependingListener>>()

/** 订阅这条连接上的重新待办信号，返回取消订阅的函数。 */
export function onRepending(sqlite: SqliteHandle, listener: RependingListener): () => void {
  let set = listeners.get(sqlite)
  if (!set) {
    set = new Set()
    listeners.set(sqlite, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

/** 宣布这些 worker 在这条连接上有老 post 重新变成了待办。不传 worker 是空操作。 */
export function notifyRepending(sqlite: SqliteHandle, ...workers: BackfillWorker[]): void {
  if (!workers.length)
    return
  const set = listeners.get(sqlite)
  if (!set)
    return
  // 拷一份再派发：监听器里取消订阅不该打乱这一轮的遍历。
  for (const listener of [...set]) listener(workers)
}
