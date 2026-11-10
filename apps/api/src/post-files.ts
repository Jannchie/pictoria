/**
 * 删 post 时连带删盘上的文件。
 *
 * 这件事有三个入口（`/v2/posts` 批量删、`/v2/folders` 删整个目录、sync 对账发现
 * 文件没了），三处此前各写一遍同样的循环 —— 于是"缩略图在哪"这个知识被复制了三份，
 * 改一次布局要改三个文件，漏掉的那一份表现是留下一地孤儿缩略图，不报错。
 *
 * 形状承自已删除的 `services/file_management.py`。
 */
import fs from 'node:fs'
import { DELETE_CHUNK, deleteManyReturningPaths, type SqliteHandle } from '@pictoria/db'
import { yieldToEventLoop } from './event-loop.js'
import { postAbsPath, thumbnailPathFor } from './paths.js'

/**
 * 删掉这些 post 的行、原图和缩略图，返回被删的相对路径。
 *
 * 按 `DELETE_CHUNK`（与 `deleteManyReturningPaths` 内部同一个常量，于是每次调用恰好
 * 一个事务）分块，块与块之间让出一次事件循环 —— 删一个大目录是几万个 post，一次同步
 * 删完会让整个 API 停摆到删完为止。每块先删行（一个事务），再异步删这一块的文件。
 * 中途失败时已完成的块已经提交、文件也删了，剩下的块原封不动 —— 不会出现"行删了
 * 一半"的块。
 *
 * unlink 是尽力而为（`force: true`）—— 走到这条路径最常见的原因本来就是文件已经
 * 没了。删不掉的（Windows 上被占用的 EBUSY/EPERM）记一条警告、不让整批失败：行已经
 * 删了，留在盘上的原图下一次 sync 会重新导入，不会有孤儿行。行先删，删完才动盘：
 * 反过来会在中途失败时留下指向空文件的行。
 *
 * `unlink: false` 只删行（分块、让出照旧）：删整个目录时调用方随后递归删掉原图树和
 * 缩略图树，逐个 rm 就是把同一批文件删两遍。
 */
export async function deletePostFiles(
  sqlite: SqliteHandle,
  ids: number[],
  { unlink = true }: { unlink?: boolean } = {},
): Promise<string[]> {
  const removed: string[] = []
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    if (i > 0)
      await yieldToEventLoop()
    const rels = deleteManyReturningPaths(sqlite, ids.slice(i, i + DELETE_CHUNK))
    removed.push(...rels)
    if (!unlink)
      continue
    const paths = rels.flatMap(rel => [postAbsPath(rel), thumbnailPathFor(rel)])
    const results = await Promise.allSettled(paths.map(p => fs.promises.rm(p, { force: true })))
    const failed = results.flatMap((r, j) => (r.status === 'rejected' ? [`${paths[j]}: ${String(r.reason)}`] : []))
    if (failed.length)
      console.warn(`[pictoria-api] ${failed.length} 个文件没删掉（行已删除；留下的原图下次 sync 会重新导入）：\n${failed.slice(0, 5).join('\n')}`)
  }
  return removed
}
