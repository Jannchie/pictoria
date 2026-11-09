/**
 * 不让长活占住事件循环的两件小工具。API 是单进程单线程，better-sqlite3 又是同步的：
 * 任何一段几百毫秒的 JS / SQL 都会让前端的每个请求一起排队。
 */

/** 让出一次事件循环，让排队的 I/O（HTTP 请求）先跑。长循环每隔一段 await 一次。 */
export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * 把一串请求合并成"冷却期满后跑一次"。`WorkerSpec.drainCooldownMs` 和 sync 的文件监视用它。
 *
 * 跑着的时候来的请求不丢，记一笔，等这一轮**结束**再过 `cooldownMs` 补跑一次；冷却期内
 * 来多少次都只补一次。第一次请求（或冷却期早已过去时的请求）立即跑。`run` 的失败
 * 在这里吞掉 —— 调用方负责记日志，这里只保证一次失败不会让后面的请求再也跑不起来。
 */
export function coalesceWithCooldown(run: () => Promise<unknown>, cooldownMs: number): () => void {
  /**
   * 原来是 `running` / `pending` / `timer` 三个变量，"跑着又挂着定时器""定时器到点了却
   * 没有请求"都表达得出来，只是碰巧走不到。三态各自只带自己用得上的东西：
   * - `idle`：没事；下一个请求按 `lastFinished` 算还要等多久（可能是 0）。
   * - `waiting`：有请求，等冷却期满 —— 冷却期内再来多少个都已经被它代表了。
   * - `running`：正在跑；`rerun` = 期间又来了请求，跑完要再排一次。
   */
  type State
    = | { kind: 'idle' }
      | { kind: 'waiting', timer: NodeJS.Timeout }
      | { kind: 'running', rerun: boolean }
  let state: State = { kind: 'idle' }
  let lastFinished = Number.NEGATIVE_INFINITY

  const wait = () => {
    const timer = setTimeout(fire, Math.max(0, lastFinished + cooldownMs - Date.now()))
    // 一个等着的补跑不该把进程钉住
    timer.unref?.()
    state = { kind: 'waiting', timer }
  }
  function fire() {
    const current: State = { kind: 'running', rerun: false }
    state = current
    void run().catch(() => {}).finally(() => {
      lastFinished = Date.now()
      state = { kind: 'idle' }
      if (current.rerun)
        wait()
    })
  }
  return () => {
    switch (state.kind) {
      case 'idle':
        wait()
        return
      case 'waiting':
        return
      case 'running':
        state.rerun = true
        return
      default: {
        const unknown: never = state
        return unknown
      }
    }
  }
}
