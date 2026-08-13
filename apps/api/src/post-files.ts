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
import path from 'node:path'
import { deleteManyReturningPaths } from '@pictoria/db'
import { targetDir, thumbnailsDir } from './paths.js'

type SqliteHandle = Parameters<typeof deleteManyReturningPaths>[0]

/**
 * 删掉这些 post 的行、原图和缩略图，返回被删的相对路径。
 *
 * unlink 是尽力而为（`force: true`）—— 走到这条路径最常见的原因本来就是文件已经
 * 没了。行先删，删完才动盘：反过来会在中途失败时留下指向空文件的行。
 */
export function deletePostFiles(sqlite: SqliteHandle, ids: number[]): string[] {
  const base = targetDir()
  const thumbs = thumbnailsDir()
  const removed = deleteManyReturningPaths(sqlite, ids)
  for (const rel of removed) {
    fs.rmSync(path.resolve(base, rel), { force: true })
    fs.rmSync(path.resolve(thumbs, rel), { force: true })
  }
  return removed
}
