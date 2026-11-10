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
 * 水位线不会自己退回去，所以每一条这样的写都必须把对应循环的水位线退回去。漏掉
 * 一条的表现是**完全静默的**：没有异常、没有日志，那张图就是永远不再被 backfill 碰。
 *
 * 写函数知道是哪几张图时带上**最小的 id**（`fromId`）：信号当场把被点名循环的水位线
 * 退到那里（`scan-floor.ts` 的 `lowerFloor`），循环被叫醒后只从那张图起扫。说不清是
 * 哪几张时不带，水位线当场退到 0，被点名的循环下一轮从头重扫（按窗口分段，见
 * `backfill.ts` 的 `SCAN_WINDOW_ROWS`；能带 id 还是带上，省一遍全表判定）。
 *
 * 两种情况都是**在信号里同步**把水位线退好，监听器只负责叫醒。原来不带 id 的信号是
 * 一面 `force` 旗，从监听器经调度循环、`runBatch`、`WorkerSpec.listPending` 一路传到
 * `readFloor`，还要处理"这一批失败了旗子还不还回去"—— 退水位本来就是幂等的、当场生效
 * 的，那一整条传递链换来的只是推迟。
 *
 * **新建 post** 也走这条信号（`createPost` / `insertPostTriples` / `persistPostsWithTags`，
 * 点名全部 worker、带上新行的最小 id）：新行天然在水位线之上，退水位是空操作，信号只是
 * 把空转的循环叫醒，免得它们干等一轮 `IDLE_MS`。
 *
 * 原来这件事靠路由在写完之后记得调一个全局的"叫醒全部循环并强制重扫" —— 调用点散在
 * 四个路由文件里，而"这次写会不会制造待办"是 SQL 层的知识（哪一列、哪个条件），路由
 * 只能猜，于是要么漏、要么一律叫醒全部循环。现在写函数自己判断、自己喊，调度器
 * （`apps/api/src/scheduler.ts`）订阅这个信号，只叫醒被点名的那几条循环。新加这类写点
 * 时，规则是：**在 repository 函数里**调 `notifyRepending`，并在 `repending.test.ts` 里
 * 给它补一条断言。
 *
 * 按**连接**登记（`WeakMap`），和水位线同一个理由：水位线本身就是按连接存的，一条连接
 * 上的写只可能让**那条连接**的水位线过期。测试、脚本开的别的连接不会误叫醒生产循环。
 *
 * 同步派发。监听器（循环的 `wake()`）只是立一个旗、resolve 一个 sleep，真正的重扫发生
 * 在之后的事件循环轮次里 —— 所以在事务**里面**喊也安全；事务回滚的话只是多扫一轮。
 */
import type { SqliteHandle } from './connection.js'
import { lowerFloor } from './scan-floor.js'
import type { BackfillWorker } from './workers.js'

/** 被点名的循环。水位线在信号里已经退好了，监听器只需要叫醒它们。 */
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

/**
 * 宣布这些 worker 在这条连接上有 post 变成了待办。不点名是空操作。
 *
 * `fromId` 是其中最小的 post id：给了就当场把这几条循环的水位线退到它（见文件头），
 * 不给就退到 0（下一轮全扫）。
 */
export function notifyRepending(
  sqlite: SqliteHandle,
  workers: BackfillWorker | readonly BackfillWorker[],
  fromId?: number,
): void {
  const named: readonly BackfillWorker[] = typeof workers === 'string' ? [workers] : workers
  if (!named.length)
    return
  for (const w of named) lowerFloor(sqlite, w, fromId ?? 0)
  const set = listeners.get(sqlite)
  if (!set)
    return
  // 拷一份再派发：监听器里取消订阅不该打乱这一轮的遍历。
  for (const listener of [...set]) listener(named)
}
