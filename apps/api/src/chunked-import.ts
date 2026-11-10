/**
 * 导入器共用的分块循环：Danbooru 导入（`danbooru-imports.ts`）和 URL 导入
 * （`routes/commands.ts`）都是"把一长串待下载项切块，一块交给 worker 下载，回来立刻落库"。
 *
 * 规矩只在这里写一次：
 *
 * * 块是**串行**的：同一次导入的两块并行不会更快（CDN 配额 / IO 队列是共享的），只会让
 *   IO 队列上的别的任务排更久。
 * * 每块回来**立刻**落库（落库在 `run` 里做）：一次性下完再落库时，任务在第 900 张
 *   超时就是 900 张已落盘、0 行带标签；分块后损失最多一块。
 * * 一块失败**不中断**整次导入：记一次失败、打一行日志，接着下一块。整块怎么记账
 *   （记成失败条数）由 `onError` 决定。
 */

/** 一块多少项。按 ~1 req/s 约一分钟落一次库。两个导入器共用。 */
export const IMPORT_CHUNK_SIZE = 50

export interface ChunkedRunOptions<T> {
  /** 日志前缀，例如 `[url-import] https://…`。 */
  label: string
  /** 下载并落库一块。抛错 = 这块失败。 */
  run: (chunk: T[]) => Promise<void>
  /** 这块失败了：调用方记账（通常是 `failed += chunk.length`）。 */
  onError?: (chunk: T[], err: unknown) => void
  /** 每块结束后（无论成败）调用 —— 进度计数用。 */
  after?: (chunk: T[]) => void
}

export interface ChunkedRunResult {
  /** 失败的块数。 */
  failedChunks: number
  /** 最后一块失败的错误；没有失败时为 `undefined`。 */
  lastError: unknown
}

export async function runInChunks<T>(
  items: readonly T[],
  chunkSize: number,
  { label, run, onError, after }: ChunkedRunOptions<T>,
): Promise<ChunkedRunResult> {
  const size = Math.max(1, chunkSize)
  let failedChunks = 0
  let lastError: unknown
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size)
    try {
      await run(chunk)
    }
    catch (err) {
      failedChunks += 1
      lastError = err
      onError?.(chunk, err)
      console.warn(`${label} 第 ${i / size + 1} 块失败：${String(err)}`)
    }
    after?.(chunk)
  }
  return { failedChunks, lastError }
}
