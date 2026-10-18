/**
 * `listImportedDanbooruIds`：判据是"有手工标签"，每个 id 只出现一次。
 *
 * 一次性的回归：它曾经是 JOIN，每个手工标签各出一行，一张三十来个标签的图在 id 列表里
 * 出现三十多次。
 */
import { describe, expect, it } from 'vitest'
import { createTestDb } from '../testing.js'
import { ensureCanonicalTagGroups } from './backfill.js'
import { listImportedDanbooruIds, persistPostsWithTags } from './import-persist.js'

function row(fileName: string, tags: Record<string, number>, filePath = 'danbooru/x') {
  return { filePath, fileName, extension: 'jpg', source: '', rating: 0, publishedAt: null, tags }
}

describe('listImportedDanbooruIds', () => {
  it('多个手工标签的 post 只出现一次；无标签、只有自动标签、别的目录的都不算', () => {
    const sqlite = createTestDb()
    // tags.group_id 有 FK，得是真的组。
    const g = Object.values(ensureCanonicalTagGroups(sqlite))[0]!
    persistPostsWithTags(sqlite, [
      row('100', { a: g, b: g, c: g }),
      row('101', { a: g }),
      row('102', {}),
      row('103', { d: g }),
      row('200', { a: g }, 'danbooru/y'),
    ])
    // 103 的标签改成自动标签：它不算"已导入"。
    sqlite.prepare(
      'UPDATE post_has_tag SET is_auto = 1 WHERE post_id = (SELECT id FROM posts WHERE file_name = ?)',
    ).run('103')

    expect(listImportedDanbooruIds(sqlite, 'danbooru/x').sort()).toEqual(['100', '101'])
    sqlite.close()
  })
})
