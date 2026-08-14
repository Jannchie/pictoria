# cairnq 上游反馈

Pictoria 是 cairnq 的重度双语言用户（TS 提交 + Python worker，六条 GPU/IO 队列）。
以下问题都在生产库上真实踩到过，按严重程度排序；每条附本仓库的绕行实现，可作为
上游修复的行为参照。

## 1. `conflict: 'reuse'` 不检查任务状态

`store/base.js` 的 reuse 分支是 `if (conflict === "reuse") return rowToTask(current)` ——
不看 `current` 的状态。后果：

* key 命中一个**终态失败**的任务时，`call()` 原样重抛它的 `TaskFailed`。没人调
  `purge()` 的话 key 行永远留在库里，**重启也不清** —— 这个 key 从此永久失败。
  我们的 backfill 循环 key 由待办集算出，一批失败后下一轮算出同一个 key，整条
  循环就此卡死。
* key 命中一个**成功**的任务时，拿回的是陈旧结果。图片被旋转后再请求打标，
  返回的是旋转前的标签。

**建议**：reuse 只匹配非终态任务（或提供 `conflict: 'reuse-running'` /
`reuseTerminal: boolean` 让调用方显式选择）。终态任务的复用应该是 opt-in，
因为它只对「key 完整编码了输入」的任务才是安全的。

绕行：`apps/api/src/tasks.ts` 的 `callKeyed` —— 先 `getByKey` 看一眼状态，
终态选 `replace`，在跑选 `reuse`，另配 `reuseSucceeded` 开关给内容寻址的 key。

## 2. check-then-submit 竞态下 `replace` 会互相 cancel

因为 (1) 需要先查状态再选 conflict，检查和提交之间隔着 await。两个并发的同 key
调用会双双看到同一个终态任务、双双选 `replace`，而 replace 会把**对方刚建出来**
的新任务 cancel 掉（`store/base.js` 的 `fetch("cancel", ...)`）：一边收到
`TaskCanceled`，外加一次白烧的 GPU —— 恰好发生在 key 本该防住的双击场景上。

**建议**：如果 (1) 落地为状态感知的 reuse，这个竞态自然消失（不再需要两步）。
否则提供原子的 compare-and-swap 语义（「仅当当前任务仍是我看到的那个终态任务时
才替换」）。

绕行：`callKeyed` 在进程内按 key 合流在途调用（`inFlightByKey`）。单提交进程
够用，多提交进程就不够了。

## 3. `waitTimeoutMs` 超时后没有重新挂接结果的路径

`pollWait` 的文档说清了 `waitTimeoutMs` 只是不再等、任务照常跑完 —— 这个语义
本身没问题。问题是超时之后**没有干净的办法拿回那个结果**：唯一的路径是
key + reuse，而那正好撞上 (1) 的所有坑。

**建议**：提供 `waitByKey(key, timeoutMs)` / `attach(taskId)` 之类的 API，
让「上一轮超时、这一轮想接着等或直接取结果」成为一等操作。

绕行：批次 key 完整列出成员 id + `reuseSucceeded`（`scheduler.ts` 的
`batchKey`），把「捡回超时批次的结果」伪装成一次复用。

## 4. 终态任务无保留策略，大 payload 无限累积

文档明确说 cairnq 不自动删任何行、长生命周期需要按计划调 `purge()`。但对大
payload 队列这几乎是必然被踩的坑：我们每个 silva 任务约 384 KB × 2 个 scorer，
一轮 22 万图的 backfill 留下几个 GB 的终态行。

**建议**：store 或 queue 级的保留配置（`retention: { olderThanMs, keep }`），
或至少在 README 的 quickstart 里把 purge 提到显眼处 —— 「不删任何东西」的
默认值配上大 payload 是静默的磁盘泄漏。

绕行：`tasks.ts` 的 `startTaskPurge`（随句柄启动，每小时清 24 小时前的终态行，
分批 + 批间让出事件循环）。

## 5. 租约续约和 handler 共用一个事件循环（Python worker）

worker 在自己的事件循环上跑 handler，同一个循环负责续租约。一次几秒的**同步**
GPU forward 把循环挡住，租约过期，任务被判死并交给另一个 worker —— 而原来那个
还在算，同一批算两次。

**建议**：心跳/续约放到独立线程（或明确文档要求 handler 必须 async 且重活必须
`asyncio.to_thread`，最好在检测到事件循环被长时间阻塞时告警）。

绕行：所有 handler 都是 async，GPU 调用一律 `asyncio.to_thread`
（`docs/refactor-monorepo-hono.md` waifu 一节，2026-08-10）。

---

相关代码位置（行为参照）：

| 主题 | 位置 |
|---|---|
| 状态感知 reuse + 进程内合流 | `apps/api/src/tasks.ts` `callKeyed`（含 9 条单测 `tasks.test.ts`） |
| 内容寻址批次 key | `apps/api/src/scheduler.ts` `batchKey` |
| 定期 purge | `apps/api/src/tasks.ts` `startTaskPurge` |
| 超时不停任务的文件占用后果 | `apps/api/src/dedup.ts`（Windows EBUSY，per-run 文件名 + 回收） |

## 6. `pollWait` 每拍 `select *` + 全量 JSON.parse

`wait.js` 的轮询路径每拍调 `store.get`（`select *`）并对 payload/result/error
全量 `JSON.parse`（`models.js` 的 `rowToTask`）——但任务未终态时只需要 `status`
一列。等待一个 395 KB payload 的任务时，每秒重复读取+解析 ~0.79 MB；排队 5 分钟
≈ 230 MB 的重复 parse，且在 better-sqlite3 上是同步的，直接占调用方事件循环。

**建议**：轮询用 status-only 查询，终态才取整行。

## 7. `client.call` 不透传轮询上限

`client.js` 的 `call` 不透传 `maxPollMs`，退避封顶写死 500 ms。对秒级冷启动的
任务（首次载模型），最后一拍平均晚 ~250 ms 才发现完成。

**建议**：`CallOptions` 暴露 `maxPollMs`（或让 `pollMs` 同时约束封顶）。

## 8. `purge` 无 per-status / per-name 保留策略

`purge({ olderThanMs, limit })` 是唯一的粒度。实际需求是分层的：succeeded 行在
结果被消费后只需要分钟级保留（去重/超时恢复窗口），failed 行才值得留 24 h 供
排查。现在只能一刀切，大 payload 队列在全量回填日会滞留数 GB 的 succeeded 行。

**建议**：`purge({ olderThanMs, status?, name?, limit })`，或 store 级
`retention: { succeeded: ms, failed: ms }`。
